# 02 - Tool Use (s02)

## 核心概念

> **"Add tools = add a handler"**

s01 只有 bash 工具，所有操作都走 shell。问题是：

- `cat` 截断不可预测
- `sed` 遇到特殊字符就崩
- 每次 bash 调用都是不受约束的安全面

s02 添加专用工具 (`read_file`, `write_file`, `edit_file`)，在工具层面做路径沙箱。

**关键洞察：加工具不需要改循环。**

## ASCII 架构图

```
+--------+      +-------+      +------------------+
|  User  | ---> |  LLM  | ---> | Tool Dispatch    |
| prompt |      |       |      | {                |
+--------+      +---+---+      |   bash: runBash  |
                    ^           |   read: runRead  |
                    |           |   write: runWrite|
                    +-----------+   edit: runEdit  |
                    tool_result | }               |
                                +------------------+

The dispatch map is a dict: {tool_name: handler_function}.
One lookup replaces any if/elif chain.
```

## Dispatch Map 模式

### 工具定义 (Schema)

告诉模型有什么工具可用：

```typescript
// src/core/tools.ts
export const BASE_TOOLS: ToolDefinition[] = [
  {
    name: 'bash',
    description: 'Run a shell command.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to execute' },
      },
      required: ['command'],
    },
  },
  {
    name: 'read_file',
    description: 'Read file contents.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path to read' },
        limit: { type: 'integer', description: 'Maximum lines to read' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Write content to file.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path to write' },
        content: { type: 'string', description: 'Content to write' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'edit_file',
    description: 'Replace exact text in file.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path to edit' },
        old_text: { type: 'string', description: 'Text to find and replace' },
        new_text: { type: 'string', description: 'New text to insert' },
      },
      required: ['path', 'old_text', 'new_text'],
    },
  },
]
```

### Handler 映射

工具名 → 执行函数的分发表：

```typescript
// src/core/tools.ts
export const BASE_HANDLERS: Record<string, ToolHandler> = {
  bash: runBash,
  read_file: runRead,
  write_file: runWrite,
  edit_file: runEdit,
}
```

### 循环中的调用

循环体与 s01 完全一致，只是改用查表：

```typescript
// src/core/agent-loop.ts
for (const block of response.content) {
  if (block.type === 'tool_use') {
    // 从 dispatch map 获取 handler
    const handler = handlers[block.name]
    if (!handler) {
      results.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: `Error: Unknown tool "${block.name}"`,
      })
      continue
    }

    // 执行工具
    const output = await handler(block.input)
    results.push({
      type: 'tool_result',
      tool_use_id: block.id,
      content: output,
    })
  }
}
```

**加工具 = 加 handler + 加 schema。循环永远不变。**

## 路径沙箱

防止路径逃逸工作目录：

```typescript
// src/core/tools.ts
export function safePath(relativePath: string): string {
  const absolutePath = path.resolve(WORKDIR, relativePath)
  if (!absolutePath.startsWith(WORKDIR)) {
    throw new Error(`Path escapes workspace: ${relativePath}`)
  }
  return absolutePath
}
```

逻辑：

1. 把相对路径转成绝对路径
2. 检查是否还在工作目录内
3. 不在？拒绝执行

这样，模型想读取 `/etc/passwd` 或 `../../../secret`，都会被挡住。

## 四个工具实现

### runBash：执行命令

```typescript
export const runBash: ToolHandler = (input) => {
  const command = input.command as string

  // 危险命令检查
  for (const dangerous of DANGEROUS_COMMANDS) {
    if (command.includes(dangerous)) {
      return 'Error: Dangerous command blocked'
    }
  }

  // Windows 使用 PowerShell (UTF-8)
  const shell = process.platform === 'win32' ? 'powershell.exe' : undefined

  const result = execSync(command, {
    cwd: WORKDIR,
    encoding: 'utf-8',
    timeout: 120000,
    shell,
  })
  return result.trim() || '(no output)'
}
```

### runRead：读取文件

