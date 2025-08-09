---
title: "Java 并发编程：从 Lock 到 AQS"
date: 2017-05-21
categories: [技术, Java]
tags: [技术, Java, 并发, AQS]
---

并发编程里，“锁”是跨线程协调和内存可见性的核心抽象。本文从 Java 对象头与锁位开始，系统梳理锁信息的存放位置、`synchronized` 与 `Lock/AQS` 的实现原理、CAS 的内存语义与常见陷阱，并从 x86/ARM 的汇编视角出发，解释 HotSpot 在不同平台上的底层逻辑。最后给出工程实践的选型建议与调优要点。

## 1. Java 对象、对象头与锁位

HotSpot 中对象的内存布局通常包含三段：
- 对象头（Header）：包含 `Mark Word` 和 `Klass Pointer`；数组对象还包含数组长度。
- 实例数据（Instance Data）：各字段的实际存储。
- 对齐填充（Padding）：保证对象按 8 字节对齐。

### 1.1 Mark Word 与锁信息
`Mark Word` 是一个会随对象状态复用的位段（32/64 位 JVM 分别是 32/64 位；在 64 位下如果启用指针压缩，`Klass Pointer` 为 32 位）：
- 无锁：存放对象哈希（identity hash code）、GC Age 等。
- 偏向锁：存放偏向线程 ID、Epoch、Age 等。
- 轻量级锁：存放指向线程栈上“锁记录（Lock Record）”的指针（Displaced Header）。
- 重量级锁：存放指向 Monitor（对象监视器）的指针。

锁标志位（lock bits）与偏向标志位（biased bit）共同决定 Mark Word 当前的语义。需要注意：
- 一旦对象计算过 identity hash code（如调用过 `System.identityHashCode`，或对象参与了基于哈希的容器），Mark Word 需要存放 hash，偏向锁将无法使用（会导致偏向撤销或直接进入轻量级/重量级路径）。
- 锁状态是“可升级、不可降级”的：无锁 → 偏向 → 轻量级 → 重量级。

### 1.2 JDK 版本对偏向锁的影响
- JDK 6～8：偏向锁默认启用（可通过 `-XX:-UseBiasedLocking` 关闭）。
- JDK 15：根据 JEP 374，偏向锁被默认禁用并标记为废弃。
- JDK 18 起：HotSpot 中移除了偏向锁实现（仅保留语义历史说明）。

工程上撰写面向“现代 JDK（11/17/21 LTS 及以上）”的代码时，可不再依赖偏向锁的收益模型，更多关注轻量级/重量级路径与锁粗细粒度的取舍。

## 2. `synchronized` 的状态流转与 Monitor

`synchronized` 基于对象监视器（Monitor）实现。HotSpot 会根据竞争情况在不同状态间切换：
1) 无锁：进入同步块首次尝试；
2) 轻量级锁：线程在自己的栈帧创建“锁记录”，用 CAS 将对象头替换为指向锁记录的指针；
3) 自旋：竞争不重时短暂自旋等待可避免阻塞开销；
4) 重量级锁：自旋失败或竞争激烈时膨胀为 Monitor，失败线程进入阻塞，等待 `unpark/notify` 唤醒。

Monitor 内部有两个队列概念：
- 入口队列（EntryList）：在 `synchronized` 入口处等待获取锁的线程。
- WaitSet：调用 `Object.wait()` 释放锁并等待条件的线程集合，被 `notify/notifyAll` 转移回 EntryList。

现代 HotSpot 中，阻塞/唤醒通常经由 `Unsafe.park/unpark` 实现，底层在 Linux 使用 `futex`，在 macOS 使用 pthread 条件变量等原语。

### 2.1 轻量级锁细节（Lock Record）
轻量级锁是“乐观地假设不存在并发”。流程：
1) 将对象头的 Mark Word 复制到线程栈的锁记录。
2) 使用 CAS 将对象头替换为指向锁记录的指针。
3) 成功即获得锁；失败说明存在竞争，进入自旋或膨胀。
4) 解锁时尝试用 CAS 将对象头还原为锁记录中保存的 Displaced Header；失败则说明发生竞争，转重量级解锁路径。

