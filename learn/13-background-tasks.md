# 13 - Background Tasks

## 学习目标

- 理解后台任务要解决的核心问题：慢操作阻塞主循环，Agent 傻等
- 理解两层判断策略：显式请求优先（run_in_background），启发式关键词兜底
- 实现 `BackgroundManager` 类 — spawn 子进程后台执行 + 生命周期追踪
- 实现 `shouldRunBackground()` — 两层决策
- 实现 `startTask()` — spawn 子进程 + 输出收集 + 状态标记
- 实现 `collectResults()` — 通知格式化 + 交付即清理
- 实现 `hasCompleted()` — Queue Processor 判断是否有待交付通知
- 理解 Queue Processor 主动推送机制 vs 被动收集
- 理解 SessionContext 设计 — 运行状态打包成统一对象
- 理解并发保护 — agentBusy 标志防止两个 turn 同时跑
- 理解 checkQueueStop 的三个条件 — 防 notification 丢失 bug
- 理解通知注入的两个时机 — turn 开始 + 工具执行后
- 理解占位 tool_result 的设计 — 模型知道"先干别的"

## 核心概念

### 问题背景

到 s12，Agent 已经具备：循环（s01）、工具（s02）、规划（s03+s12）、子代理（s04）、压缩（s06）、权限（s07）、Hook（s08）、记忆（s09）、提示词（s10）、错误恢复（s11）、任务系统（s12）。

但有一个效率问题没解决：**慢操作阻塞主循环。**

```text
用户："先 npm install，然后看一下 package.json 有什么依赖"

真实 Claude Code（有后台任务）：
  npm install → 自动后台执行 → Agent 同时读 package.json → 后台完成后自动通知

我们的项目（s12，没有后台任务）：
  npm install → execSync → Agent 等 3 分钟 → 完成后才去读 package.json
```

`npm install` 分钟级，`docker build` 可能更久，`pytest` 跑全量测试也要时间。这些都是 Agent 工作中的常见操作，一跑就是几分钟。Agent 等在那里什么都不做——不是在"烧 token"，LLM 在等 tool_result 期间没有 API 调用。真正的问题是**效率**。

### 解决方案

> **"慢操作不是必须等，而是可以先做别的。丢后台跑，Agent 继续干别的，完成后自动通知。"**

类比洗衣机：

```text
没有后台任务（s12）：
  把衣服扔洗衣机 → 站在洗衣机前面等 30 分钟 → 好了 → 才去做饭

有后台任务（s13）：
  把衣服扔洗衣机 → 去做饭、回消息、看论文 → 洗衣机滴滴滴通知你 → 好了
```

核心思想：**从串行等待变成并行处理。总时间 ≈ 最长的那个，而不是所有慢操作之和。**

## BackgroundManager

### 数据结构

```typescript
/** 后台任务状态 */
interface BackgroundTask {
  id: string // "bg_0001"，自增计数器生成
  toolName: string // "bash"
  command: string // "npm install"
  status: 'running' | 'completed'
  startedAt: number // 启动时间戳
  process: ChildProcess | null // 子进程引用（可 kill）
}
```

BackgroundManager 内部两个 Map + 一个计数器：

```typescript
export class BackgroundManager {
  private tasks: Map<string, BackgroundTask> = new Map() // bg_id → 任务信息
  private results: Map<string, string> = new Map() // bg_id → 输出结果
  private counter = 0 // 自增 ID
}
```

- `tasks` 存元信息（命令、状态、进程引用）
- `results` 存输出（stdout + stderr 合并截断）
- Node.js 主循环单线程，不需要 Python 的 `threading.Lock`
- 一个任务完成后，通知从 `results` 里取；通知交付后两个 Map 都清理

### 两层判断策略：shouldRunBackground

```typescript
/** 慢操作关键词（启发式兜底用） */
const SLOW_KEYWORDS = [
  'install', 'build', 'test', 'deploy', 'compile',
  'docker', 'pip', 'npm', 'cargo', 'pytest', 'make',
]

shouldRunBackground(toolName: string, toolInput: Record<string, unknown>): boolean {
  // 第一层：模型显式请求（优先）
  if (toolInput.run_in_background === true) return true

  // 第二层：启发式兜底（只有 bash 才判断）
  if (toolName !== 'bash') return false
  const cmd = (toolInput.command as string).toLowerCase()
  return SLOW_KEYWORDS.some((kw) => cmd.includes(kw))
}
```

