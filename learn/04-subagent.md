# 04 - Subagent (s04)

## 核心概念

> **"Fresh context, clean parent"**

多步任务的中间过程会污染父上下文。子 Agent 从空白上下文启动，做完只返回摘要，父上下文保持干净。

s04 的核心是**上下文隔离**，不是"多一个模型实例"。

**关键洞察：子 Agent 的价值，是"多一个干净上下文"，不是"多一个角色"。**

## ASCII 架构图

```
Parent agent                     Subagent
+------------------+             +------------------+
| messages=[...]   |             | messages=[]      |  <-- 空白上下文
|                  |  dispatch   |                  |
| tool: task       | ---------->| while tool_use:  |
|   prompt="..."   |            |   call tools     |
|                  |  summary   |   append results |
|   result = "..." | <--------- | return last text |
+------------------+             +------------------+
        |
Parent context stays clean.
Subagent context is discarded.
```

子 Agent 在自己上下文里执行工具，做完后只返回摘要文本，中间过程全部丢弃。

## 数据结构

```typescript
// src/core/types.ts
interface SubagentContext {
  messages: Message[] // 子 Agent 自己的上下文（从空白开始）
  tools: ToolDefinition[] // 子 Agent 可用的工具（过滤后的）
  handlers: Record<string, ToolHandler> // 工具执行函数
  maxTurns: number // 最大轮数，防止无限跑
  systemPrompt: string // 子 Agent 的系统提示词
}
```

## 工具过滤：防止递归

**子 Agent 不能有 `task` 工具**，防止无限递归派生：

```typescript
// 父 Agent 工具：base + task
const PARENT_TOOLS = [...BASE_TOOLS, TASK_TOOL]
const PARENT_HANDLERS = { ...BASE_HANDLERS, task: createTaskHandler() }

// 子 Agent 工具：只有 base（不含 task）
const CHILD_TOOLS = BASE_TOOLS // bash, read_file, write_file, edit_file
const CHILD_HANDLERS = BASE_HANDLERS // 没有 task
```

```
父 Agent 调用 task → 子 Agent 调用 task → 孙 Agent 调用 task → ...（禁止！）
```

**工具过滤是隔离的第一道防线。**

## task 工具定义

```typescript
// src/planning/subagent.ts
export const TASK_TOOL_DEFINITION: ToolDefinition = {
  name: 'task',
  description:
    'Launch a subagent with isolated context for exploration tasks. Use this when: (1) analyzing/searching multiple files, (2) gathering information across codebase, (3) only final summary matters. Returns only the summary, keeping parent context clean.',
  input_schema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'The specific task for the subagent' },
      description: { type: 'string', description: 'Short label (e.g., "analyze core")' },
    },
    required: ['prompt'],
  },
}
```

关键是 `description`：明确列出适用场景，模型才知道什么时候该用。

## runSubagent 函数

```typescript
// src/planning/subagent.ts
export async function runSubagent(prompt: string): Promise<string> {
  // 1. 创建空白上下文
  const subMessages: Message[] = [{ role: 'user', content: prompt }]

  // 2. 子 Agent 配置（不含 task 工具）
  const context: SubagentContext = {
    messages: subMessages,
    tools: CHILD_TOOLS,
    handlers: CHILD_HANDLERS,
    maxTurns: 30,
    systemPrompt: SUBAGENT_SYSTEM,
  }

  // 3. 循环执行，最多 30 轮
  for (let turn = 0; turn < context.maxTurns; turn++) {
    const response = await client.messages.create({
      model: MODEL,
      system: context.systemPrompt,
      messages: context.messages,
      tools: context.tools,
    })

    context.messages.push({ role: 'assistant', content: response.content })

    if (response.stop_reason !== 'tool_use') {
      break // 子 Agent 做完了
    }

    // 执行工具调用
    const results = await executeTools(response.content, context.handlers)
    context.messages.push({ role: 'user', content: results })
  }

  // 4. 只返回最终文本摘要（中间过程丢弃）
  return extractTextReply(context.messages) || '(no summary)'
}
```