轻量级锁的优势是在“短临界区、低冲突”场景下显著减少阻塞/唤醒的系统开销。

## 3. 从 CAS 谈起：原理、内存语义与陷阱

CAS（Compare-And-Swap/Exchange）是硬件提供的原子读-改-写指令族。以三元组 (V, A, B) 描述：当且仅当 V==A 时，将 V 置为 B；否则失败。Java 中的 CAS 主要通过 `Unsafe`/`VarHandle` 暴露：

```java
// Java 9+ VarHandle 示例
class Counter {
  private volatile int value;
  private static final VarHandle VH;
  static {
    try {
      VH = MethodHandles.lookup()
          .in(Counter.class)
          .findVarHandle(Counter.class, "value", int.class);
    } catch (Exception e) { throw new Error(e); }
  }
  public int increment() {
    int prev;
    do {
      prev = (int) VH.getVolatile(this);
    } while (!VH.compareAndSet(this, prev, prev + 1));
    return prev + 1;
  }
}
```

### 3.1 内存语义
不同于“互斥”，CAS 主要提供“原子性 + 指定的有序性”。HotSpot 在不同平台下映射为：
- x86（TSO）：天然提供较强顺序性，`LOCK CMPXCHG` 隐含 acquire-release 语义；必要时配合 `LFENCE/SFENCE/MFENCE`。
- ARMv8：使用 LL/SC 族指令 `LDAXR/STLXR`（带 acquire/release 语义）与 `DMB ish` 栅栏保证有序性。

Java 语言层面，`volatile` 写具有“release”语义，读具有“acquire”语义；CAS 通常等价于“读-改-写的原子性 + acquire-release”。这保证了临界区内写入对随后持有同一变量可见。

### 3.2 ABA 问题与对策
CAS 的经典陷阱是 ABA：值从 A→B→A，单次 CAS 无法察觉变化。对策包括：
- 版本戳（如 `AtomicStampedReference`）、标记指针（`AtomicMarkableReference`）。
- 结构性约束（避免重用节点）、配合 GC 的安全点检查降低风险。

### 3.3 多变量一致性
CAS 天然只能覆盖单内存位置。多字段一致性可用：
- 粗粒度互斥（单锁包裹），简单可靠；
- 组合状态编码（如将两字段打包到 64 位 long）；
- STM/事务日志（较重，工程中少见）。

## 4. Lock 与 AQS：CLH 队列、独占/共享与条件队列

AQS（AbstractQueuedSynchronizer）是 `ReentrantLock`、`Semaphore`、`CountDownLatch`、`ReentrantReadWriteLock`、`StampedLock`（部分实现）等的基础设施。其核心是：
- 一个 `int state` 表示同步状态（独占/共享语义由子类定义）；
- 一个基于 CLH 的双向 FIFO 同步队列，失败线程入队并 `park`；
- 成功释放时按队头顺序 `unpark`，维持有界公平性。

### 4.1 独占与共享
- 独占（Exclusive）：如 `ReentrantLock`。`tryAcquire/tryRelease` 由子类实现；重入通过把 `state` 作为重入计数。
- 共享（Shared）：如 `Semaphore`、`CountDownLatch`。共享获取可同时唤醒多个等待者。

### 4.2 公平 vs 非公平
```java
Lock fair = new ReentrantLock(true);
Lock unf  = new ReentrantLock(false);
```
- 公平：严格遵循队列顺序，等待时间方差小，但吞吐稍低；
- 非公平：允许插队（`tryAcquire` 先试一次），吞吐更高，极端情况下存在饥饿风险。

### 4.3 条件队列（Condition）
`ConditionObject` 为每个条件维护独立等待队列：
- `await()`：原子地释放主锁、入条件队列并 `park`；
- `signal()`：将条件队列的首节点转移回同步队列，等待重新竞争主锁。

### 4.4 AQS 获取/释放（独占）骨架
1) 快路径：CAS 修改 `state` 成功直接获得；
2) 失败入队：按 CLH 入同步队列，`park` 自己；
3) 被前驱释放 `unpark` 后，竞争重试；
4) 释放：`tryRelease` 成功则唤醒后继。

