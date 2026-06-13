---
title: "MCP 协议深入：AI 应用的 USB-C 接口"
date: 2026-05-09
categories: [AI, 技术]
tags: [AI, MCP, Agent, 协议, 工程实践]
description: "MCP 把「模型如何接入外部世界」从 N×M 的集成噩梦变成 N+M 的标准化问题。本文从协议设计、消息模型到生产实践，完整拆解 MCP 的工程价值与落地陷阱。"
---

2024 年 11 月 Anthropic 开源 MCP（Model Context Protocol）时，很多人以为这只是又一个工具调用的封装。一年半过去，OpenAI、Google 先后宣布兼容，MCP 事实上成了 AI 应用接入外部世界的标准接口。这篇文章不讲新闻，讲协议本身：它解决了什么问题、怎么解决的、生产环境里有哪些坑。

## 为什么需要 MCP：N×M 问题

在 MCP 之前，每个 AI 应用接入每个数据源都要写一遍胶水代码。你有 N 个 AI 客户端（Claude、Cursor、自研 Agent），M 个数据源（数据库、Slack、内部 API），就要维护 N×M 套集成。每套集成都有自己的认证方式、错误处理、数据格式。

这和 USB 出现之前的外设市场一模一样：每台电脑、每个打印机厂商都有自己的接口。MCP 做的事情就是定义一个统一插口——客户端只要实现一次 MCP Client，就能接入所有 MCP Server；数据源只要实现一次 MCP Server，就能被所有支持 MCP 的应用使用。N×M 变成 N+M。

![MCP 架构示意](/assets/images/2026/mcp-architecture.svg)

## 协议分层：三个核心原语

MCP 基于 JSON-RPC 2.0，传输层支持 stdio（本地进程）和 Streamable HTTP（远程服务）。协议层定义了三个核心原语，理解它们的区别是用好 MCP 的关键：

**Tools（工具）**：模型主动调用的函数。由模型决定什么时候调、传什么参数。比如 `query_database`、`send_message`。这是大家最熟悉的部分，对应传统的 function calling。

**Resources（资源）**：应用控制的上下文数据。注意是「应用控制」而不是「模型控制」——由宿主应用决定把哪些资源注入上下文。比如一个文件的内容、一条数据库记录。Resources 是只读的，有 URI 标识，支持订阅变更。

**Prompts（提示模板）**：用户控制的交互模板。用户在 UI 里显式选择触发，比如斜杠命令。Server 可以暴露参数化的提示模板，把领域知识打包给用户复用。

三者的控制权分别在模型、应用、用户手里。很多人把所有东西都塞进 Tools，结果模型在一堆本该是静态上下文的数据上反复做无谓的工具调用，既慢又贵。正确的做法是：动态操作用 Tools，静态上下文用 Resources，固定工作流用 Prompts。

## 动手写一个 MCP Server

用官方 Python SDK 写一个查询 MySQL 慢日志的 Server，不到 60 行：

```python
from mcp.server.fastmcp import FastMCP
import aiomysql

mcp = FastMCP("mysql-slowlog")

@mcp.tool()
async def top_slow_queries(limit: int = 10) -> str:
    """查询执行时间最长的慢 SQL，按平均耗时降序"""
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor(aiomysql.DictCursor) as cur:
            await cur.execute("""
                SELECT schema_name, digest_text,
                       count_star AS calls,
                       avg_timer_wait/1e12 AS avg_sec
                FROM performance_schema.events_statements_summary_by_digest
                ORDER BY avg_timer_wait DESC LIMIT %s
            """, (limit,))
            rows = await cur.fetchall()
    return "\n".join(
        f"[{r['avg_sec']:.2f}s x{r['calls']}] {r['digest_text'][:120]}"
        for r in rows
    )

@mcp.resource("schema://{table}")
async def table_schema(table: str) -> str:
    """暴露表结构作为只读资源"""
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(f"SHOW CREATE TABLE {validate(table)}")
            return (await cur.fetchone())[1]

if __name__ == "__main__":
    mcp.run(transport="stdio")
```

客户端配置（以 Claude Desktop 为例）：

```json
{
  "mcpServers": {
    "mysql-slowlog": {
      "command": "python",
      "args": ["/opt/mcp/slowlog_server.py"],
      "env": { "MYSQL_DSN": "mysql://readonly@db:3306/perf" }
    }
  }
}
```

注意两个细节：工具的 docstring 会直接成为模型看到的工具描述，写得越精确，模型的调用准确率越高；`table_schema` 用了 Resource 而不是 Tool，因为表结构是静态上下文，不需要模型反复决策。

## 生产环境的四个坑

**坑一：工具数量爆炸。** 接入五六个 MCP Server 后，模型面前可能摆着上百个工具。工具描述全部进入上下文，token 成本飙升不说，模型的选择准确率会显著下降。我的经验阈值是 40 个工具以内；超过就要做工具的动态裁剪——按当前任务语义检索相关工具，而不是全量注入。

**坑二：把 MCP Server 当 API 网关用。** 有团队把内部 200 个 REST 接口一比一翻译成 MCP 工具，结果模型完全用不好。MCP 工具的粒度应该面向「任务」而非「接口」：与其暴露 `get_user`、`get_orders`、`get_refunds` 三个工具让模型自己编排，不如暴露一个 `get_customer_overview`。模型少做一次编排，就少一次出错的机会。

**坑三：安全边界缺失。** stdio 模式下 Server 继承宿主进程权限，prompt injection 可以诱导模型调用危险工具。生产实践必须做三件事：工具按最小权限设计（数据库账号只读）、写操作强制人工确认（MCP 协议支持 elicitation）、对工具返回内容做注入检测——工具返回值同样是不可信输入，这一点最容易被忽略。

**坑四：忽略协议版本与能力协商。** MCP 在快速演进，2025-03 引入 Streamable HTTP 取代 SSE，2025-06 增强了 OAuth 资源服务器语义。Client 和 Server 在 `initialize` 握手时会协商协议版本和能力（capabilities），自研客户端如果硬编码假设对方支持某能力，升级时一定会炸。永远以握手返回的 capabilities 为准。

## MCP 不是银弹

最后泼点冷水。MCP 解决的是「连接」的标准化，不解决「使用」的智能化。工具接上了，模型用不用得好是另一回事——这取决于工具描述质量、上下文工程和任务分解，这些活儿 MCP 一个都没替你干。

我自己的类比是 HTTP：重要、必要、值得现在就投入，但没有谁靠「支持了 HTTP」赢过。竞争力在协议之上那一层——接进来的东西能不能组合成解决真实问题的能力。

我们内部第一个 MCP Server 上线到现在四个月，最大的收获其实不是技术上的，而是它逼着各团队把「我们的数据能被 AI 怎么用」这个问题想清楚了。工具描述写不出来的接口，多半是接口本身就没想清楚。这个副作用我觉得比协议本身还值。