设计原则：**显式优先，启发式兜底。**

- 模型可以通过 `run_in_background=true` 精确控制哪些命令后台跑
- 但 LLM 经常忘记用这个参数，关键词匹配兜底识别慢操作
- 第二层只判断 bash 工具，`read_file`、`write_file` 是毫秒级，不需要后台

bash 工具 schema 增加 `run_in_background` 参数：

```typescript
// src/core/tools.ts
{
  name: 'bash',
  description: 'Run a shell command.',
  input_schema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The shell command to execute' },
      run_in_background: {
        type: 'boolean',
        description: 'Run in background for slow operations (install, build, test, deploy)',
      },
    },
    required: ['command']
  }
}
```

### spawn 子进程：startTask

```typescript
startTask(toolName: string, toolInput: Record<string, unknown>): string {
  const bgId = `bg_${String(++this.counter).padStart(4, '0')}`
  const command = (toolInput.command as string) || toolName

  // 1. 记录任务
  this.tasks.set(bgId, {
    id: bgId, toolName, command,
    status: 'running', startedAt: Date.now(),
    process: null,
  })

  // 2. 跨平台选择 shell
  const shellCommand = process.platform === 'win32' ? 'cmd' : 'sh'
  const shellArgs = process.platform === 'win32' ? ['/c', command] : ['-c', command]

  // 3. spawn 子进程
  const child = spawn(shellCommand, shellArgs, {
    cwd: WORKDIR,
    timeout: 120_000,
  })

  this.tasks.get(bgId)!.process = child

  // 4. 收集输出
  let output = ''
  child.stdout.on('data', (data: Buffer) => { output += data.toString() })
  child.stderr.on('data', (data: Buffer) => { output += data.toString() })

  // 5. 完成时标记
  child.on('close', () => {
    const task = this.tasks.get(bgId)
    if (task) {
      task.status = 'completed'
      task.process = null
      this.results.set(bgId, output.slice(0, 50_000) || '(no output)')
    }
  })

  // 6. 错误也标记 completed
  child.on('error', (err: Error) => {
    const task = this.tasks.get(bgId)
    if (task) {
      task.status = 'completed'
      task.process = null
      this.results.set(bgId, `Error: ${err.message}`)
    }
  })

  return bgId
}
```

**为什么选 spawn 而不是其他方案？**

| 方案                       | 说明                 | 问题                              |
| -------------------------- | -------------------- | --------------------------------- |
| `Promise.resolve().then()` | 把 execSync 改成异步 | 不是真正后台，只是 I/O 等待时让出 |
| `worker_threads`           | Node.js 多线程       | 对纯 bash 命杀鸡用牛刀            |
| `child_process.spawn`      | 启动子进程           | ✅ 进程隔离，可 kill/信号/超时    |

选 spawn 的原因：真正进程隔离、可 kill、跨平台、和真实 Claude Code 一致。

**为什么 stdout + stderr 合并？** `npm install` 的进度条在 stderr，结果在 stdout，合并后 Agent 看到完整输出。

**为什么错误也标记 completed？** "失败"不是"一直在跑"，而是"跑完了但结果不好"。Agent 需要知道终态，不管成功还是失败。

**后台 bash 不走 runBash handler**：两条路径完全分离。同步路径走 `runBash` → `execSync`（现有逻辑不变）；后台路径走 `spawn` → 子进程执行。

### 通知格式：collectResults

```typescript
collectResults(): string[] {
  const notifications: string[] = []

  for (const [bgId, task] of this.tasks) {
    if (task.status !== 'completed') continue

    const output = this.results.get(bgId) || ''
    const summary = output.length > 200 ? output.slice(0, 200) : output

    notifications.push(`
      <task_notification>
        <task_id>${bgId}</task_id>
        <status>completed</status>
        <command>${task.command}</command>
        <summary>${summary}</summary>
      </task_notification>
    `)

    // 交付即清理
    this.tasks.delete(bgId)
    this.results.delete(bgId)
  }

  return notifications
}
```

**为什么用 XML 而不是 JSON？**

1. 结构化 — 模型可以清晰解析 task_id、状态、命令、摘要
2. 易区分 — 和普通文本回复明显不同，模型一看就知道是系统通知
3. 不复用 tool_use_id — 原始 tool call 已有占位 tool_result，Messages API 语义是一个 `tool_use` 对应一个 `tool_result`，后台完成是独立事件