## 5. 平台与汇编视角：x86 与 ARM 的差异

### 5.1 x86（TSO）
- 原子指令：`LOCK XCHG/CMPXCHG/ADD` 等，`LOCK` 前缀保证跨核原子性与缓存一致性协议的正确传播。
- 自旋优化：热点代码会插入 `PAUSE`（`rep; nop`）降低功耗与总线竞争。
- 内存模型：TSO 比 Java 的 JMM 更强，编译器仍需在 volatile/CAS 周边插入恰当屏障以维持 JMM 语义。

### 5.2 ARMv8（弱内存序）
- LL/SC：`LDXR/STXR`，带 acquire/release 版本 `LDAXR/STLXR`；失败返回标志，需循环重试。
- 内存屏障：`DMB ish`/`DSB`/`ISB` 控制可见性与排序。
- Java 映射：VarHandle 的 acquire/release 泛化到上述指令与屏障组合。

## 6. 不同锁形态的应用场景与选型

- `synchronized`：
  - 优点：语法简单，异常安全，JIT 内联友好；JDK 近年大量优化，开销显著下降。
  - 适用：绝大多数互斥场景，特别是短临界区、低到中等竞争强度。

- `ReentrantLock`：
  - 优点：可中断、可定时、可选公平，配 `Condition` 多条件队列，诊断性更强。
  - 适用：
    - 需要可中断获取（避免死等 IO）；
    - 需要定时超时放弃；
    - 需要多个条件队列；
    - 需要公平策略限制尾延时。

- `ReentrantReadWriteLock`：
  - 读多写少、读路径可并行；注意“读锁降级、写锁升级”的语义与死锁风险。

- `StampedLock`：
  - 乐观读避免锁竞态下的写者阻塞；需要二次校验，且不支持重入/条件队列，使用门槛更高。

- CAS/无锁结构：
  - 原子类（`Atomic*`）、`LongAdder/LongAccumulator`（热点分散）在高并发计数上优于单点 CAS；
  - 适用读多写少或对延迟极敏感的路径；需警惕 ABA 与活锁，必要时退避回退或限次自旋转阻塞。

## 7. 性能与可见性：几个常见问题

- 自旋与阻塞的取舍：
  - 临界区短、竞争偶发：倾向自旋（轻量级锁）；
  - 临界区长、竞争激烈：尽快阻塞，减少 CPU 浪费与抖动（重量级路径/AQS 直接 `park`）。

- 假共享（False Sharing）：
  - 计数热点应使用 `LongAdder` 或通过 `@jdk.internal.vm.annotation.Contended`（或手工填充）隔离写热点，避免不同核心在同一 cache line 争用。

- 粗细粒度：
  - 业务上首先拆分为“无共享”的并行单元；无法拆分时，优先读写分离、分段锁/哈希分片；确需全局一致时再集中化。

- 可见性与发布：
  - 共享数据通过 `volatile`/CAS/锁保护发布；避免未初始化对象逸出；
  - 使用 `final` 字段保证构造后安全发布的不可变性。

## 8. 代码片段与基准示例

### 8.1 synchronized 与 ReentrantLock 对比
```java
// synchronized 版
class CounterS {
  private int x;
  public synchronized void inc() { x++; }
  public synchronized int get() { return x; }
}

// ReentrantLock 版（可中断/可定时）
class CounterL {
  private final ReentrantLock lock = new ReentrantLock();
  private int x;
  public void inc() {
    lock.lock();
    try { x++; } finally { lock.unlock(); }
  }
  public int get() {
    lock.lock();
    try { return x; } finally { lock.unlock(); }
  }
}
```

### 8.2 LongAdder 抗热点计数
```java
LongAdder adder = new LongAdder();
// 并发线程直接 add，内部分片累加，读时汇总
adder.add(1);
long sum = adder.sum();
```

