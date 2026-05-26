# 12 - Task System

## 学习目标

- 理解任务系统要解决的核心问题：Agent 不会做计划
- 理解 `blockedBy` 依赖图（DAG）的设计
- 实现 `TaskManager` 类 — 文件持久化的任务管理器
- 实现 `canStart()` — 依赖检查
- 实现 `claimTask()` — 领取任务（带依赖守卫）
- 实现 `completeTask()` — 完成任务（自动报告解锁）
- 实现 5 个工具：create_task, list_tasks, get_task, claim_task, complete_task
- 理解任务系统与 TodoWrite、Subagent 的区别与关系
- 理解跨会话恢复机制

## 核心概念

### 问题背景

到 s11，Agent 已经具备：循环（s01）、工具（s02）、子代理（s04）、压缩（s06）、权限（s07）、Hook（s08）、记忆（s09）、提示词（s10）、错误恢复（s11）。

但有一个根本问题没解决：**Agent 不会规划。**

```text
用户："帮我搭一个 REST API，要有数据库、接口、测试、文档"

Agent 的行为：
  1. 直接开始写 API 代码
  2. 写到一半发现没有数据库表
  3. 回头补数据库
  4. 加测试时发现接口签名又变了
  5. 文档和代码对不上
  6. 来回返工，效率极低
```

s03 的 TodoWrite 是一个内存列表，解决了"列清单"的问题，但有三个致命缺陷：

| 缺陷         | 后果                       |
| ------------ | -------------------------- |
| 没有依赖关系 | 不知道先做什么后做什么     |
| 没有持久化   | 对话结束清单就没了         |
| 没有状态管理 | 无法追踪哪些做完了哪些没做 |

### 解决方案

> **"大目标拆成小任务，排好序，持久化。任务系统是 Agent 规划能力的基础设施。"**

类比盖房子：

```text
没有任务系统：
  拿到图纸就开始砌墙
  → 发现没打地基 → 拆了重来
  → 发现没钢筋 → 停工等材料

有任务系统：
  打地基 → 钢筋 → 砌墙 → 封顶 → 装修
  每步标记依赖，完成自动解锁
```

## blockedBy 依赖图

`s12` 最核心的设计是 `blockedBy` 字段，意思是"被谁阻塞"——记录当前任务依赖哪些前置任务。

### 示例：搭一个 REST API

```text
task_1: 搭数据库 schema        → blockedBy: []
task_2: 写 API 接口            → blockedBy: ["task_1"]
task_3: 写测试                 → blockedBy: ["task_2"]
task_4: 写文档                 → blockedBy: ["task_1"]
```

形成的依赖图（DAG）：

```text
task_1 (schema)
  ├── task_2 (API)  → task_3 (tests)
  └── task_4 (docs)
```

- `blockedBy` 为空 → 没有前置依赖，可以直接开始
- `blockedBy` 非空 → 必须等所有依赖任务 completed 才能开始
- `canStart()` 检查的就是：blockedBy 里所有任务是否都已完成

### 关键术语

- **DAG**（Directed Acyclic Graph）：有向无环图。任务之间的依赖关系有方向（A 依赖 B），但不能成环（A 依赖 B、B 依赖 A 是不允许的）
- **blockedBy**：记录"我被谁阻塞"，是前置依赖的声明
- **canStart**：检查所有 blockedBy 依赖是否都已完成

## 状态机

```text
pending ──claim──→ in_progress ──complete──→ completed
```

只有两个转换动作，没有回退路径（简化设计）。

### 转换守卫

| 动作            | 前置条件                                           | 效果                     |
| --------------- | -------------------------------------------------- | ------------------------ |
| `claim_task`    | 状态必须是 `pending` + 所有 `blockedBy` 依赖已完成 | → `in_progress`          |
| `complete_task` | 状态必须是 `in_progress`                           | → `completed` + 报告解锁 |

## 5 个工具

| 工具            | 参数                                    | 说明                                                           |
| --------------- | --------------------------------------- | -------------------------------------------------------------- |
| `create_task`   | `subject`, `description?`, `blockedBy?` | 创建任务，支持声明依赖。创建时验证 blockedBy 中的 ID 是否存在  |
| `list_tasks`    | 无                                      | 列出所有任务，用 ○/●/✓ 图标区分状态                            |
| `get_task`      | `task_id`                               | 获取单个任务完整详情（JSON）                                   |
| `claim_task`    | `task_id`                               | 领取 pending 任务（先检查 canStart），失败时返回具体阻塞的依赖 |
| `complete_task` | `task_id`                               | 完成 in_progress 任务，自动扫描并报告哪些下游任务被解锁        |

## 关键实现

### TaskManager 类

```typescript
export class TaskManager {
  constructor(tasksDir: string = TASKS_DIR)

  // CRUD
  async create(subject: string, description?: string, blockedBy?: string[]): Promise<Task>
  async get(taskId: string): Promise<Task>
  async listAll(): Task[]

  // 状态操作
  async canStart(taskId: string): Promise<boolean>
  async claimTask(taskId: string, owner?: string): Promise<string>
  async completeTask(taskId: string): Promise<string>

  // 展示
  async renderList(): Promise<string>
}
```

