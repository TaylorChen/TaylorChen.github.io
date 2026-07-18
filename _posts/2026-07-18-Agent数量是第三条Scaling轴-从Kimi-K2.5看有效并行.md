---
title: "Agent 数量是第三条 Scaling 轴：从 Kimi K2.5 看有效并行"
date: 2026-07-18
categories: [AI, 技术]
tags: [AI, Agent, 多Agent, Agent Swarm, PARL, Kimi K2.5, 强化学习, 架构设计]
description: "多 Agent 的价值不在于创建了多少 Agent，而在于系统能否同时避免串行坍缩、虚假并行和汇总失败。Kimi K2.5 的 PARL 给出了一套很有工程价值的答案。"
---

最近看了 Kimi 团队杨植麟在 GTC 2026 的演讲《How We Scaled Kimi K2.5》。整场 39 分钟，给我冲击最大的不是万亿参数，也不是百万上下文，而是一个很朴素的判断：**Agent 数量正在成为模型能力的第三条 Scaling 轴。**

过去谈 Scaling，大家习惯想到更多参数、更多数据、更多算力。但 Agent 真正进入生产以后，单纯把模型变大已经不够了。一个复杂任务能否完成，还取决于三个问题：模型学得够不够高效、单个 Agent 能跑多远、系统能不能让多个 Agent 同时向一个目标推进。

这三件事分别对应 Kimi 分享的三条路径：MuonClip、Kimi Linear、Agent Swarm。

![Kimi K2.5 的三条 Scaling 轴](/assets/images/2026/kimi-k2.5-three-scaling-axes.svg)

## 第一条轴：让每个 Token 更值钱

第一条轴是 **Token efficiency**。

高质量训练数据不是无限的。当可用数据逐渐接近上限时，训练效率不再只是成本问题，而是能力上限问题。假设手里只有 50 万亿个高质量 Token，如果新的优化方法能做到两倍 Token 效率，效果就近似于凭空多出一份同等质量的数据。

Kimi 在这里采用的是 MuonClip。Muon 提高矩阵参数更新的效率，但扩展到万亿参数时遇到了 attention logit 爆炸和训练发散。QK-Clip 的作用，是监测各 attention head 的异常 logit，并缩放 Q/K 投影，把不稳定性限制住。最终的 MuonClip 同时追求两件事：学得快，也不能炸。

这条轴映射到 Agent 系统里，代表的是**更强的先验**。模型本身越强，同样的工具调用和搜索预算下，找到正确方案的概率越高。Harness 可以放大模型，但不能凭空替代底座能力。

## 第二条轴：让一个 Agent 跑得更远

第二条轴是 **Context length**。

长上下文经常被理解成“能塞更多文档”，但对 Agent 来说，更重要的是**能维持更长的有效工作轨迹**。一个 Agent 要持续工作数小时甚至数天，需要记得早期约束、已完成动作和失败尝试，还要避免在第几十轮工具调用后开始重复劳动。

Kimi Linear 的出发点正是这个问题。它的核心 Kimi Delta Attention，不再用一个全局衰减因子决定记忆保留，而是允许不同通道以不同速度遗忘：一部分通道保存长期信息，另一部分持续刷新短期状态。再把线性注意力与全注意力混合，换取长序列下更好的效率。

这条轴映射到 Agent 系统里，代表的是**时间深度**。上下文窗口只是容量，真正有用的是上下文管理：哪些事实必须长期保留，哪些中间输出应该压缩，哪些失败轨迹可以丢弃。否则百万窗口也可能只是一个百万 Token 的垃圾场。

## 第三条轴：让多个 Agent 同时推进

第三条轴才是这次演讲最有意思的部分：**Number of agents**。

单 Agent 再强，本质上仍是一条串行执行链。面对可拆分任务，它只能依次搜索、阅读、验证、生成。Agent Swarm 则引入一个 Orchestrator，动态创建不同专长的子 Agent：有人搜索资料，有人分析数据，有人核查事实，有人负责最终交付。任务复杂度开始从“一个 Agent 能跑多久”，扩展为“一个组织能同时推进多少条有效分支”。

我在上一篇[《多 Agent 系统的协作模式》]({% post_url 2026-06-06-多Agent系统的协作模式-从单兵到军团 %})里讲过 Orchestrator-Worker、Pipeline、Debate 和 Swarm。但那篇解决的是“怎么组织”，Kimi 这次回答的是另一个问题：**怎么让模型主动学会并行，而且不是为了并行而并行？**

答案是 PARL，Parallel-Agent Reinforcement Learning。

## 三个奖励，卡住三种失败

PARL 的奖励函数可以简化成：

```text
R_PARL = λ1 × R_parallel + λ2 × R_finish + R_outcome
```

看起来简单，但三个奖励分别卡住了多 Agent 最典型的三种失败。

**第一项是实例化奖励 `R_parallel`。** 它鼓励 Orchestrator 创建子 Agent，防止模型明明拥有并发能力，却仍然退回单 Agent 串行执行。Kimi 把这种现象称为 serial collapse，串行坍缩。

**第二项是完成奖励 `R_finish`。** 只奖励创建数量，模型很快会钻空子：生成一堆子任务，任务过大、相互重复，甚至创建后从不回收。表面上 Agent 很多，实际吞吐没有增加。完成奖励要求创建出来的任务真正闭环，用来抑制 spurious parallelism，虚假并行。