### 8.3 读写锁与条件队列
```java
class RWCache<K,V> {
  private final ReentrantReadWriteLock rw = new ReentrantReadWriteLock();
  private final Map<K,V> map = new HashMap<>();
  public V get(K k){
    rw.readLock().lock();
    try { return map.get(k);} finally { rw.readLock().unlock(); }
  }
  public void put(K k, V v){
    rw.writeLock().lock();
    try { map.put(k, v);} finally { rw.writeLock().unlock(); }
  }
}
```

## 9. 调优与诊断建议

- 观测与基准：
  - JFR（Java Flight Recorder）采集阻塞/等待事件（`Java Monitor Blocked`、`Thread Park`）。
  - Async-profiler 观察 CPU 自旋热点、`Unsafe.park` 栈分布。
  - 微基准使用 JMH，控制预热、线程数与绑定策略（pin 线程）。

- 编译与运行参数（按需验证，不做一刀切）：
  - `-XX:+UseSpinWait`：在部分 CPU 上更友好的自旋指令（如插入 PAUSE）。
  - `-XX:PreBlockSpin`（旧参数，现代 JDK 多已调整）：阻塞前自旋次数。
  - 公平锁仅在尾延迟敏感时启用，常规吞吐优先用非公平。

- 架构相关注意：
  - x86 上一般更容易获得稳定低抖动的 CAS 行为；
  - ARM 上注意弱内存序引入的可见性问题，尽量通过 `volatile`/VarHandle 语义化实现并行算法。

## 10. 关键要点回顾

- 锁信息存放在对象头的 `Mark Word` 中，随状态复用位段：无锁/轻量级/重量级（偏向锁在新 JDK 中已禁用/移除）。
- CAS 是无锁算法基石，提供原子性与 acquire-release 有序性，但需防范 ABA、活锁与高冲突热点。
- AQS 以 CLH 队列串联失败线程，统一提供独占/共享与条件队列，支撑 `ReentrantLock`/`Semaphore`/`CountDownLatch` 等。
- x86 与 ARM 的实现差异主要体现在原子指令与内存屏障上，JVM 屏蔽了差异以兑现 JMM 语义。
- 工程选型优先简单与稳定：能用 `synchronized` 就别过早引入复杂锁；计数热点用 `LongAdder`；高争用尽量结构化拆分，而不是盲目自旋。

---

附：进一步阅读
- Java Language Specification（JLS）与 Java Memory Model（JMM）章节
- Doug Lea：AQS 源码与论文
- OpenJDK JEP 374：Disable and deprecate biased locking（JDK 15）
- Java Concurrency in Practice（JCIP）

---

## 11. JIT 与锁优化：逃逸分析、锁消除、锁粗化

- 逃逸分析（Escape Analysis）：JIT 判断对象是否只在当前线程可见。若“未逃逸”，可进行标量替换、栈上分配，并消除不必要的同步。
- 锁消除（Lock Elision）：当 JIT 确认同步对象只在单线程上下文使用时，移除 `synchronized`/轻量级锁操作。
- 锁粗化（Lock Coarsening）：当热点循环中频繁短暂加解锁时，JIT 会把多次锁合并到更外层，降低加解锁频率与内存屏障开销。
- 自适应自旋（Adaptive Spinning）：JVM 依据历史竞争状况与持锁线程运行状态动态调整自旋时长（结合 `park` 切换），避免盲目自旋或过早阻塞。

工程建议：
- 不要刻意将很多微小操作拆成多个极短的同步块，给 JIT 锁粗化留下空间；
- 热路径上的锁对象尽量局部化，利于逃逸分析与消除。

## 12. AQS 的 Node 与 waitStatus 详解

AQS 同步队列是双向链表（近似 CLH 的变体），核心节点字段：

```java
static final class Node {
  // 等待状态：
  //  1 CANCELLED（已取消）
  // -1 SIGNAL（前驱释放时需要唤醒本节点）
  // -2 CONDITION（在条件队列中）
  // -3 PROPAGATE（共享模式传播）
  volatile int waitStatus;
  volatile Node prev, next;
  volatile Thread thread;
  // 标记独占/共享模式
  static final Node SHARED = new Node();
  static final Node EXCLUSIVE = null;
}
```

