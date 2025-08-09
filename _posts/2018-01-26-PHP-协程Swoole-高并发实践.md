---
title: "PHP 协程 Swoole 高并发实践"
date: 2018-01-26
categories: [技术, PHP]
tags: [技术, PHP, Swoole, 并发, 协程, 性能]
description: "围绕 Swoole 协程/调度/Hook 与连接池等关键点，提供高并发落地范式、压测方法与避坑清单。"
---

Swoole 将 PHP 带入常驻内存 + 协程并发时代。本文聚焦调度、Hook、协程上下文与与 MySQL/Redis 客户端协作细节，并提供压测脚本与避坑指南。

## 1. 协程 Hook
- `Swoole\Runtime::enableCoroutine()` 对常见 IO 进行 Hook；
- 注意与第三方扩展兼容性（cURL、多进程）。

## 2. 连接池示例
```php
class MySQLPool { /* ... 维护 Channel 与 连接对象 ... */ }
// 请求开始从池获取，结束归还；确保协程安全
```

## 3. 压测
```bash
wrk -t8 -c200 -d60s http://127.0.0.1:9501/
```
观察 QPS、P95、`net.core.somaxconn`、`ulimit -n`。

## 4. 常见坑
- 全局单例污染：请求间状态泄漏；
- 异常处理：协程内抛出的异常要汇聚到日志与告警；
- Composer 热更新失效：常驻进程需手动 reload。
