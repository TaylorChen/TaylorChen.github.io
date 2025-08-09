---
title: "Nginx Ingress 在 Kubernetes 的高可用配置"
date: 2023-12-05
categories: [技术, Nginx]
tags: [技术, Nginx, Kubernetes, Ingress, 高可用]
description: "给出 Ingress-Nginx 在 K8s 的高可用与灰度配置：基础清单、金丝雀、反亲和/跨区扩散/PDB、升级收敛、HPA 与连接复用等实操要点。"
---

在 K8s 中落地 Ingress-Nginx 时，如何配置高可用、弹性与灰度？本文给出实操 YAML、金丝雀流量与压测/演练手册。

## 1. 基础部署（示例）
```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: web
  annotations:
    kubernetes.io/ingress.class: nginx
spec:
  rules:
  - host: demo.example.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: web-svc
            port:
              number: 80
```

## 2. 金丝雀灰度
```yaml
metadata:
  annotations:
    nginx.ingress.kubernetes.io/canary: "true"
    nginx.ingress.kubernetes.io/canary-weight: "20" # 20%
```

## 3. HA 形态
- DaemonSet + hostNetwork + externalTrafficPolicy=Local，保持源地址；
- 或 Service L4 LB + 多副本 Ingress Controller。

## 4. 压测与演练
- `fortio/vegeta` 压测 10-30 分钟，观察 2xx/4xx/5xx 与 P95；
- 演练：杀死节点/Pod、模拟 LB 抖动，验证会话粘性与重试策略。

## 5. 拓扑与调度（反亲和/跨区扩散/PDB/容忍）

```yaml
controller:
  replicaCount: 3
  affinity:
    podAntiAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        - labelSelector:
            matchLabels:
              app.kubernetes.io/name: ingress-nginx
              app.kubernetes.io/component: controller
          topologyKey: kubernetes.io/hostname
  topologySpreadConstraints:
    - maxSkew: 1
      topologyKey: topology.kubernetes.io/zone
      whenUnsatisfiable: ScheduleAnyway
      labelSelector:
        matchLabels:
          app.kubernetes.io/name: ingress-nginx
          app.kubernetes.io/component: controller
  tolerations:
    - key: "node-role.kubernetes.io/ingress"
      operator: "Exists"
      effect: "NoSchedule"
```

PodDisruptionBudget（避免滚动/维护时一次性驱逐）：

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata: { name: ingress-nginx-pdb, namespace: ingress-nginx }
spec:
  minAvailable: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: ingress-nginx
      app.kubernetes.io/component: controller
```

## 6. 升级与优雅收敛

```yaml
controller:
  updateStrategy: { type: RollingUpdate }
  minReadySeconds: 10
  terminationGracePeriodSeconds: 60
  config:
    worker-shutdown-timeout: "30s"
    proxy-next-upstream: "error timeout http_502 http_503 http_504"
    proxy-next-upstream-tries: "2"
    proxy-read-timeout: "30s"
    proxy-send-timeout: "30s"
```

要点：
- `minReadySeconds` 确保就绪后才接流量；`worker-shutdown-timeout` 提供连接迁移时间。
- 与上游的重试与超时上限要保守，防止风暴。

## 7. 容量与弹性（HPA）

```yaml
controller:
  metrics:
    enabled: true
    serviceMonitor:
      enabled: true
  autoscaling:
    enabled: true
    minReplicas: 3
    maxReplicas: 20
    targetCPUUtilizationPercentage: 60
    targetMemoryUtilizationPercentage: 70
```

建议：基于 CPU/内存或自定义 QPS/连接数指标（需自定义 Metrics Adapter）弹性扩缩容。

## 8. 上游容错与连接复用

```yaml
controller:
  config:
    keep-alive-requests: "1000"                # client <-> ingress 长连接复用上限
    upstream-keepalive-connections: "512"      # ingress <-> upstream 空闲长连接上限
    max-worker-connections: "65536"
    retries: "1"
    retry-non-idempotent: "false"
```

注意：若上游有会话亲和（如登录态），需与 `session-cookie`/一致性哈希配合，避免跨请求状态混淆。

## 9. 可观测与演练清单（扩展）

- 指标：活动连接、`$upstream_response_time` 分位数、5xx 率、队列与 fd 用量。
- 日志：统一 JSON 格式，保留版本/路由/上游信息，便于问题回溯。
- 演练：
  - 杀 Pod/节点；
  - 人为提升上游错误，验证 `proxy-next-upstream`；
  - LB 抖动/跨区故障；
  - 扩缩容/滚动升级下的会话粘性与连接复用表现。

---
