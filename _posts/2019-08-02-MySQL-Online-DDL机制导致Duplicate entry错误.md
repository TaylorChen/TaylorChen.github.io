---
title: "MySQL Online DDL机制导致"
date: 2019-08-02
categories: [技术 , MySQL]
description: "解析 Online DDL row log 重放机制为何会触发 Duplicate entry，给出时间线、源码指引与工程上的可行规避策略（低峰变更/EXCLUSIVE/分阶段变更）。"
tags: [技术, MySQL, Online DDL, 唯一键, 重放]
---
# MySQL Online DDL机制导致"Duplicate entry”错误的分析

## 问题场景精准定位

您描述的场景非常典型：
- 手机号字段**早已存在**唯一索引
- 原表中该手机号记录**早已存在**（"很早以前就存在数据库中"）
- 应用程序**正确使用**`INSERT ... ON DUPLICATE KEY UPDATE`
- 问题发生在**执行非唯一索引相关的DDL操作**时（如修改其他字段）

这正是阿里云文档中提到的第三种场景："使用结构设计功能进行不涉及唯一约束或唯一索引组成字段调整的DDL操作"时出现的冲突。

## 核心问题：Online DDL的row log重放机制

### 1. MySQL Online DDL执行流程（关键阶段）

当执行一个不涉及唯一索引的DDL操作（如修改其他字段）时，MySQL的Online DDL流程如下：

```
T0: 开始DDL，创建中间表(#sql-ibxxx)
T1: 将原表数据复制到中间表（此时中间表已包含phone='xxxxx'）
T2: 开始记录DML变更到row log
T3: 应用程序执行INSERT ... ON DUPLICATE KEY UPDATE
T4: 将row log中的变更应用到中间表
T5: 原子替换原表与中间表
```

### 2. 问题发生的精确技术原因

**关键点：row log记录的是原始SQL操作，而非实际执行的操作**

当应用程序执行：
```sql
INSERT INTO users(phone, name) VALUES('xxxxx', '张三') 
ON DUPLICATE KEY UPDATE name = '张三';
```

MySQL的处理流程：
1. 检测到唯一键冲突（phone='xxxxx'已存在）
2. **将INSERT操作内部转换为UPDATE操作**
3. 执行UPDATE，成功完成

**但是**，在Online DDL过程中：
- MySQL的row log**只记录原始SQL语句**（INSERT...）
- **不记录**MySQL内部将其转换为UPDATE的事实
- 当重放row log到中间表时，MySQL会**直接执行原始的INSERT语句**

### 3. 冲突发生的具体时间线

```
T0: 开始DDL，创建中间表
T1: 中间表从原表复制数据（已包含phone='xxxxx'）
T2: 开始记录row log
T3: 应用程序执行INSERT ... ON DUPLICATE KEY UPDATE
    - 原表：检测到冲突，自动转为UPDATE，成功
    - row log记录：INSERT INTO ... VALUES('xxxxx', ...)
T4: DDL尝试将row log应用到中间表
    - 中间表：已从T1复制拥有phone='xxxxx'的记录
    - 执行INSERT操作 → 触发Duplicate entry错误
T5: DDL操作失败
```

## 为什么INSERT ... ON DUPLICATE KEY UPDATE在这种场景下失效？

### 1. 执行环境差异

| 环境 | 处理方式 | 结果 |
|------|---------|------|
| **正常执行环境** | MySQL解析并执行完整SQL，识别ON DUPLICATE子句 | INSERT转为UPDATE，无错误 |
| **Online DDL row log重放** | 仅执行row log中记录的原始INSERT语句 | 直接尝试插入，忽略ON DUPLICATE逻辑 |

### 2. 技术本质：row log的局限性

MySQL的row log机制设计用于**高效记录和重放DML操作**，但有重要限制：
- **只记录物理操作**，不记录SQL语义
- **不保存执行上下文**（如唯一键检查结果）
- **不考虑约束触发的隐式操作转换**

当MySQL执行`INSERT ... ON DUPLICATE KEY UPDATE`时，这是一个**逻辑操作**，会被转换为**物理操作**（UPDATE）。但row log只记录了最初的逻辑操作（INSERT），没有记录最终的物理操作（UPDATE）。

### 3. 中间表状态与原表状态的差异

在T1到T4期间，原表和中间表的状态可能不同步：
- 原表：通过ON DUPLICATE KEY机制成功处理了冲突
- 中间表：没有机会执行相同的逻辑转换
- 当直接应用原始INSERT时，中间表严格检查唯一约束，导致失败

## MySQL底层源码级分析

在MySQL源码中，这一问题的根源在于：

1. **sql/ha_innobase.cc**中的`row_log_apply`函数：
   - 处理row log重放时，直接执行记录的原始操作
   - 不会重新解析SQL或应用任何约束转换逻辑

2. **sql/sql_insert.cc**中的`mysql_insert`函数：
   - 在正常执行路径中，会调用`handle_duplicates`处理唯一键冲突
   - 但在row log重放路径中，绕过了这一逻辑

3. **row/row0log.cc**中的row log机制：
   - 仅记录最基础的行变更（INSERT/UPDATE/DELETE）
   - 不记录高级SQL语句的语义信息

## 为什么高并发会加剧这个问题？

1. **row log积压**：高并发下，T1到T4之间会产生大量DML操作，row log变大
2. **状态差异扩大**：原表与中间表的状态差异随时间推移而增大
3. **重放复杂度增加**：更多操作需要重放，冲突概率呈指数级增长

## 解决方案的技术本质

### 1. 根本原因
- MySQL Online DDL的row log机制无法正确处理`ON DUPLICATE KEY`语句
- row log记录的是原始SQL，而非实际执行的物理操作

### 2. 有效解决方案

#### 方案A：避免在业务高峰期执行DDL
- 选择低峰期执行DDL操作，减少row log积压
- 降低原表与中间表状态差异

#### 方案B：使用LOCK=EXCLUSIVE
```sql
ALTER TABLE users MODIFY COLUMN age INT COMMENT '年龄' LOCK=EXCLUSIVE;
```
- 完全阻塞DML操作，确保数据一致性
- 代价：DDL执行期间表不可写

#### 方案C：分阶段执行（最佳实践）
1. 先添加新列（不修改原列）
2. 应用程序双写新旧列
3. 数据迁移完成后，再删除旧列
- 避免长时间Online DDL操作
- 减少冲突窗口期

### 3. 为什么"先查询再插入"无效？
即使应用程序改为：
```sql
SELECT * FROM users WHERE phone='xxxxx';
-- 如果存在则UPDATE，否则INSERT
```
在Online DDL期间：
- SELECT可能在T1前执行，看到记录存在
- 但INSERT/UPDATE操作在T2后执行
- row log重放时仍会尝试插入已存在的记录

## 结论

1. **技术本质**：MySQL Online DDL的row log机制**无法正确处理`INSERT ... ON DUPLICATE KEY UPDATE`语句**，因为它只记录原始INSERT语句，不记录MySQL内部将其转换为UPDATE的事实。

2. **问题根源**：当row log中的原始INSERT语句被应用到中间表时，中间表已通过数据复制拥有相同唯一键的记录，导致严格唯一性检查失败。

3. **这不是应用程序错误**：即使应用程序正确使用了`ON DUPLICATE KEY`，在Online DDL过程中仍会失败，这是MySQL底层机制的限制。

4. **解决方案**：避免在高并发期间执行DDL操作，或使用LOCK=EXCLUSIVE强制串行化，或采用分阶段变更策略。