```typescript
export const runRead: ToolHandler = async (input) => {
  const filePath = safePath(input.path as string) // 沙箱检查
  const limit = input.limit as number | undefined

  const content = await fs.readFile(filePath, 'utf-8')
  const lines = content.split('\n')

  // 限制输出行数
  if (limit && limit < lines.length) {
    lines.length = limit
    lines.push(`... (${lines.length - limit} more lines)`)
  }

  // 限制输出长度，防止上下文爆炸
  return lines.join('\n').slice(0, 50000)
}
```

### runWrite：写入文件

```typescript
export const runWrite: ToolHandler = async (input) => {
  const filePath = safePath(input.path as string) // 沙箱检查
  const content = input.content as string

  // 自动创建目录
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, content, 'utf-8')

  return `Wrote ${content.length} bytes to ${input.path}`
}
```

### runEdit：精确替换

```typescript
export const runEdit: ToolHandler = async (input) => {
  const filePath = safePath(input.path as string)
  const oldText = input.old_text as string
  const newText = input.new_text as string

  const content = await fs.readFile(filePath, 'utf-8')

  // 精确匹配：找不到就报错
  if (!content.includes(oldText)) {
    return `Error: Text not found in ${input.path}`
  }

  // 只替换第一次出现（防止意外修改）
  const newContent = content.replace(oldText, newText)
  await fs.writeFile(filePath, newContent, 'utf-8')

  return `Edited ${input.path}`
}
```

## 相对 s01 的变更

| 组件       | 之前 (s01)       | 之后 (s02)                  |
| ---------- | ---------------- | --------------------------- |
| Tools      | 1 (仅 bash)      | 4 (bash, read, write, edit) |
| Dispatch   | 硬编码 bash 调用 | `BASE_HANDLERS` 字典        |
| 路径安全   | 无               | `safePath()` 沙箱           |
| Agent loop | 不变             | 不变                        |

## 运行测试

```bash
pnpm run s02

# 测试对话示例
s02 >> 创建一个 test.txt 文件，内容是 "Hello s02"
s02 >> 读取 test.txt 的内容
s02 >> 把 test.txt 里的 s02 改成 World
s02 >> 再次读取 test.txt 确认修改成功
s02 >> q
```

## s01 vs s02 的代码结构

```typescript
// s01: 只使用 bash
const S01_TOOLS = [BASE_TOOLS[0]] // 只有 bash
const S01_HANDLERS = { bash: runBash }

// s02: 使用全部 4 个工具
const S02_TOOLS = BASE_TOOLS // bash + read + write + edit
const S02_HANDLERS = BASE_HANDLERS

// 循环调用方式完全一样
await agentLoop(history, S01_TOOLS, S01_HANDLERS) // s01
await agentLoop(history, S02_TOOLS, S02_HANDLERS) // s02
```

## 进阶：消息规范化

教学版的 `messages` 列表直接发给 API。但当系统变复杂后，内部消息列表会出现 API 不接受的格式问题。

### 为什么需要

API 协议有三条硬性约束：

1. 每个 `tool_use` 块**必须**有匹配的 `tool_result`
2. `user` / `assistant` 消息必须**严格交替**
3. 只接受协议定义的字段

### 实现（可选）

```typescript
function normalizeMessages(messages: Message[]): Message[] {
  // 1. 剥离内部字段
  // 2. tool_result 配对补齐
  // 3. 合并连续同角色消息
  // ...
}
```

**关键洞察**：`messages` 是系统的内部表示，API 看到的是规范化后的副本。

## 教学边界

这一章最重要的，是讲清 3 个稳定点：

- **tool schema**：给模型看的说明
- **handler map**：代码里的分发入口
- **tool_result**：结果回流到主循环的统一出口

只要这三点稳住，就能在不改主循环的前提下新增工具。

权限、hook、并发、MCP 这些后续层次应该建立在这层最小分发模型之后。

## 下一步

s03 将展示：**没有计划的 Agent 会迷失方向。TodoWrite 让 Agent 有规划能力。**

---

**Session 02 完成 ✓**

- 理解了 Dispatch Map 模式
- 实现了 4 个工具（bash + 文件操作）
- 理解了路径沙箱的作用
- 运行了 s02 REPL 测试