关键机制：
- 失败线程 CAS 入队，前驱的 `waitStatus` 置为 `SIGNAL`，当前驱释放时 `unpark` 后继；
- 取消（超时/中断）节点会被链路跳过，保持队列健康；
- 共享模式释放时使用 `PROPAGATE` 以继续唤醒后继共享获取者（如 `Semaphore`）。

## 13. JMM 内存屏障与 happens-before 速查

- 程序次序规则：同一线程内，语句按程序顺序 `hb`。
- 监视器锁：解锁 `hb` 于后续对同一锁的加锁。
- volatile：对同一变量的写 `hb` 于后续读。
- 线程启动：`Thread.start()` 之前的操作 `hb` 于 `run()` 内。
- 线程终止：线程内操作 `hb` 于检测到其终止（`join`/`isAlive` 返回 false）。
- 中断：`interrupt()` 先行于被中断线程检测到中断（`isInterrupted`/`InterruptedException`）。
- final 字段：构造函数对 `final` 字段的写 `hb` 于其他线程看到该对象引用后的读。

内存屏障类别（抽象到硬件）：
- LoadLoad, LoadStore, StoreStore, StoreLoad（其中 StoreLoad 最强，常在释放-获取边界上出现）。

## 14. 常见并发坑与对策

- 双重检查锁（DCL）缺 `volatile`：实例引用未发布完全可见，务必对实例引用使用 `volatile` 或改用静态初始化。
- 锁顺序不一致导致死锁：为多资源加锁规定全局顺序，或使用 `tryLock` 带超时与回退策略。
- 条件丢失与虚假唤醒：`await()` 后必须用 `while` 重新检查条件，不要用 `if`。
- 吞掉中断：捕获 `InterruptedException` 后应恢复中断位或按语义处理，避免“中断失效”。
- 读写混用容器：高并发下不要在无保护的 `ArrayList/HashMap` 上写入；使用并发容器或外部锁。
- 误用 `notify()`：多条件/多消费者模型优先用 `Condition`，或使用 `notifyAll()` 的同时配合条件判断。

## 15. 基准与测试建议

- JMH 微基准：
  - 使用 `@State` 控制共享程度；
  - 充分预热（`@Warmup`）与多次迭代（`@Measurement`）；
  - 使用 `Blackhole` 消除 DCE；
  - 设定不同的并发度（`@Threads`）和绑定策略（避免线程迁移）。
- 生产观测：
  - 打开 JFR 事件（Monitor Blocked、Thread Park、Java Monitor Wait）；
  - 使用 async-profiler 结合 `-e lock`/`-e cpu` 观察竞争与自旋热点；
  - 采集等待时间分布（P50/P95/P99）而非仅均值。

## 16. OS 原语映射与实现细节

- Linux：`park/unpark` → `futex(FUTEX_WAIT/FUTEX_WAKE)`；内核调度与优先级反转可能影响尾延迟（Java 层无优先级继承）。
- macOS：基于 pthread 互斥量/条件变量；休眠/唤醒路径与时钟源会影响超时精度。
- Windows：现代实现可映射到 `WaitOnAddress`/Slim Reader-Writer（SRW）等原语。

结论：不同 OS 的调度策略与时钟、唤醒延迟差异会影响 AQS/Monitor 的尾延迟特征，服务端 SLO 设计需留冗余。

## 17. 选型与落地清单（Checklist）

- 同步原语选择：
  - 首选 `synchronized`，需要可中断/多条件/定时再用 `ReentrantLock`；
  - 读多写少：`ReentrantReadWriteLock` 或 `StampedLock`（谨慎使用）；
  - 计数热点：`LongAdder` 优于单点 `AtomicLong`；
  - 信号量/门闩：`Semaphore`/`CountDownLatch`，或升级 `Phaser`。
- 结构性优化：
  - 尽量无共享或分片（sharding）；
  - 降低持锁时间（IO/阻塞移出临界区）；
  - 缓存与批处理减少锁竞争频率。
- 诊断运维：
  - 监控阻塞时长与争用次数；
  - 采集线程栈与锁持有者；
  - 压测覆盖极端并发与抖动场景。


