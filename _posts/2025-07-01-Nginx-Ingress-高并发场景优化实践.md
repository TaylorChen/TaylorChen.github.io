---
title: "Nginx Ingress 高并发场景优化实践"
date: 2025-07-01
categories: [技术, Nginx]
tags: [技术, Nginx, Kubernetes, 并发]
description: "在高并发/高吞吐场景下优化 Ingress-Nginx 的系统方案：内核参数、连接与线程、日志与轮转、压测与观测、排障与灰度实操清单。附 Helm values 与生产指标口径。"
---

在高并发/高吞吐场景下，Ingress-Nginx 的瓶颈往往在四处：连接与端口、文件句柄、握手与 TIME_WAIT、日志 I/O。本文给出值可直接落地的 Helm `values.yaml` 片段、Linux 内核参数、日志轮转 sidecar、压测与观测清单。

## 1. 云负载均衡（CLB/NLB）容量
- 选择性能容量型/增强型实例，并调高带宽上限；入口成为系统上限的概率远高于后端。
- 自建 CLB 后通过注解/固定 `loadBalancerIP` 复用为 Ingress 入口。

## 2. Linux 内核参数（容器内以 initContainer 动态设置）

Helm `values.yaml`：

```yaml
controller:
  extraInitContainers:
    - name: sysctl
      image: busybox
      imagePullPolicy: IfNotPresent
      securityContext:
        privileged: true
      command:
        - sh
        - -c
        - |
          sysctl -w net.core.somaxconn=65535
          sysctl -w net.ipv4.ip_local_port_range="1024 65535"
          sysctl -w net.ipv4.tcp_tw_reuse=1
          sysctl -w fs.file-max=1048576
```

说明：
- `somaxconn` 提升监听队列，缓解 SYN/accept 队列溢出。
- `ip_local_port_range` 扩大源端口范围，降低端口耗尽风险。
- `tcp_tw_reuse` 在客户端侧端口紧张时复用 TIME_WAIT（谨慎，仍以观测为准）。
- `fs.file-max` 与容器 `ulimit`/`worker_rlimit_nofile` 对齐。

## 3. Ingress-Nginx 配置（连接与工作线程）

```yaml
controller:
  config:
    keep-alive-requests: "1000"                 # client <-> ingress 单连接可承载请求数
    upstream-keepalive-connections: "2000"      # ingress <-> upstream 空闲长连接上限
    max-worker-connections: "65536"             # 每 worker 可开的最大连接数
```

要点：
- `keep-alive-requests` 过高可能导致扩容后负载不均；建议结合压测观察。
- `upstream-keepalive-connections` 是空闲连接上限（非总连接数）；按 worker 数乘算总上限。

## 4. 日志落盘与轮转（降低高并发下 stdout CPU 开销）

```yaml
controller:
  config:
    access-log-path: /var/log/nginx/nginx_access.log
    error-log-path: /var/log/nginx/nginx_error.log
  extraVolumes:
    - name: log
      emptyDir: {}
  extraVolumeMounts:
    - name: log
      mountPath: /var/log/nginx
  extraContainers:
    - name: logrotate
      image: imroc/logrotate:latest
      imagePullPolicy: IfNotPresent
      env:
        - name: LOGROTATE_FILE_PATTERN
          value: "/var/log/nginx/nginx_*.log"
        - name: LOGROTATE_FILESIZE
          value: "100M"
        - name: LOGROTATE_FILENUM
          value: "3"
        - name: CRON_EXPR
          value: "*/1 * * * *"
        - name: CROND_LOGLEVEL
          value: "8"
      volumeMounts:
        - name: log
          mountPath: /var/log/nginx
```

## 5. 端到端压测与观测
- 压测：`wrk`（HTTP/1.x）、`h2load`（HTTP/2/3）、`vegeta/fortio`；建议 10–30 分钟稳定压测并观测收敛。
- 指标：活动连接、连接错误、`$upstream_response_time` 分位数、5xx 率、`worker_connections` 使用率、TIME_WAIT 总数、端口使用率。
- 日志：使用 JSON 格式，记录上游地址、上游时延、路由信息，便于定位热点与异常。

## 6. 常见排障路径
- 端口耗尽：增大 `ip_local_port_range`，提升上游 keepalive，排查异常关闭；观测 `ss -s`。
- 队列溢出/5xx：调大 `somaxconn` 与 `backlog`，核查上游超时/重试策略，查丢包。
- CPU 飙升：stdout I/O 抖动，切换日志落盘+轮转；或减少日志字段。

---

参考链接：
- 高并发场景优化（外部实践指南）：[`https://imroc.cc/tke/networking/ingress-nginx/high-concurrency`](https://imroc.cc/tke/networking/ingress-nginx/high-concurrency)