**交付即清理**：通知取走后删掉 tasks 和 results 里的条目，不会重复注入。通知只能被取一次。

### hasCompleted

```typescript
hasCompleted(): boolean {
  for (const task of this.tasks.values()) {
    if (task.status === 'completed') return true
  }
  return false
}
```

给 Queue Processor 和 `checkQueueStop` 用：判断是否有已完成但未交付的通知。

### listRunning

```typescript
listRunning(): BackgroundTask[] {
  return [...this.tasks.values()].filter((t) => t.status === 'running')
}
```

给 `/status` 命令和 `checkQueueStop` 用：列出所有运行中的后台任务。

---

## Queue Processor：主动推送

### 原项目的被动模式

原项目的设计是**被动**的：后台完成后标记状态，等下一轮循环时顺便收集通知。

```text
被动模式的问题：
  后台完成 → 标记 completed → 等下一轮循环
  → 如果 Agent 已经 stop（end_turn），通知积压在那里
  → 用户必须再输入一条消息，通知才被注入
  → 模型可能等很久才看到结果
```

### 我们的主动推送

Queue Processor：定时器每 500ms 检查一次，空闲 + 有通知 → 自动注入 + 启动新 turn。

```typescript
function processQueue(ctx: SessionContext) {
  if (!ctx.isIdle()) return // Agent 正在忙，等下轮
  if (!ctx.bgManager.hasCompleted()) return // 没有已完成的通知

  ctx.setBusy()
  runAgentTurn(ctx).then(() => {
    ctx.setIdle()
    ctx.checkQueueStop()
  })
}
```

```text
主动推送：
  后台完成 → Queue Processor 每 500ms 检查
  → Agent 空闲 + 有通知 → 自动注入通知 + 启动新 turn
  → 模型不需要等用户输入，自动收到通知
```

### 定时器管理

```typescript
// 有后台任务时启动定时器（已启动就跳过）
const ensureQueue = () => {
  if (queueTimer) return
  queueTimer = setInterval(() => processQueue(ctx), 500)
}

// 三个条件全满足才停定时器
const checkQueueStop = () => {
  if (!queueTimer) return // 没在跑，不用停
  if (bgManager.listRunning().length > 0) return // 还有运行中的任务
  if (bgManager.hasCompleted()) return // 还有未交付的通知 ← 关键
  clearInterval(queueTimer)
  queueTimer = null
}
```

**启动时机**：`startTask` 后调用 `ensureQueue()`，确保定时器在跑。

**停止时机**：`checkQueueStop()` 在每次 turn 完成后调用，三个条件全满足才停。

---

## SessionContext

### 设计动机

`processQueue`、`runAgentTurn`、REPL 主循环都需要访问同一份状态：history、handlers、bgManager、isIdle/setBusy/setIdle、定时器管理。如果用闭包传参，每个函数都有自己的参数列表，改一个地方要改 N 处。

SessionContext 把所有东西打包成一个对象：

```typescript
interface SessionContext {
  history: Message[]
  handlers: Record<string, ToolHandler>
  allTools: ToolDefinition[]
  promptBuilder: SystemPromptBuilder
  bgManager: BackgroundManager

  // 并发控制
  isIdle: () => boolean
  setBusy: () => void
  setIdle: () => void

  // 定时器管理
  queueTimer: NodeJS.Timeout | null
  ensureQueue: () => void
  checkQueueStop: () => void
}
```

三个地方都拿同一个 `ctx`，避免了闭包碎片化。

---

## 并发保护

### 问题

Queue Processor 每 500ms 检查一次。如果恰好在用户输入的那一帧，Queue Processor 也检测到空闲 + 有通知，两个 `runAgentTurn` 会同时修改 history。

```text
没有保护：
  t=0: Queue Processor 启动 turn → 修改 history
  t=0: 用户输入也到达 → 也修改 history → 两个 turn 同时跑 → 混乱
```

### 解决：agentBusy 标志

```typescript
let agentBusy = false
const isIdle = () => !agentBusy
const setBusy = () => {
  agentBusy = true
}
const setIdle = () => {
  agentBusy = false
}
```

三个地方遵守同一规则：

