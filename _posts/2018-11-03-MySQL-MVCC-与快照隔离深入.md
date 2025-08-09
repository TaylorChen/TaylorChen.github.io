---
title: "MySQL MVCC 与快照隔离深入"
date: 2018-11-03
categories: [技术, MySQL]
tags: [技术, MySQL, 事务, MVCC]
description: "系统拆解 InnoDB MVCC：undo/隐式列、Read View 可见性与二级索引回表一致性，附可复现实验、源码走读与排错/最佳实践清单。"
---

本文系统拆解 InnoDB MVCC 的实现细节：undo log、隐式列、Read View、可见性判断与二级索引回表的一致性，并给出可复现实验、源码走读与排错清单。

## 1. MVCC 结构
- 隐式列：`trx_id`（最近一次修改事务ID）、`roll_pointer`（回滚指针）。
- undo log：维护历史版本链；读已提交/可重复读通过 Read View 选择可见版本。

## 2. Read View 生成与可见性
- 关键字段：`creator_trx_id`、活跃集合 `m_ids`、`low_limit_id`、`up_limit_id`。
- 判断规则：`trx_id < low_limit_id` 可见；`trx_id >= up_limit_id` 不可见；在集合内不可见。

```sql
SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ;
START TRANSACTION;
SELECT * FROM t WHERE id = 1; -- 固定 Read View
```

## 3. 二级索引一致性
- 二级索引条目不含行可见性信息，需回表到聚簇索引判断；
- 覆盖索引可避免回表，但仍受 MVCC 可见性约束。

---

## 4. 可复现实验：幻读与间隙锁
准备数据：
```sql
CREATE TABLE t(
  id INT PRIMARY KEY,
  k  INT,
  KEY idx_k(k)
) ENGINE=InnoDB;
INSERT INTO t VALUES (1,10),(2,20),(3,30);
```
事务 A（会话1）：
```sql
SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;
START TRANSACTION;
SELECT * FROM t WHERE k BETWEEN 10 AND 30 FOR UPDATE; -- Next-Key Lock
```
事务 B（会话2）：
```sql
INSERT INTO t VALUES(4,25); -- 阻塞：被间隙锁拦截，避免幻读
```
切换 RC：
```sql
SET GLOBAL transaction_isolation='READ-COMMITTED';
-- 重新测试，观察 gap 锁减少与并发插入的行为变化
```

## 5. 实验：RR 下版本可见性
```sql
-- 会话1
START TRANSACTION; SELECT * FROM t WHERE id=1; -- 读到 v1
-- 会话2
UPDATE t SET k=k+1 WHERE id=1; COMMIT;          -- v2
-- 会话1
SELECT * FROM t WHERE id=1; -- 仍读到 v1（同一 Read View）
COMMIT;
```

## 6. 源码走读要点（8.0）
- `read0read.cc`：一致性读实现，基于 Read View 的可见性检查；
- `trx0trx.cc`：事务生命周期与 `ReadView` 构建；
- `lock0lock.cc`：Next-Key Lock 组合与冲突检测。

关注点：`m_ids` 计算的边界、长事务导致的 purge 延迟对可见性的影响。

---

## 7. 典型排错清单
- 长事务导致 `history list length` 过大，undo 堆积：
  - 排查 `information_schema.innodb_trx`，定位阻塞的只读/未提交事务；
- 幻读与行锁升级：
  - 检查是否遗漏索引导致范围扩大、或 RC 下并发写放大；
- 覆盖索引未生效：
  - `EXPLAIN ANALYZE` 对比 `using index`；确认选择列是否完全被索引覆盖。

---

## 8. 最佳实践
- 将批量只读分析放到只读副本，避免长事务阻塞主库 purge；
- 范围更新尽量精确，必要时逻辑分片降低锁冲突；
- 定期巡检长事务、undo 使用、`innodb_purge_threads` 与 IO 限流。
