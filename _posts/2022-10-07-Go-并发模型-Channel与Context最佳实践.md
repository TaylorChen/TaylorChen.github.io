---
title: "Go 并发模型：Channel 与 Context 最佳实践"
date: 2022-10-07
categories: [技术, Golang]
tags: [技术, Golang, 并发]
---

如何用 Channel 建模生产者-消费者、扇入扇出、超时与取消？Context 在线程间传递取消与元数据，避免协程泄漏。

## 1. 扇入扇出
```go
func fanOut(in <-chan T, n int) []<-chan T { /* ... */ }
func fanIn(cs ...<-chan T) <-chan T { /* ... */ }
```

## 2. 超时
```go
select {
case <-time.After(200*time.Millisecond): /* timeout */
case v := <-ch: _ = v
}
```

## 3. 泄漏排查
- goroutine 泄漏：未读的 channel 阻塞；
- 使用 `pprof` 的 goroutine profile 与阻塞分析。