**第三项是结果奖励 `R_outcome`。** 子任务全部完成，不代表用户目标完成。十份局部正确的报告可能互相矛盾，也可能根本没有被最终答案采用。结果奖励把优化目标重新拉回整个任务。

训练早期，前两项权重较高，先让模型学会创建并完成子任务；随着训练推进，权重逐渐衰减，让最终结果成为主导。这个设计很像教一个新经理：先要求他必须学会分工，再要求每项分工有交付，最后才真正按团队结果考核。

官方技术报告披露，K2.5 Agent Swarm 在 BrowseComp 上从单 Agent 的 60.6 提升到 78.4，在内部 Swarm Bench 上从 41.6 提升到 58.3；WideSearch 不仅从 72.7 提升到 79.0，在不同目标准确率下还获得约 3 到 4.5 倍的执行加速。这个结果至少说明一件事：对于检索、批量下载、百份文档阅读、长篇生成这类可大规模拆分的任务，并行宽度确实可以转化为能力和速度。

但要注意，这些是模型方报告，不等于所有业务上多 Agent 都会更快。任务依赖越强、共享状态越多、汇总越困难，并行收益越容易被协调成本吃掉。

## 不训练模型，也可以先复刻这套思想

大多数团队不会自己训练 Orchestrator，但 PARL 的思路完全可以翻译成平台指标。

我会把运行时最小观测集设计成下面这样：

```text
spawn_count               创建了多少子 Agent
effective_parallelism     实际同时运行且产生有效输出的数量
subtask_finish_rate       子任务完成率
merge_contribution_rate   子任务结果被最终产物采用的比例
outcome_success           最终任务是否通过验收
token_cost                总 Token 成本
wall_clock_latency        墙钟时间
redundancy_rate           重复检索、重复推理的比例
retry_rate                子任务重试率
```

其中我最看重 `merge_contribution_rate`。很多多 Agent Demo 会展示“我启动了 20 个 Agent”，却不告诉你最终答案究竟用了其中几份结果。如果 20 个 Agent 里只有两个产出被采用，其余都是噪声，那不是 Swarm，是昂贵的进度条动画。

每个子任务还必须进入同一棵可追踪执行树：

```yaml
task_id: research-17
parent_id: report-01
goal: 验证某项技术数据是否有官方来源
context_ref: snapshot-42
status: completed
latency_ms: 18320
token_cost: 12640
evidence: [source_url, excerpt]
merged_into: final-report-01
```

没有这棵树，系统出了问题时只能看到最终答案不好，却不知道是没拆任务、任务没完成，还是结果死在汇总阶段。多 Agent 系统和分布式系统一样：如果不可观测，就不可优化。

## 四个反模式

**把 Agent 数量当 KPI。** 数量只代表成本，不能代表并行价值。真正该看的，是有效并行度和结果采用率。

**把所有复杂任务都拆开。** 复杂不等于可并行。核心方案权衡、强依赖代码修改、需要持续回溯决策链的任务，留在一个 Agent 里往往更稳。

**只检查 Worker，不检查 Reducer。** Worker 每份结论都可能正确，但汇总者会漏掉冲突、重复采信同一证据，或把不同口径的数据拼在一起。Merge failure 是多 Agent 独有的一等故障。

**一开始就训练调度模型。** 没有稳定任务定义、执行轨迹和结果评测时，训练只是在放大模糊。先用规则跑出基线，积累失败案例，再判断是否值得学习调度策略。

## 我会怎么分三步落地

第一阶段，**规则驱动**。只开放一层 Orchestrator-Worker，限制并发和嵌套深度；明确哪些任务类型允许 fan-out；把执行树、成本和结果采用率记录完整。

第二阶段，**评测驱动**。同一批任务持续比较单 Agent 与多 Agent：成功率提升多少、延迟下降多少、Token 增加多少。只有质量或速度收益能覆盖协调成本的任务，才进入 Swarm 白名单。

第三阶段，**策略学习**。轨迹足够多以后，再从数据中学习什么时候拆、拆成多大粒度、选择什么角色。到这一步，PARL 才从一篇论文里的奖励函数，变成有真实业务反馈的 Orchestrator 训练方案。

这个顺序很重要。Agent Swarm 首先是 Harness 和可观测性问题，然后才是强化学习问题。

## 结语

Kimi 这场演讲把模型扩展画成了一个更完整的空间：MuonClip 提高每个 Token 的价值，Kimi Linear 延长单 Agent 的有效轨迹，PARL 扩大同一时间内的有效执行宽度。更强先验、更长时间、更宽并行，三项收益最终相乘。

但对工程团队来说，最值得记住的不是“以后要开更多 Agent”，而是这句话：

> 多 Agent 的价值，不在于创建了多少 Agent，而在于有多少独立工作真正完成、被汇总，并推动了最终目标。

如果现在就要行动，我建议先给现有 Agent 平台加一个指标：`merge_contribution_rate`。它会非常诚实地告诉你，眼前的并行究竟是生产力，还是表演。

## 参考资料

- [How We Scaled Kimi K2.5｜Zhilin Yang's full GTC 2026 Keynote](https://www.youtube.com/watch?v=CwePo4847ho)
- [Kimi K2.5: Visual Agentic Intelligence](https://arxiv.org/abs/2602.02276)
- [Kimi K2: Open Agentic Intelligence](https://arxiv.org/abs/2507.20534)
- [Kimi Linear 官方仓库](https://github.com/MoonshotAI/Kimi-Linear)
- [Attention Residuals 官方仓库](https://github.com/MoonshotAI/Attention-Residuals)