- Queue Processor 只在 `isIdle()` 时才启动 turn
- 用户输入前必须 `while (!isIdle()) { await sleep(50) }` 等空闲
- turn 开始时 `setBusy()`，结束时 `setIdle()`

```text
有保护：
  t=0: Queue Processor 启动 turn → setBusy → runAgentTurn
  t=0.5: 用户输入到达 → while(!isIdle()) → 等待
  t=3: turn 完成 → setIdle → checkQueueStop
  t=3.01: 用户等到空闲 → setBusy → runAgentTurn
```

---

## checkQueueStop 的 bug fix

### 最初的版本（有 bug）

```typescript
const checkQueueStop = () => {
  if (!queueTimer) return
  if (bgManager.listRunning().length > 0) return
  clearInterval(queueTimer) // 没有运行中的了，停！
  queueTimer = null
}
```

### 丢失通知的场景

```text
1. Agent 正在跑一个 turn（agentBusy = true）
2. 后台任务完成了（status = completed），但 Agent 在忙，Queue Processor 跳过
3. turn 完成后 → setIdle → checkQueueStop
4. listRunning() === 0 → 停定时器！
5. 但 completed 的通知还没被取走！定时器一停，通知永远推不出去
```

### 修复

加 `hasCompleted()` 检查：

```typescript
const checkQueueStop = () => {
  if (!queueTimer) return
  if (bgManager.listRunning().length > 0) return // 还有运行中的
  if (bgManager.hasCompleted()) return // 还有未交付的通知 ← 关键！
  clearInterval(queueTimer)
  queueTimer = null
}
```

三个条件全满足才停：定时器在跑、没有运行中的任务、没有未交付的通知。只要有一个不满足，定时器继续跑。

这个 bug 很隐蔽：只在 Agent busy 时后台任务恰好完成的场景下触发。

---

## 通知注入的两个时机

通知不是只在一个地方注入，而是在**两个时机**收集：

```typescript
async function runAgentTurn(ctx: SessionContext) {
  // ===== 时机 1：turn 开始时 =====
  const notifications = ctx.bgManager.collectResults()
  if (notifications.length > 0) {
    ctx.history.push({ role: 'user', content: notifications.join('\n') })
  }

  // ... LLM 调用 + 工具执行 ...

  // ===== 时机 2：工具执行后 =====
  const bgNotifications = ctx.bgManager.collectResults()
  if (bgNotifications.length > 0) {
    for (const notif of bgNotifications) {
      results.unshift({ type: 'text', text: notif })
    }
  }

  ctx.history.push({ role: 'user', content: results })
}
```

为什么需要两个时机？

```text
时机 1：处理空闲期间积攒的通知
  → Agent 空闲时后台完成的，turn 开始时注入

时机 2：处理本轮工具执行期间完成的通知
  → t=0: Agent 调用 bash(后台: npm install) → spawn → 占位 tool_result
  → t=0: Agent 同时调用 read_file → 同步执行，花了 2 秒
  → t=2: read_file 执行期间，npm install 完成了！
  → 如果只在时机 1 收集，通知要等到下一轮才注入 → 延迟一轮
  → 时机 2 收集 → 通知和 read_file 结果一起注入 → 不延迟
```

---

## 完整流程

```text
用户输入 → while(!isIdle()) 等空闲 → setBusy → push query → runAgentTurn

runAgentTurn:
  1. collectResults() → 注入积攒的通知（时机 1）
  2. LLM 调用 → 收到 tool_use blocks
  3. for each tool_use:
     shouldRunBackground? → startTask (spawn) → 占位 tool_result → ensureQueue
     否 → handler 同步执行 → 正常 tool_result
  4. collectResults() → 合入工具执行期间完成的通知（时机 2）
  5. push results to history → 继续循环直到 stop_reason ≠ tool_use

runAgentTurn 完成 → setIdle → checkQueueStop

Queue Processor (每 500ms):
  isIdle + hasCompleted → setBusy → runAgentTurn → setIdle → checkQueueStop
```

---

## 占位 tool_result

后台任务启动后，立即返回占位消息告诉模型"先干别的"：

```typescript
if (ctx.bgManager.shouldRunBackground(toolBlock.name, toolInput)) {
  const bgId = ctx.bgManager.startTask(toolBlock.name, toolInput)
  ctx.ensureQueue()
  results.push({
    type: 'tool_result' as const,
    tool_use_id: toolBlock.id,
    content: `[Background task ${bgId} started] Result will be available when complete.`,
  })
}
```

