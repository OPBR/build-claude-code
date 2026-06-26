# 14 - Cron Scheduler

## 学习目标

- 理解 cron 定时调度要解决的核心问题：Agent 只能被动响应，不能按时主动执行
- 理解 cron 表达式：5-field 语法、`*`/`*/N`/`N`/`N-M`/`N,M` 五种匹配规则、DOM/DOW OR 语义
- 理解四层解耦架构：Scheduler → Queue → Queue Processor → Consumer
- 实现 `CronJob` 数据结构 — id/cron/prompt/recurring/durable 五个字段各司其职
- 实现 `cronFieldMatches()` — 单字段匹配，5 种语法递归解析
- 实现 `cronMatches()` — 5 字段整体匹配，DOM/DOW OR 语义
- 实现 `validateCron()` — 注册前校验 + 加载时校验
- 实现 `CronManager` 类 — 注册/取消/触发/消费/持久化/防重复触发
- 理解 minuteMarker 防重复触发机制 — 同一分钟只触发一次，跨天也正确
- 理解双源 Queue Processor — background + cron 共用一个定时器
- 理解 durable 持久化 — `.scheduled_tasks.json` 跨重启恢复
- 实现 3 个新工具：schedule_cron / list_crons / cancel_cron
- 理解 Node.js 单线程无需锁 vs Python threading.Lock 的并发差异

## 核心概念

### 问题背景

到 s13，Agent 已经具备：循环（s01）、工具（s02）、规划（s03+s12）、子代理（s04）、压缩（s06）、权限（s07）、Hook（s08）、记忆（s09）、提示词（s10）、错误恢复（s11）、任务系统（s12）、后台执行（s13）。

但有一个能力缺失：**Agent 只能被动响应，不能按时主动执行。**

```text
用户："每5分钟帮我检查一下 CI 跑完没有"

真实 Claude Code（有 cron 调度）：
  注册定时任务 → 每5分钟自动触发 → Agent 自动检查 → CI 通过后取消任务

我们的项目（s13，没有 cron 调度）：
  用户必须每5分钟手动说"检查一下CI" → Agent 才会执行
  → 人必须盯着，Agent 不会自己定时做事
```

`npm install` 可以丢后台，但"5分钟后检查CI"丢不了后台——因为现在不是执行的时候，而是**未来某个时间点**才执行。这是完全不同的问题。

### cron 表达式基础

cron 来自 Unix 系统，名字源于希腊语 "chronos"（时间），1975 年诞生。用一个表达式描述触发时间：

```text
┌───────────── 分钟 (0-59)
│ ┌───────────── 小时 (0-23)
│ │ ┌───────────── 日 (1-31)
│ │ │ ┌───────────── 月 (1-12)
│ │ │ │ ┌───────────── 星期 (0-6, 0=周日)
│ │ │ │ │
* * * * *
```

每个字段支持 5 种语法：

| 语法  | 含义       | 例子            | 匹配值                 |
| ----- | ---------- | --------------- | ---------------------- |
| `*`   | 匹配所有值 | 分钟位的 `*`    | 每分钟                 |
| `*/N` | 每隔 N     | 分钟位的 `*/5`  | 0,5,10,15,...          |
| `N`   | 具体值     | 小时位的 `9`    | 只匹配 9               |
| `N-M` | 范围       | 星期位的 `1-5`  | 1,2,3,4,5 (周一到周五) |
| `N,M` | 列表       | 小时位的 `9,18` | 匹配 9 或 18           |

常见例子：

| 表达式         | 含义          |
| -------------- | ------------- |
| `* * * * *`    | 每分钟        |
| `*/5 * * * *`  | 每 5 分钟     |
| `0 9 * * *`    | 每天 9:00     |
| `0 9 * * 1-5`  | 工作日 9:00   |
| `0 */2 * * *`  | 每 2 小时     |
| `0 9,18 * * *` | 9:00 和 18:00 |

**DOM/DOW OR 语义**：当"日"和"星期"都指定了具体值（都不是 `*`）时，标准 cron 用 OR——任一满足就触发。`0 0 1 * 1` = 每月1号 **或** 每个周一的零点，不是"每月1号且是周一"。

四种情况：