四个步骤：

| 步骤 | 做什么                        |
| ---- | ----------------------------- |
| 1    | 空白 messages 启动            |
| 2    | 配置隔离的工具集（不含 task） |
| 3    | 循环执行，最多 30 轮          |
| 4    | 只返回摘要，丢弃中间过程      |

## 智能判断：何时用 task

系统提示词里明确列出判断条件：

```typescript
// src/sessions/s04-subagent.ts
const S04_SYSTEM = `You are a coding agent at ${WORKDIR}.

<task_tool_guidance>
Use the task tool when the request involves:
- Analyzing, exploring, or searching multiple files/directories
- Finding patterns or gathering information across the codebase
- Tasks where intermediate steps are noise but final summary matters
- Requests starting with "analyze", "find", "search", "list", "explore"

Do NOT use task tool for:
- Single file operations (read/edit one file)
- Simple bash commands
- Tasks that need current conversation context
</task_tool_guidance>

The task tool spawns a subagent with fresh messages. This keeps the parent context clean.`
```

**用 task**：

- 分析/搜索多个文件
- 查找代码库中的模式
- 中间过程是噪声，只要结论

**不用 task**：

- 单文件操作
- 简单 bash 命令
- 需要当前对话上下文的任务

## 相对 s03 的变更

| 组件     | s03                          | s04                          |
| -------- | ---------------------------- | ---------------------------- |
| Tools    | 5 (base + todo)              | 5 (base + task)              |
| Handlers | BASE_HANDLERS + todo handler | BASE_HANDLERS + task handler |
| 核心机制 | 计划状态外显                 | 上下文隔离                   |
| 解决问题 | Agent 跑偏                   | 上下文污染                   |
| 返回方式 | 渲染计划文本                 | 只返回摘要                   |

**s03 解决"忘记做什么"，s04 解决"做过的事堆在上下文里"。两者互补。**

## 运行测试

```bash
pnpm run s04

# 测试对话示例
s04 >> 分析 src/core 目录下的所有文件，告诉我它们各自的作用
> task (analyze src/core): 分析 src/core 目录...
  项目使用 TypeScript 实现，核心是 agent-loop 的循环模式...

s04 >> 读取 package.json 的内容
> read_file
  ...直接读取，不走 task（单文件操作）...

s04 >> q
```

**验证上下文隔离**：

```
s04 >> 分析 src/core 目录下的所有文件

（等待完成后）

s04 >> 你刚才读了哪些文件？
```

预期回答："我派生了一个子任务去分析，子 Agent 返回说..."

而不是："我读了 agent-loop.ts、tools.ts..."（如果这样说，说明污染了父上下文）

## maxTurns 保护

```typescript
const MAX_SUBAGENT_TURNS = 30
```

防止子 Agent 无限循环。30 轮足够完成大部分探索任务，也足够防止卡死。

## 教学边界

s04 是**一次性子任务隔离**，不是多 Agent 系统：

| 特性   | s04 Subagent           | s09-s11 Agent Teams   |
| ------ | ---------------------- | --------------------- |
| 持久性 | 一次性（任务完成丢弃） | 长期 teammate         |
| 角色   | 无角色区分             | 有角色（explorer 等） |
| 通信   | 单向返回               | 双向消息通道          |
| 目的   | 隔离噪声               | 协作分工              |

先做一次性隔离，再做长期协作。

## fork 模式（下一步）

s04 子 Agent 从空白上下文启动。但有时子任务需要继承父对话背景：

```typescript
// fork 模式：继承父上下文
const subMessages = [...parentMessages]
subMessages.push({ role: 'user', content: prompt })
```

这是高级功能，教学版先不实现。

## 下一步

s05 将展示：**按需加载知识，不要 upfront。Skills 如何动态注入 prompt。**

---

**Session 04 完成 ✓**

- 理解了上下文污染的根本原因
- 实现了 SubagentContext 数据结构
- 理解了工具过滤防止递归派生
- 理解了智能判断何时用 task
- 运行了 s04 REPL 测试
