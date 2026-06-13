---
title: "MySQL 向量检索实践：当数据库遇上 Embedding"
date: 2026-05-23
categories: [技术, MySQL]
tags: [MySQL, 向量检索, Embedding, RAG, 架构设计]
description: "MySQL 9 引入 VECTOR 类型后，「要不要为 RAG 单独养一个向量数据库」有了新答案。本文实测 MySQL 向量能力的边界，并给出一套务实的选型决策框架。"
---

做 RAG 的团队都绕不开一个选型问题：向量存哪？专用向量库（Milvus、Qdrant）功能强但要多养一套系统；MySQL 9 开始原生支持 `VECTOR` 类型后，「就用现有 MySQL」成了一个真实选项。这篇文章实测 MySQL 向量能力的边界，给出选型决策框架。

## MySQL 的向量能力现状

MySQL 9.x 提供了 `VECTOR(N)` 列类型和基础的距离函数。建表和写入：

```sql
CREATE TABLE doc_chunks (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  doc_id BIGINT NOT NULL,
  chunk_text TEXT NOT NULL,
  embedding VECTOR(1024) NOT NULL,
  tenant_id INT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  KEY idx_tenant_doc (tenant_id, doc_id)
) ENGINE=InnoDB;

INSERT INTO doc_chunks (doc_id, chunk_text, embedding, tenant_id)
VALUES (1, '...', STRING_TO_VECTOR('[0.0231, -0.114, ...]'), 42);
```

查询用距离函数排序：

```sql
SELECT id, chunk_text,
       DISTANCE(embedding, STRING_TO_VECTOR(?), 'COSINE') AS dist
FROM doc_chunks
WHERE tenant_id = 42
ORDER BY dist
LIMIT 10;
```

关键问题来了：**社区版 MySQL 的这条查询是全表暴力扫描**。每一行都要算一次 1024 维余弦距离，没有 ANN（近似最近邻）索引加持。HeatWave 版本有向量索引和加速，但那是云上付费能力。所以社区版 MySQL 做向量检索的真实边界，取决于暴力扫描扛到多大数据量。

## 实测：暴力扫描能扛多少

测试环境 8C16G，MySQL 9.3，1024 维 float 向量，单表测试 cosine 距离 + LIMIT 10：

| 行数 | 无过滤条件 | tenant 过滤后剩 5% |
|--------|-----------|------------------|
| 10 万 | ~180ms | ~15ms |
| 50 万 | ~900ms | ~55ms |
| 200 万 | ~3.8s | ~210ms |

两个结论。第一，裸扫 50 万行就接近交互式应用的容忍上限了。第二，**带过滤条件的场景表现完全不同**——只要二级索引能先把候选集裁到几万行，距离计算就只发生在小集合上，性能立刻回到可用区间。

这正好戳中专用向量库的软肋：预过滤（pre-filtering）。多租户 SaaS 场景下「只在租户 42 的文档里搜」，很多向量库的 ANN 索引做带过滤的检索反而别扭（filter 越严，HNSW 图遍历越容易断裂，召回率下降）。MySQL 用 B+ 树索引先过滤再暴力算距离，是「精确解」，没有召回损失。

![向量检索选型决策](/assets/images/2026/mysql-vector-decision.svg)

## 务实的混合架构

基于实测，我在生产中采用的判断标准：

**用 MySQL 的场景**：候选集经过业务条件过滤后在 10 万行以内；向量数据和业务数据强关联（要 JOIN 用户表、权限表）；团队没有专人运维新组件。典型如内部知识库、客服工单检索、中小规模 SaaS 的租户内搜索。

**上专用向量库的场景**：全局检索千万级以上向量；需要高 QPS（>500）低延迟（<50ms）的纯向量查询;需要标量量化、多向量、稀疏向量等高级能力。