| 日字段 | 星期字段 | 语义               |
| ------ | -------- | ------------------ |
| `*`    | `*`      | 没约束，直接匹配   |
| `*`    | `1-5`    | 只看星期           |
| `1`    | `*`      | 只看日             |
| `1`    | `1-5`    | 日匹配 OR 星期匹配 |

**为什么不用 setTimeout/setInterval？**

| 方案          | 能描述"每天9点"吗？ | 能描述"工作日9点"吗？ | 能持久化吗？ | 能动态增删吗？ |
| ------------- | ------------------- | --------------------- | ------------ | -------------- |
| `setTimeout`  | ❌ 只能说"8小时后"  | ❌                    | ❌           | ❌             |
| `setInterval` | ❌ 只能说"每24小时" | ❌                    | ❌           | ❌             |
| cron 表达式   | ✅ `0 9 * * *`      | ✅ `0 9 * * 1-5`      | ✅           | ✅             |

### 解决方案

> **"Agent 不应该只会被动响应，还要能按时间表主动执行。"**

四层解耦架构：

```text
┌─────────────────────────────────────────────────┐
│  Layer 1: Scheduler (时钟/闹钟)                  │
│  每秒检查时间 → 匹配的 job 入队                   │
│  ↓ cron_queue                                    │
├─────────────────────────────────────────────────┤
│  Layer 2: Queue (闹钟铃声)                       │
│  解耦 scheduler 和 agent loop                    │
│  ↓                                               │
├─────────────────────────────────────────────────┤
│  Layer 3: Queue Processor (你的耳朵)             │
│  Agent 空闲时，从队列取任务 → 启动 agent turn     │
│  ↓                                               │
├─────────────────────────────────────────────────┤
│  Layer 4: Consumer (你的大脑)                    │
│  agent turn 内消费队列 → 注入为 user 消息         │
└─────────────────────────────────────────────────┘
```

**为什么需要四层？** scheduler 每秒检查时间，agent loop 可能正在执行耗时工具调用。两者运行在不同时间维度，直接调用会冲突。队列是缓冲区——scheduler 只管往里扔，agent 有空了再来取。

---

## CronJob 数据结构

```typescript
export interface CronJob {
  id: string // "cron_XXXXXX"，随机6位数字
  cron: string // "0 9 * * *" (5-field: min hour dom month dow)
  prompt: string // 触发时注入给 Agent 的消息
  recurring: boolean // true=周期性，false=一次性（触发后自动删除）
  durable: boolean // true=写磁盘 .scheduled_tasks.json，跨重启恢复
}
```

5 个字段各司其职：

- **id**：注册后返回给 LLM，后续取消/列表用
- **cron**：决定"什么时候触发"
- **prompt**：决定"触发后做什么"
- **recurring**：周期性 vs 一次性。一次性触发后自动删除
- **durable**：持久化 vs 会话级。durable 写磁盘，跨重启恢复

`recurring` 和 `durable` 是两个独立维度，四种组合都有用途：

| recurring | durable | 场景                              |
| --------- | ------- | --------------------------------- |
| true      | true    | 每天检查部署（重启也不丢）        |
| true      | false   | 临时每5分钟轮询CI（重启就算了）   |
| false     | true    | 3小时后检查部署（重要，不能丢）   |
| false     | false   | 1分钟后提醒喝水（临时，丢了没事） |

---

## cron 匹配函数

### cronFieldMatches：单字段匹配

5-field cron 每个字段都是独立的匹配规则，`cronFieldMatches` 负责解析单个规则并判断是否匹配：

```typescript
export function cronFieldMatches(field: string, value: number): boolean {
  // 1. "*" → 匹配所有值
  if (field === '*') return true

  // 2. "*/N" → 值能被 N 整除就匹配
  if (field.startsWith('*/')) {
    const step = parseInt(field.slice(2), 10)
    return step > 0 && value % step === 0
  }

  // 3. "N,M,..." → 列表，逗号分隔的每个子项独立匹配
  if (field.includes(',')) {
    return field.split(',').some((f) => cronFieldMatches(f.trim(), value))
  }

  // 4. "N-M" → 范围，从 N 到 M 的所有值都匹配
  if (field.includes('-')) {
    const [lo, hi] = field.split('-', 2).map(Number)
    return lo <= value && value <= hi
  }

  // 5. "N" → 具体值，只有等于 N 才匹配
  return value === parseInt(field, 10)
}
```