**为什么不返回实际的 tool_result？** 因为后台任务还在跑，结果还没出来。占位消息让模型知道命令已启动、结果稍后通知，可以继续做别的事。

**为什么不复用 tool_use_id 注入最终结果？** Messages API 语义是：一个 `tool_use` 只对应一个 `tool_result`。占位 tool_result 已经回复了那个 tool_use，后台完成是独立事件，用 `<task_notification>` 新格式注入。

---

## 与原项目的差异

| 维度       | 原项目 s13                      | 我们 s13                         | 说明                           |
| ---------- | ------------------------------- | -------------------------------- | ------------------------------ |
| 后台执行   | `threading.Thread(daemon=True)` | `child_process.spawn`            | 进程级隔离 vs 线程级隔离       |
| 锁机制     | `threading.Lock`                | 不需要                           | Node.js 单线程，spawn 隔离     |
| 通知交付   | 被动（下轮循环收集）            | 主动推送（Queue Processor）      | 500ms 定时器检查 + 自动注入    |
| 并发控制   | 无                              | `agentBusy` 标志                 | 防止两个 turn 同时跑           |
| 定时器管理 | 无                              | `ensureQueue` / `checkQueueStop` | 有后台任务才开，全完成才关     |
| 跨平台     | Linux only                      | Windows (cmd.exe) + Linux (sh)   | spawn 根据平台选 shell         |
| 错误处理   | worker 级 try/catch             | spawn error 事件                 | 错误也标记 completed，通知模型 |

---

## 与其他章节的关系

| 章节               | 关系                                                                           |
| ------------------ | ------------------------------------------------------------------------------ |
| s02 Tool Use       | s13 改变了 bash 工具的执行策略（同步 → 可后台），schema 增加 run_in_background |
| s11 Error Recovery | s13 使用简化 agent loop（聚焦后台），不复用 recovery                           |
| s12 Task System    | s13 复用任务工具，可结合使用（后台跑 install 同时创建任务）                    |
| s14 Cron Scheduler | s14 依赖 s13 的后台执行能力，定时任务触发后需要后台执行                        |

---

## 文件清单

| 文件                                   | 内容                                                                                              |
| -------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `src/persistence/background.ts`        | BackgroundManager 类（shouldRunBackground、startTask、collectResults、hasCompleted、listRunning） |
| `src/sessions/s13-background-tasks.ts` | REPL 入口 + SessionContext + Queue Processor + runAgentTurn + 并发保护                            |
| `src/core/tools.ts`                    | bash 工具 schema 增加 run_in_background 参数                                                      |
| `src/index.ts`                         | 导出 BackgroundManager 和 BackgroundTask 类型                                                     |

## 关键常量

| 常量            | 值                        | 说明                     |
| --------------- | ------------------------- | ------------------------ |
| `SLOW_KEYWORDS` | ['install', 'build', ...] | 启发式兜底的慢操作关键词 |
| `BASH_TIMEOUT`  | 120_000ms                 | spawn 子进程超时         |
| `OUTPUT_LIMIT`  | 50_000 字符               | 后台输出截断上限         |
| `SUMMARY_LIMIT` | 200 字符                  | 通知摘要截断长度         |
| Queue interval  | 500ms                     | Queue Processor 检查间隔 |

## 测试

```bash
pnpm s13
```

### 测试场景

1. **启发式后台**：`先 npm install，然后看一下 package.json 有什么依赖` — 观察 install 被丢后台，Agent 同时读文件
2. **显式后台**：`后台执行 "node -e "setTimeout(()=>console.log('hello'),3000)"，同时告诉我当前目录下有什么文件` — 模型标记 run_in_background=true
3. **查看状态**：`/status` — 显示任务 + 后台运行情况
4. **后台失败**：`后台执行 "nonsense_command_xyz"` — spawn error 也标记 completed，Agent 收到通知知道出错了

### 验证重点

- 后台任务是否真的不阻塞主循环？
- bg_id 是否正确返回？占位 tool_result 是否正确？
- `<task_notification>` 是否通过 Queue Processor 自动推送？
- 后台任务完成后状态是否正确清理（交付即清理）？
- checkQueueStop 是否在有未交付通知时不停止定时器？
- 并发保护是否防止两个 turn 同时跑？
- 通知注入两个时机是否都生效？