### 文件持久化

每个任务一个 JSON 文件，存在 `.tasks/` 目录：

```text
.tasks/
  task_1747900000_1234.json
  task_1747900001_5678.json
```

好处：人类可读、可用 git 追踪、进程重启不丢失。

### ID 生成

```typescript
function generateTaskId(): string {
  const ts = Math.floor(Date.now() / 1000)
  const rand = Math.floor(Math.random() * 10000)
    .toString()
    .padStart(4, '0')
  return `task_${ts}_${rand}`
}
```

时间戳 + 随机数，保证唯一性，按文件名排序就是按创建时间排序。

### canStart — 依赖检查

```typescript
async canStart(taskId: string): Promise<boolean> {
  const task = await this.load(taskId)
  for (const depId of task.blockedBy) {
    try {
      const dep = await this.load(depId)
      if (dep.status !== 'completed') return false
    } catch {
      return false  // 依赖不存在 = 阻塞
    }
  }
  return true
}
```

### completeTask — 完成即解锁

```typescript
async completeTask(taskId: string): Promise<string> {
  // 1. 标记完成
  task.status = 'completed'
  await this.save(task)

  // 2. 扫描所有 pending 任务，找出刚被解锁的
  const allTasks = await this.listAll()
  const unblocked: string[] = []
  for (const t of allTasks) {
    if (t.status === 'pending' && t.blockedBy.length > 0 && (await this.canStart(t.id))) {
      unblocked.push(t.subject)
    }
  }

  // 3. 报告给 Agent
  let msg = `Completed ${taskId} (${task.subject})`
  if (unblocked.length > 0) {
    msg += `\nUnblocked: ${unblocked.join(', ')}`
  }
  return msg
}
```

### ID 验证

LLM 会自己编造 ID（如 `task_001`），我们在 `create` 时验证：

```typescript
for (const depId of blockedBy) {
  try {
    await this.load(depId)
  } catch {
    throw new Error(`Dependency task ${depId} not found. Use list_tasks to see existing task IDs.`)
  }
}
```

系统提示词中也明确引导：`Task IDs are auto-generated in format "task_{timestamp}_{random}". Always use the exact ID returned by create_task or list_tasks — never make up IDs.`

## 架构设计

### 工具定义与 handlers 的归属

**规则：工具定义（ToolDefinition[]）和 handlers 应该与 Manager 类放在同一个模块中，而不是放在 session 入口文件。**

| 模块                              | 导出内容                                              |
| --------------------------------- | ----------------------------------------------------- |
| `src/persistence/task-manager.ts` | `TaskManager` + `TASK_TOOLS` + `createTaskHandlers()` |
| `src/sessions/s12-task-system.ts` | 只做组装（import + 拼接），不放工具逻辑               |

### 与原项目的差异

| 维度       | 原项目 s12             | 我们 s12                     |
| ---------- | ---------------------- | ---------------------------- |
| ID 格式    | `task_{ts}_{random}`   | 同                           |
| 时间戳     | 无                     | `createdAt` + `updatedAt`    |
| 存储       | `.tasks/{id}.json`     | 同                           |
| agent loop | 简化版（无错误恢复）   | 复用 s11 recovery            |
| 提示词     | 简单拼接               | 复用 s10 SystemPromptBuilder |
| 记忆       | 读 `.memory/MEMORY.md` | 复用 s09 MemoryManager       |

## 跨会话恢复

任务存在 `.tasks/` 目录，跨会话不丢失。新会话的 Agent 需要先 `list_tasks` 发现已有任务。

系统提示词引导：

```
When starting a new session, always list_tasks first to discover existing tasks and their IDs.
```

## 与 s03 TodoWrite、s04 Subagent 的关系

| 维度     | s03 TodoWrite | s04 Subagent | s12 Task System |
| -------- | ------------- | ------------ | --------------- |
| 解决什么 | 列清单        | 执行子任务   | 规划和追踪      |
| 持久化   | 内存          | 无           | 文件            |
| 依赖关系 | 无            | 无           | blockedBy DAG   |
| 跨会话   | 丢失          | 不适用       | 持久化          |

三者是不同层次的工具，不互相替代：

```text
TodoWrite = 便签纸（简单清单）
Subagent  = 临时工（一次性执行）
Task System = 项目管理看板（依赖追踪 + 跨会话）
```

## 测试

```bash
pnpm s12
```

### 测试场景

1. 创建带依赖的任务：`Create tasks: setup database, create API (depends on database), write tests (depends on API), write docs (depends on database)`
2. 查看任务列表：`List all tasks and their statuses`
3. 领取并完成：`Claim the first unblocked task and complete it`
4. 查看解锁：`List tasks again — which ones are now unblocked?`

### 验证重点

- `.tasks/` 目录下是否生成了 JSON 文件？
- 完成任务后，被阻塞的任务是否解锁？
- 任务状态是否正确持久化？
- `/status` 命令是否正常？