**解析顺序：逗号 → 范围 → 具体值。** 逗号优先级最高，`"1-5,10"` 先按逗号拆成 `"1-5"` 和 `"10"`，再递归调用 `cronFieldMatches` 匹配。

**`*/N` 要求 `step > 0`：** 防止 `*/0`。`value % 0` 在 JS 里返回 `NaN`，虽然结果也是 false，但显式检查更安全。

**`*` 和 `*/1` 等价：** `*` 匹配所有值；`*/1` 中任何数 `% 1 === 0`，也是匹配所有值。`*` 更简洁是标准写法。

### cronMatches：5 字段整体匹配

```typescript
export function cronMatches(cronExpr: string, now: Date): boolean {
  const fields = cronExpr.trim().split(/\s+/)
  if (fields.length !== 5) return false

  const [minute, hour, dom, month, dow] = fields

  // 分钟、小时、月：AND 关系，必须全部匹配
  if (!cronFieldMatches(minute, now.getMinutes())) return false
  if (!cronFieldMatches(hour, now.getHours())) return false
  if (!cronFieldMatches(month, now.getMonth() + 1)) return false

  // 日和星期：OR 语义
  const domOk = cronFieldMatches(dom, now.getDate())
  const dowOk = cronFieldMatches(dow, now.getDay())
  const domUnconstrained = dom === '*'
  const dowUnconstrained = dow === '*'

  if (domUnconstrained && dowUnconstrained) return true
  if (domUnconstrained) return dowOk
  if (dowUnconstrained) return domOk
  return domOk || dowOk // 两者都约束：OR
}
```

**JS vs Python 日期差异：**

| 字段 | Python            | JavaScript             | 转换                           |
| ---- | ----------------- | ---------------------- | ------------------------------ |
| 星期 | `weekday()` Mon=0 | `getDay()` Sun=0       | Python 需 `(w+1)%7`，JS 直接用 |
| 月   | `month` 1-indexed | `getMonth()` 0-indexed | JS 需要 `getMonth()+1`         |

---

## cron 校验函数

匹配是"给定时间判断是否触发"，校验是"给定表达式判断是否合法"。

```typescript
export function validateCron(cronExpr: string): string | null {
  const fields = cronExpr.trim().split(/\s+/)
  if (fields.length !== 5) return `Expected 5 fields, got ${fields.length}`

  const bounds: [number, number][] = [
    [0, 59], // 分钟
    [0, 23], // 小时
    [1, 31], // 日
    [1, 12], // 月
    [0, 6], // 星期
  ]
  const names = ['minute', 'hour', 'day-of-month', 'month', 'day-of-week']

  for (let i = 0; i < 5; i++) {
    const err = validateCronField(fields[i], bounds[i][0], bounds[i][1])
    if (err) return `${names[i]}: ${err}`
  }
  return null // null = 合法
}
```

`validateCronField` 是递归的——遇到逗号时，对每个子项递归调用自身。`"1-5,10"` 中的 `"1-5"` 和 `"10"` 都被独立校验范围。

**两处使用：**

1. **注册时**：`scheduleJob` 先 `validateCron`，非法表达式直接拒绝
2. **加载时**：`loadDurable` 从磁盘加载后重新校验，非法的跳过（磁盘数据可能过期或损坏）

---

## CronManager

### 内部状态

```typescript
export class CronManager {
  private jobs: Map<string, CronJob> = new Map() // job_id → CronJob
  private queue: CronJob[] = [] // 已触发、待交付的任务
  private lastFired: Map<string, string> = new Map() // job_id → "YYYY-MM-DD HH:MM"
}
```

- `jobs`：所有注册的任务
- `queue`：已触发、等待 Agent 处理的任务（scheduler 写，consumer 读）
- `lastFired`：每个任务上次触发的分钟标记（防重复触发）

### scheduleJob

```typescript
scheduleJob(cron: string, prompt: string, recurring = true, durable = true): CronJob | string {
  const err = validateCron(cron)
  if (err) return err  // 返回 string = 失败

  const job: CronJob = {
    id: `cron_${Math.floor(Math.random() * 1000000).toString().padStart(6, '0')}`,
    cron, prompt, recurring, durable,
  }

  this.jobs.set(job.id, job)
  if (durable) this.saveDurable()  // durable 的立即写磁盘
  return job  // 返回 CronJob = 成功
}
```