很多团队的真实情况是第一种，却按第二种做了架构，平白多养一个有状态集群，还要解决 MySQL 与向量库之间的数据同步一致性——这往往才是最大的隐性成本。双写丢数据、CDC 链路延迟、删除不同步导致检索出已删内容，每一个都是真实事故来源。

## 几个落地细节

**维度越低越好，够用就行。** 1024 维和 256 维在很多业务召回评测上差距不到 2%，但存储和计算差 4 倍。新一代 embedding 模型普遍支持 Matryoshka 降维（截断前 N 维即可用），生产里我用 256 维起步，评测不达标再升。

**距离计算下推，不要捞回应用层算。** 见过把 embedding 全部 SELECT 回 Python 再算相似度的，网络传输比计算还慢。距离函数永远在 SQL 里执行。

**chunk 表要做冷热分离。** 文档更新会产生大量死 chunk，定期归档，控制参与扫描的行数——既然是暴力扫描，行数就是生命线。

**召回之后必须重排。** 向量检索只是粗筛，top 50 召回后用轻量 reranker（如 bge-reranker）精排到 top 5，端到端效果提升远大于把向量库换来换去。RAG 的瓶颈大概率不在检索引擎，而在 chunking 策略和重排。

## 容易被问到的三个问题

**「为什么不用 PostgreSQL + pgvector？」** pgvector 确实更成熟，有 HNSW 索引，社区版就能用，如果你的技术栈本来就是 PG，无脑选它。本文的前提是「存量系统是 MySQL」——为了向量检索把主数据库从 MySQL 迁到 PG，比引入一个向量库的动静还大。选型永远要带着存量约束讨论，脱离存量谈最优解是纸上谈兵。

**「暴力扫描的 CPU 占用会不会影响业务查询？」** 会，这是真实风险。距离计算是纯 CPU 密集操作，200 万行一次扫描能把一个核打满几秒。两个缓解手段：向量查询走只读副本，与交易流量物理隔离；用 `MAX_EXECUTION_TIME` hint 给向量查询设置超时上限，宁可检索降级也不拖垮副本。

**「embedding 模型升级了怎么办？」** 这是所有方案共同的痛：换模型意味着全量重算向量。MySQL 方案在这里反而有点优势——加一列 `embedding_v2 VECTOR(256)`，后台任务批量回填，灌完后切换查询列、删旧列，全程不停服，用的都是 DBA 最熟悉的在线变更套路，不需要学习向量库的 collection 迁移机制。设计 schema 时建议直接带上 `model_version` 字段，给未来的自己留路。

## 一段 Python 接入示例

```python
import aiomysql, numpy as np

async def search(pool, tenant_id: int, query_vec: np.ndarray, k: int = 10):
    vec_str = "[" + ",".join(f"{x:.6f}" for x in query_vec) + "]"
    async with pool.acquire() as conn:
        async with conn.cursor(aiomysql.DictCursor) as cur:
            await cur.execute("""
                SELECT id, chunk_text,
                       DISTANCE(embedding, STRING_TO_VECTOR(%s), 'COSINE') AS dist
                FROM doc_chunks
                WHERE tenant_id = %s
                ORDER BY dist LIMIT %s
            """, (vec_str, tenant_id, k))
            return await cur.fetchall()
```

注意向量序列化成字符串传参的开销在高 QPS 下不可忽略，可以预编译语句并复用连接；批量写入时一个事务攒 500~1000 行提交，吞吐能差一个数量级。

## 结语

我们最后的落地方案就是最朴素的那种：MySQL 存向量，只读副本跑检索，候选集靠租户过滤压到万级以内，top 50 召回后过一遍 reranker。上线三个月，没有为它新增任何组件，也没有为它起过一次夜。

MySQL 的向量能力不是用来对标 Milvus 的，它的价值是让一大批中等规模、强业务关联的场景不用引入新组件。等哪天数据量真长到这个方案撑不住，再迁也来得及——到那时业务也验证过了，迁移的钱花得不冤。
