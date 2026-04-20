# 03 - TodoWrite (s03)

## 核心概念

> **"No plan, agent drifts"**

多步任务中，模型的"注意力"受上下文影响。如果没有一块显式、稳定、可反复更新的计划状态，大任务就会漂。

s03 把"正在做什么"从模型脑内移到系统可观察的状态里。

**关键洞察：这不是替模型思考，是把模型在想的事写出来。**

## ASCII 架构图

```
┌─────────────┐    ┌───────────┐    ┌─────────────────┐
│    User     │───▶│    LLM    │───▶│   Tool Dispatch │
│   prompt    │    │           │    │ {               │
└─────────────┘    └─────┬─────┘    │   bash: runBash │
                         │          │   read: runRead │
                         │          │   todo: handler │
                         │          │ }               │
                         │          └────────┬────────┘
                         │                   │
                         │   tool_result     │
                         │                   │
                         ▼                   ▼
                   ┌───────────┐       ┌─────────────┐
                   │   append  │◀──────│ TodoManager │
                   │  to msgs  │       │   .update() │
                   └─────┬─────┘       │   .reminder │
                         │             └─────────────┘
                         │
                         │  loop continues
                         ▼
                   ┌───────────┐
                   │    LLM    │
                   │   again   │
                   └───────────┘
```

TodoManager 在循环外维护一份计划状态。模型通过 `todo` 工具更新它，agent-loop 每轮检查是否需要提醒。

## 数据结构

```typescript
// src/core/types.ts
interface TodoItem {
  id: string                // 条目编号
  content: string           // 这一步要做什么
  status: 'pending' | 'in_progress' | 'completed'
  activeForm?: string       // 进行时的描述（可选）
}

// src/planning/todo.ts
interface PlanningState {
  items: TodoItem[]
  roundsSinceUpdate: number  // 多轮没更新了
}
```

`activeForm` 用于描述"正在做什么动作"，比干巴巴的 `in_progress` 更有帮助：

```
[>] 分析 tools.ts 的性能问题 (正在读取文件内容)
```

## 整份重写设计

为什么不是逐条操作 (`todo_add`, `todo_complete`, `todo_remove`)？

```typescript
// ❌ 逐条操作（模型需要记 id）
todo_add("读文件A")       // id=1
todo_mark_complete(1)     // 记住 id
todo_add("读文件B")       // id=2

// ✅ 整份重写（模型只需发完整状态）
todo({
  items: [
    {content: "读文件A", status: "completed"},
    {content: "读文件B", status: "in_progress"},
    {content: "写报告", status: "pending"}
  ]
})
```

**简单，就不会错。** 模型不需要记 id，不需要记历史，只需要描述"当前想要的状态"。

## TodoManager 类

```typescript
// src/planning/todo.ts
export class TodoManager {
  private state: PlanningState = {
    items: [],
    roundsSinceUpdate: 0,
  }

  // 1. 更新计划（模型整份重写）
  update(items: unknown[]): string {
    // 验证：最多 12 条
    // 验证：最多一个 in_progress（强制聚焦）
    // 更新状态
    // 重置 roundsSinceUpdate = 0
    // 返回渲染文本
  }

  // 2. 记录一轮没更新
  noteRoundWithoutUpdate(): void {
    this.state.roundsSinceUpdate++
  }

  // 3. 是否需要提醒
  reminder(): string | null {
    if (this.state.roundsSinceUpdate >= 3 && this.state.items.length > 0) {
      return '<reminder>Refresh your current plan before continuing.</reminder>'
    }
    return null
  }

  // 4. 渲染为可读文本
  render(): string {
    // [ ] pending item
    // [>] in_progress item (activeForm)
    // [x] completed item
    // (2/5 completed)
  }
}
```

## 工具定义

```typescript
// src/planning/todo.ts
export const TODO_TOOL_DEFINITION: ToolDefinition = {
  name: 'todo',
  description: 'Rewrite the current session plan for multi-step work.',
  input_schema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
            activeForm: { type: 'string' },
          },
          required: ['content', 'status'],
        },
      },
    },
    required: ['items'],
  },
}

// 创建 handler（绑定 TodoManager）
export function createTodoHandler(manager: TodoManager) {
  return (input: Record<string, unknown>): string => {
    const items = input.items as unknown[]
    return manager.update(items)  // ← 调用 update()
  }
}
```

关键是 `description`：告诉模型"这是用来重写计划的"，而不是"添加一条任务"。