返回联合类型 `CronJob | string`，调用方用 `typeof result === 'string'` 区分。

### fireJob

```typescript
fireJob(jobId: string, minuteMarker: string): void {
  const job = this.jobs.get(jobId)
  if (!job) return
  this.queue.push(job)                    // 入队
  this.lastFired.set(jobId, minuteMarker)  // 记录触发时间

  // 一次性任务：触发后自动删除
  if (!job.recurring) {
    this.jobs.delete(jobId)
    if (job.durable) this.saveDurable()
  }
}
```

一次性任务的自动删除在这里——触发后从 `jobs` 里删掉，下次 scheduler 检查时不会再匹配。

### consumeQueue

```typescript
consumeQueue(): CronJob[] {
  const fired = [...this.queue]  // 复制一份
  this.queue.length = 0          // 清空原数组
  return fired
}
```

**交付即清空**——消费后队列立刻清空，不会重复交付。和 s13 的 `collectResults` 一个思路。

### 防重复触发：minuteMarker

scheduler 每秒检查时间。`"0 9 * * *"` 在 9:00:00 到 9:00:59 都匹配，不做防护会触发 60 次。

```typescript
// "YYYY-MM-DD HH:MM" 格式
const minuteMarker = formatMinuteMarker(now)

// 同一分钟内只触发一次
if (lastFired !== minuteMarker) {
  cronManager.fireJob(job.id, minuteMarker)
}
```

**为什么用 `"YYYY-MM-DD HH:MM"` 而不是 `"HH:MM"`？**

如果 marker 只是 `"00:00"`，第一天零点触发后 `lastFired = "00:00"`，第二天零点时 `lastFired` 还是 `"00:00"`，条件 `!==` 不满足，第二天就不会触发。加上日期部分，每天的 marker 不同，跨天正确。

### 持久化

```typescript
saveDurable(): void {
  const durable = [...this.jobs.values()].filter((j) => j.durable)
  fs.writeFileSync(DURABLE_PATH, JSON.stringify(durable, null, 2), 'utf-8')
}

loadDurable(): number {
  if (!fs.existsSync(DURABLE_PATH)) return 0
  try {
    const data = JSON.parse(fs.readFileSync(DURABLE_PATH, 'utf-8'))
    let count = 0
    for (const j of data) {
      const job: CronJob = { id: j.id, cron: j.cron, prompt: j.prompt,
                             recurring: j.recurring, durable: j.durable }
      const err = validateCron(job.cron)  // 加载时也校验！
      if (err) {
        console.log(`[cron] skipping invalid job ${job.id}: ${err}`)
        continue  // 跳过非法的，不崩
      }
      this.jobs.set(job.id, job)
      count++
    }
    return count
  } catch {
    return 0  // 文件损坏也不崩
  }
}
```

两个安全措施：

1. **加载时校验**：磁盘数据可能过期或损坏，重新 `validateCron`，非法的跳过
2. **try-catch 兜底**：JSON 解析失败、文件读不到——都不崩，返回 0

---

## 三个新工具

### 工具定义

```typescript
export const CRON_TOOLS: ToolDefinition[] = [
  {
    name: 'schedule_cron',
    description: 'Schedule a cron job. cron is 5-field: min hour dom month dow.',
    input_schema: {
      type: 'object',
      properties: {
        cron: { type: 'string', description: '5-field cron expression' },
        prompt: { type: 'string', description: 'Message to inject when fired' },
        recurring: { type: 'boolean', description: 'True=recurring, False=one-shot' },
        durable: { type: 'boolean', description: 'True=persist to disk' },
      },
      required: ['cron', 'prompt'],
    },
  },
  {
    name: 'list_crons',
    description: 'List all registered cron jobs.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'cancel_cron',
    description: 'Cancel a cron job by ID.',
    input_schema: {
      type: 'object',
      properties: { job_id: { type: 'string', description: 'The cron job ID to cancel' } },
      required: ['job_id'],
    },
  },
]
```

### 工具 Handlers

```typescript
export function createCronHandlers(cronManager: CronManager): Record<string, ToolHandler> {
  return {
    schedule_cron: (input) => {
      const result = cronManager.scheduleJob(
        input.cron as string,
        input.prompt as string,
        (input.recurring as boolean) ?? true,
        (input.durable as boolean) ?? true,
      )
      if (typeof result === 'string') return `Error: ${result}`
      return `Scheduled ${result.id}: '${result.cron}' → ${result.prompt}`
    },

    list_crons: () => {
      const jobs = cronManager.listJobs()
      if (jobs.length === 0) return 'No cron jobs. Use schedule_cron to add one.'
      return jobs
        .map((j) => {
          const tag = j.recurring ? 'recurring' : 'one-shot'
          const dur = j.durable ? 'durable' : 'session'
          return `  ${j.id}: '${j.cron}' → ${j.prompt.slice(0, 40)} [${tag}, ${dur}]`
        })
        .join('\n')
    },

    cancel_cron: (input) => {
      return cronManager.cancelJob(input.job_id as string)
    },
  }
}
```

`createCronHandlers` 工厂函数和 `createTaskHandlers` 模式一致——接收 manager 实例，返回 handler 映射表。

---

## Session 集成

s14 的 session 文件在 s13 基础上改了 6 个地方。

### 改动 1：SessionContext 增加 cronManager

```typescript
interface SessionContext {
  // ... s13 原有字段 ...
  cronManager: CronManager // ← 新增
  cronTimer: NodeJS.Timeout | null // ← 新增（scheduler 1s 定时器引用）
}
```

### 改动 2：双源 Queue Processor

s13 只看后台完成，s14 变成双源：

```typescript
function processQueue(ctx: SessionContext): void {
  if (!ctx.isIdle()) return
  // 双源：后台完成 或 cron 队列有任务
  if (!ctx.bgManager.hasCompleted() && !ctx.cronManager.hasQueue()) return
  ctx.setBusy()
  runAgentTurn(ctx).then(() => {
    ctx.setIdle()
    ctx.checkQueueStop()
  })
}
```

### 改动 3：Agent Turn 内双源注入

```typescript
async function runAgentTurn(ctx: SessionContext): Promise<void> {
  // 两种通知合并为一条 user 消息
  const notifications = ctx.bgManager.collectResults() // 后台完成
  const firedJobs = ctx.cronManager.consumeQueue() // cron 触发

  if (notifications.length > 0 || firedJobs.length > 0) {
    const parts: string[] = []
    for (const notif of notifications) parts.push(notif)
    for (const job of firedJobs) {
      parts.push(`[Scheduled] ${job.prompt}`) // cron 用 [Scheduled] 前缀
    }
    ctx.history.push({ role: 'user', content: parts.join('\n') })
  }
  // ... 后续 LLM 调用 ...
}
```

cron 触发的消息格式是 `[Scheduled] {prompt}`，让模型区分这是定时任务触发的事件。

### 改动 4：Cron Scheduler 定时器

```typescript
cronTimer = setInterval(() => {
  const now = new Date()
  const minuteMarker = formatMinuteMarker(now)

  for (const job of cronManager.listJobs()) {
    try {
      if (cronMatches(job.cron, now)) {
        const lastFired = cronManager.getLastFired(job.id)
        if (lastFired !== minuteMarker) {
          cronManager.fireJob(job.id, minuteMarker)
          ensureQueue() // 有 cron 任务触发了，确保 queue processor 在跑
        }
      }
    } catch (e) {
      console.log(`[cron error] ${job.id}: ${(e as Error).message}`)
    }
  }
}, 1000)
```

三个关键点：

1. **每秒检查**：1 秒精度对 cron 足够（最小粒度是分钟）
2. **minuteMarker 防重复**：同一分钟内只触发一次
3. **try-catch 包裹**：单个 job 报错不影响其他 job，不会崩定时器

### 改动 5：checkQueueStop 增加第三条件

s13 检查两种不停条件，s14 增加第三种：

```typescript
const checkQueueStop = () => {
  if (!queueTimer) return
  if (bgManager.listRunning().length > 0) return // ① 还有运行中的后台任务
  if (bgManager.hasCompleted()) return // ② 还有未交付的后台通知
  if (cronManager.hasQueue()) return // ③ 还有未交付的 cron 任务 ← 新增
  clearInterval(queueTimer)
  queueTimer = null
}
```