## agent-loop 的改动

```typescript
// src/core/agent-loop.ts
interface AgentLoopOptions {
  tools: ToolDefinition[]
  handlers: Record<string, ToolHandler>
  system?: string
  todoManager?: TodoManager  // <-- 新增：可选的 TodoManager
}

export async function agentLoop(messages: Message[], options: AgentLoopOptions) {
  const { tools, handlers, system, todoManager } = options

  while (true) {
    // ... 调用 LLM，执行工具 ...

    // s03: 提醒机制
    let usedTodo = false
    for (const block of response.content) {
      if (block.type === 'tool_use' && block.name === 'todo') {
        usedTodo = true
      }
    }

    if (todoManager) {
      if (usedTodo) {
        // update() 已经重置了 roundsSinceUpdate
      } else {
        todoManager.noteRoundWithoutUpdate()
        const reminder = todoManager.reminder()
        if (reminder) {
          results.unshift({ type: 'text', text: reminder })
        }
      }
    }

    // ... 追加结果，循环继续 ...
  }
}
```

**注意**：`if (usedTodo)` 分支是空的。重置逻辑已在 `update()` 里完成。空分支的存在是为了可读性。

## 提醒机制时序

```
轮次  模型行为              roundsSinceUpdate   提醒？
─────────────────────────────────────────────────────
 1    调用 todo 创建计划      0                  否
 2    执行工具，没更新计划     1                  否
 3    执行工具，没更新计划     2                  否
 4    执行工具，没更新计划     3                  是！
 5    模型看到提醒，调用 todo  0                  否
```

为什么是 3 轮？

- 1 轮太敏感：每轮都提醒，模型会很烦
- 10 轮太宽松：已经漂得很远了
- 3 轮是平衡点：给模型执行空间，但不会完全走偏

## 调用链

`update()` 不是直接调用，而是通过 dispatch map 间接触发：

```
模型调用 todo 工具
      ↓
agent-loop 从 handlers 查找 'todo'
      ↓
找到 createTodoHandler 返回的函数
      ↓
handler 内部调用 manager.update()
```

## 相对 s02 的变更

| 组件       | s02                    | s03                            |
| ---------- | ---------------------- | ------------------------------ |
| Tools      | 4 (bash + 文件操作)    | 5 (+ todo)                     |
| Handlers   | BASE_HANDLERS          | BASE_HANDLERS + todo handler   |
| 状态管理   | 无                     | TodoManager                    |
| 提醒机制   | 无                     | 3轮不更新就提醒                |
| Agent loop | 不变                   | 新增 todoManager 参数          |

**核心循环不变。只加了 todo 工具和 TodoManager。**

## 运行测试

```bash
pnpm run s03

# 测试对话示例
s03 >> 分析 src/core 目录下的所有文件，找出可能的性能问题
> todo
[ ] 分析 agent-loop.ts
[>] 分析 tools.ts (正在读取文件)
[ ] 分析 types.ts
[ ] 写一份报告

> read_file
...读取 tools.ts 的内容...

> todo
[x] 分析 agent-loop.ts
[x] 分析 tools.ts
[>] 分析 types.ts (正在读取文件)
[ ] 写一份报告

s03 >> q
```

模型每做完一步，就更新一次计划。不会漏，不会重复。

## 核心约束

```text
同一时间，最多一个 in_progress
```

这不是硬性规则，而是教学约束：强制模型聚焦当前一步。

为什么？如果允许多个 `in_progress`，模型容易"贪多嚼不烂"，同时推进好几件事，最后哪件都没做好。

## 教学边界

s03 是**会话内轻量计划**，不是持久化任务系统：

| 特性       | s03 TodoWrite          | s12 Task System        |
| ---------- | ---------------------- | ---------------------- |
| 持久化     | 无（会话结束就消失）   | 文件持久化             |
| 依赖图     | 无                     | 支持依赖关系           |
| 跨会话     | 不支持                 | 支持                   |
| 目的       | 帮助模型聚焦下一步     | 管理长期任务           |

混淆这两者会让初学者迷失方向。

## 下一步

s04 将展示：**大任务拆分，子任务获得干净的上下文。Subagent 如何隔离执行。**

---

**Session 03 完成 ✓**

- 理解了 Agent "跑偏"的根本原因
- 实现了 TodoManager 的数据结构
- 理解了"整份重写"设计
- 理解了三轮提醒机制的触发逻辑
- 运行了 s03 REPL 测试