### 改动 6：清理退出

```typescript
if (queueTimer) clearInterval(queueTimer)
if (cronTimer) clearInterval(cronTimer) // ← 新增
rl.close()
```

---

## 完整流程

```text
┌──────────────────────────── Cron Scheduler（每 1 秒）────────────────────────────┐
│                                                                                    │
│   now = new Date()                                                                 │
│   minuteMarker = "2026-06-25 14:35"                                               │
│                                                                                    │
│   for each job of cronManager.listJobs():                                          │
│     │                                                                              │
│     ▼                                                                              │
│   ┌──────────────┐                                                                 │
│   │ cronMatches  │──── 不匹配 ──→ 跳过                                            │
│   │(job.cron,now)│                                                                 │
│   └──────┬───────┘                                                                 │
│          │ 匹配 ✓                                                                  │
│          ▼                                                                          │
│   ┌──────────────────┐                                                             │
│   │   lastFired      │──── 同一分钟 ──→ 跳过（防重复触发）                         │
│   │ !== minuteMarker │                                                             │
│   └────────┬─────────┘                                                             │
│            │ 未触发过 ✓                                                             │
│            ▼                                                                        │
│   cronManager.fireJob(jobId, minuteMarker)                                          │
│     ① queue.push(job)                                                              │
│     ② lastFired.set(id, minuteMarker)                                              │
│     ③ !recurring → jobs.delete() + saveDurable()                                   │
│            │                                                                        │
│            ▼                                                                        │
│   ensureQueue()  ──→ 启动 Queue Processor                                          │
│                                                                                    │
└────────────────────────────────────────────────────────────────────────────────────┘
         │
         │  cron_queue
         ▼
┌──────────────────────────── Queue Processor（每 500ms）───────────────────────────┐
│                                                                                    │
│   ┌─────────┐                                                                      │
│   │ isIdle? │──── 忙 ──→ return                                                    │
│   └────┬────┘                                                                      │
│        │ 空闲 ✓                                                                    │
│        ▼                                                                            │
│   ┌──────────────────────────────┐                                                 │
│   │         双源检查              │──── 都没有 ──→ return                           │
│   │ bgManager.hasCompleted()     │                                                 │
│   │   || cronManager.hasQueue()? │                                                 │
│   └──────────────┬───────────────┘                                                 │
│                  │ 有工作 ✓                                                         │
│                  ▼                                                                  │
│   setBusy() → runAgentTurn() → setIdle() → checkQueueStop()                       │
│                                                                                    │
│   checkQueueStop 三种不停：                                                         │
│     ① bgManager.listRunning().length > 0  （还有运行中的后台任务）                   │
│     ② bgManager.hasCompleted()             （还有未交付的后台通知）                   │
│     ③ cronManager.hasQueue()               （还有未交付的 cron 任务）                │
│   全部不满足 → clearInterval(queueTimer)                                            │
│                                                                                    │
└────────────────────────────────────────────────────────────────────────────────────┘
         │
         │  触发 Agent Turn
         ▼
┌──────────────────────────── Agent Turn（Consumer）────────────────────────────────┐
│                                                                                    │
│   ① notifications = bgManager.collectResults()     ← 后台完成通知                 │
│   ② firedJobs    = cronManager.consumeQueue()      ← cron 触发通知                │
│   ③ 合并注入为 user 消息：                                                         │
│        后台 → <task_notification>...</task_notification>                            │
│        Cron → [Scheduled] {job.prompt}                                             │
│                                                                                    │
│   ④ while (true):                                                                  │
│        LLM 调用 → 收到 tool_use blocks                                             │
│          │                                                                         │
│          ├── shouldRunBackground? ──→ spawn 子进程 → 占位 tool_result             │
│          │                              → ensureQueue()                            │
│          │                                                                         │
│          └── 否 ──→ handler 同步执行 → 正常 tool_result                            │
│                                                                                    │
│        工具执行后再次收集通知（双时机）：                                            │
│          bgNotifications = bgManager.collectResults()                               │
│          → results.unshift(通知)                                                    │
│                                                                                    │
│        push results to history                                                     │
│        stop_reason !== "tool_use" → break                                          │
│                                                                                    │
│   ⑤ 结束 → setIdle() → checkQueueStop() → 回到 "s14 >> " 提示符                  │
│                                                                                    │
└────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 与原项目的差异

| 维度            | 原项目 s14 (Python)                       | 我们 s14 (TypeScript)                         | 说明                      |
| --------------- | ----------------------------------------- | --------------------------------------------- | ------------------------- |
| 并发控制        | `threading.Lock` + `agent_lock`           | `agentBusy` 布尔值                            | Node.js 单线程无需锁      |
| Scheduler       | `threading.Thread(daemon=True)`           | `setInterval(1000)`                           | 1s 定时器代替 daemon 线程 |
| Queue Processor | 独立 daemon thread, 200ms poll            | `setInterval(500)`                            | 500ms 定时器              |
| 全局状态        | 模块级变量 `scheduled_jobs` 等            | `CronManager` 类封装                          | 避免全局状态污染          |
| DOW 转换        | `(weekday+1) % 7`                         | `getDay()` 直接用                             | JS Sunday=0 和 cron 一致  |
| Month 转换      | 1-indexed 直接用                          | `getMonth()+1`                                | JS 0-indexed 需要 +1      |
| 持久化路径      | `Path(WORKDIR) / ".scheduled_tasks.json"` | `path.join(WORKDIR, ".scheduled_tasks.json")` | 逻辑一致                  |

---

## 与其他章节的关系

| 章节            | 关系                                                                 |
| --------------- | -------------------------------------------------------------------- |
| s02 Tool Use    | s14 新增 3 个 cron 工具（schedule_cron/list_crons/cancel_cron）      |
| s12 Task System | s14 复用任务工具，定时任务可结合任务系统使用                         |
| s13 Background  | s14 依赖 s13 的后台执行能力，Queue Processor 升级为双源（bg + cron） |
| s15 Agent Teams | s15 多代理通信可结合 cron 定时触发                                   |

---

## 文件清单

| 文件                                 | 内容                                                                                                      |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `src/persistence/cron.ts`            | CronJob 接口、cronFieldMatches、cronMatches、validateCron、CronManager 类、CRON_TOOLS、createCronHandlers |
| `src/sessions/s14-cron-scheduler.ts` | REPL 入口 + SessionContext + 双源 Queue Processor + Cron Scheduler 定时器 + runAgentTurn                  |

---

## 关键常量

| 常量           | 值                      | 说明                     |
| -------------- | ----------------------- | ------------------------ |
| Cron interval  | 1000ms                  | Cron Scheduler 检查间隔  |
| Queue interval | 500ms                   | Queue Processor 检查间隔 |
| DURABLE_PATH   | `.scheduled_tasks.json` | durable 任务持久化路径   |
| job id 格式    | `cron_XXXXXX`           | 随机 6 位数字            |

---

## 测试

```bash
pnpm s14
```

### 测试场景

1. **周期性任务**：`每1分钟告诉我现在几点了` — 观察注册 cron 任务，等 1 分钟后 Agent 自动被唤醒
2. **一次性提醒**：`1分钟后提醒我喝咖啡` — 观察设置 recurring=false，触发后自动删除，不再触发
3. **查看状态**：`/status` — 显示 Tasks + Background + Cron 三块状态
4. **取消任务**：`取消 cron_XXXXXX`（先用 `/status` 查 job_id） — Agent 调用 cancel_cron
5. **cron + 后台配合**：`每5分钟后台执行一次 echo hello，同时告诉我当前时间` — cron 触发后 Agent 同时发后台命令和同步命令
6. **durable 持久化**：注册 durable 任务 → `q` 退出 → `pnpm s14` 重启 → 观察启动日志 `[cron] loaded N durable job(s)` → `/status` 确认任务还在

### 验证重点

- cron 表达式是否正确匹配？（修改 cron 表达式测试不同语法）
- 同一分钟内是否只触发一次？（minuteMarker 防重复）
- 一次性任务触发后是否自动删除？
- 双源 Queue Processor 是否正常工作？（后台完成 + cron 触发都能唤醒 Agent）
- Agent 忙时 cron 触发是否会排队等空闲后处理？
- durable 任务重启后是否正确恢复？
- checkQueueStop 三个条件是否都不满足时才停定时器？
- 退出时两个定时器（queueTimer + cronTimer）是否都清理？
