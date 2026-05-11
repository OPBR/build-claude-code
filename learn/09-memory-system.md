# 09 - Memory System

## 学习目标

- 理解记忆系统的核心思想（选择性存储 vs 记住所有东西）
- 理解 4 种记忆类型：user、feedback、project、reference
- 实现 MemoryManager 核心类
- 实现 save_memory 工具
- 理解系统提示词注入机制
- 理解 Dream 整理机制（可选）

## 核心概念

### 问题背景

到了 s08，Hook 系统解决了扩展问题。但每次会话结束，所有信息都丢失了：

- 用户偏好（"我喜欢 tab 缩进"）
- 项目知识（"auth 模块不能动，因为合规"）
- 外部资源（"bug 在 Linear 的 INGEST 项目"）

这些信息代码里没有，但下次会话又需要。

### 解决方案

> **"只记住不容易重新推导的信息，每次会话开始时加载到系统提示词。"**

记忆系统就像笔记本：

- 会话 = 一天的工作
- 记忆 = 笔记本里的笔记
- 每天开始前，先翻翻笔记本
- 工作中发现重要信息，记到笔记本里

## 什么应该存记忆，什么不应该

### 应该存的（4 种类型）

| 类型        | 含义                 | 例子                             |
| ----------- | -------------------- | -------------------------------- |
| `user`      | 用户偏好             | "喜欢 tab 缩进"、"总是用 pytest" |
| `feedback`  | 用户纠正             | "不要这样做"、"上次的方法不对"   |
| `project`   | 不容易推断的项目事实 | "auth 模块不能动（合规）"        |
| `reference` | 外部资源指针         | "bug 在 Linear INGEST 项目"      |

### 不应该存的

| 不存什么     | 原因               |
| ------------ | ------------------ |
| 代码结构     | 可以从代码重新读取 |
| 函数签名     | 可以从代码重新读取 |
| 临时任务状态 | 下次会话可能变了   |
| 密钥/凭证    | 安全风险           |

### 判断标准

> **记忆只存"不容易重新推导"的信息。**

## 存储结构

### 目录结构

```
.memory/
├── MEMORY.md              # 索引文件（自动生成）
├── prefer_tabs.md         # 用户偏好
├── review_style.md        # 用户反馈
├── auth_compliance.md     # 项目知识
└── linear_ingest.md       # 外部资源
```

### 单个记忆文件格式

```markdown
---
name: prefer_tabs
description: User prefers tab indentation over spaces
type: user
---

The user explicitly stated they prefer tab indentation.
```

### 索引文件格式

```markdown
# Memory Index

- [prefer_tabs](prefer_tabs.md) — User prefers tab indentation [user]
- [auth_compliance](auth_compliance.md) — Auth module locked [project]
```

索引限制：最多 200 行（因为会注入系统提示词）。

## 关键数据结构

### MemoryEntry

```typescript
interface MemoryEntry {
  name: string // 标识符（如 "prefer_tabs"）
  description: string // 一行描述
  type: string // user / feedback / project / reference
  content: string // 完整内容
  file: string // 文件名（如 "prefer_tabs.md"）
}
```

### MemoryType

```typescript
type MemoryType = 'user' | 'feedback' | 'project' | 'reference'
```

## 核心实现

### MemoryManager 类

```typescript
class MemoryManager {
  private memoryDir: string
  memories: Map<string, MemoryEntry>

  constructor(memoryDir?: string)
  loadAll(): void
  loadMemoryPrompt(): string
  saveMemory(name, description, type, content): string
  rebuildIndex(): void
  parseFrontmatter(text): ParsedMemory | null
}
```

### loadAll() - 加载记忆

```typescript
loadAll(): void {
  this.memories = new Map()

  if (!existsSync(this.memoryDir)) {
    return
  }

  for (const file of readdirSync(this.memoryDir)) {
    if (!file.endsWith('.md')) continue      // 跳过非 md
    if (file === 'MEMORY.md') continue       // 跳过索引

    const content = readFileSync(join(this.memoryDir, file), 'utf-8')
    const parsed = this.parseFrontmatter(content)

    if (parsed && parsed.name) {
      this.memories.set(parsed.name, { ... })
    }
  }
}
```

**为什么跳过 MEMORY.md？**

MEMORY.md 是索引，不是记忆内容。

### loadMemoryPrompt() - 构建系统提示词

```typescript
loadMemoryPrompt(): string {
  if (this.memories.size === 0) return ''

  const sections = ['# Memories (persistent across sessions)', '']

  // 按类型分组
  for (const type of ['user', 'feedback', 'project', 'reference']) {
    const typed = [...this.memories.values()].filter(m => m.type === type)
    if (typed.length === 0) continue

    sections.push(`## [${type}]`)
    for (const mem of typed) {
      sections.push(`### ${mem.name}: ${mem.description}`)
      sections.push(mem.content)
    }
  }

  return sections.join('\n')
}
```

### saveMemory() - 保存记忆

```typescript
saveMemory(name, description, type, content): string {
  // 1. 验证类型
  if (!['user', 'feedback', 'project', 'reference'].includes(type)) {
    return `Error: type must be one of [user, feedback, project, reference]`
  }

  // 2. 生成安全的文件名
  const safeName = name.toLowerCase().replace(/[^a-z0-9_-]/g, '_')

  // 3. 构建 frontmatter + 内容
  const frontmatter = `---\nname: ${name}\ndescription: ${description}\ntype: ${type}\n---\n${content}`

  // 4. 写入文件
  writeFileSync(join(this.memoryDir, `${safeName}.md`), frontmatter)

  // 5. 更新内存
  this.memories.set(name, { ... })

  // 6. 重建索引
  this.rebuildIndex()
}
```

### rebuildIndex() - 重建索引

```typescript
private rebuildIndex(): void {
  const lines = ['# Memory Index', '']

  for (const [name, mem] of this.memories) {
    lines.push(`- [${name}](${mem.file}) — ${mem.description} [${mem.type}]`)
    if (lines.length >= 200) break
  }

  writeFileSync(join(this.memoryDir, 'MEMORY.md'), lines.join('\n'))
}
```

### parseFrontmatter() - 解析 frontmatter

```typescript
private parseFrontmatter(text: string): ParsedMemory | null {
  const match = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/)
  if (!match) return null

  const header = match[1]
  const body = match[2]

  const result = { content: body.trim() }
  for (const line of header.split('\n')) {
    const [key, value] = line.split(':').map(s => s.trim())
    if (key === 'name') result.name = value
    else if (key === 'description') result.description = value
    else if (key === 'type') result.type = value
  }

  return result
}
```

## save_memory 工具

### 工具定义

```typescript
{
  name: 'save_memory',
  description: 'Save a persistent memory that survives across sessions.',
  input_schema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Short identifier' },
      description: { type: 'string', description: 'One-line summary' },
      type: { type: 'string', enum: ['user', 'feedback', 'project', 'reference'] },
      content: { type: 'string', description: 'Full memory content' },
    },
    required: ['name', 'description', 'type', 'content'],
  },
}
```

### handler 注入

```typescript
const handlers = {
  ...BASE_HANDLERS,
  save_memory: (input) =>
    memoryManager.saveMemory(input.name, input.description, input.type, input.content),
}
```

**为什么不直接改 BASE_HANDLERS？**

注入方式只影响当前 session，不污染全局。

## 系统提示词集成

### 每次调用 LLM 前重新构建

```typescript
function buildSystemPrompt(memoryManager: MemoryManager): string {
  const parts = [BASE_SYSTEM]

  // 注入记忆内容
  const memorySection = memoryManager.loadMemoryPrompt()
  if (memorySection) parts.push(memorySection)

  // 注入记忆使用指南
  parts.push(MEMORY_GUIDANCE)

  return parts.join('\n\n')
}

// 主循环中
while (true) {
  const system = buildSystemPrompt(memoryManager)  // 每次重新构建
  const response = await client.messages.create({ system, ... })
}
```

### 为什么每次都要重新构建？

因为 LLM 可能在同一会话中多次保存记忆。重新构建确保新记忆立即可见。

### MEMORY_GUIDANCE

```typescript
const MEMORY_GUIDANCE = `
When to save memories:
- User states a preference -> type: user
- User corrects you -> type: feedback
- Project fact not easy to infer from code -> type: project
- External resource pointer -> type: reference

When NOT to save:
- Anything easily derivable from code
- Temporary task state
- Secrets or credentials
`
```

## 主循环集成

### 会话开始

```typescript
async function main() {
  const memoryManager = new MemoryManager()
  memoryManager.loadAll()

  if (memoryManager.memories.size > 0) {
    console.log(`[${memoryManager.memories.size} memories loaded]`)
  } else {
    console.log('[No existing memories. The agent can create them with save_memory.]')
  }

  // REPL 循环...
}
```

### 主循环

```typescript
async function agentLoopWithMemory(messages, memoryManager) {
  const handlers = {
    ...BASE_HANDLERS,
    save_memory: (input) => memoryManager.saveMemory(...),
  }

  while (true) {
    const system = buildSystemPrompt(memoryManager)  // 每次重新构建
    const response = await client.messages.create({ system, ... })

    // 处理工具调用...
  }
}
```

## Dream 整理机制（可选）

### 为什么需要 Dream？

记忆会随时间增长，需要自动整理：合并、去重、清理过时记忆。

### 7 道门控检查

| 门控 | 检查什么             | 为什么             |
| ---- | -------------------- | ------------------ |
| 1    | enabled 标志         | 可以关闭 Dream     |
| 2    | 记忆目录存在且有文件 | 没记忆就不用整理   |
| 3    | 不在 plan 模式       | plan 模式只读      |
| 4    | 24 小时冷却          | 避免频繁整理       |
| 5    | 10 分钟扫描节流      | 避免频繁检查       |
| 6    | 至少 5 个会话        | 数据太少不值得整理 |
| 7    | 没有锁文件           | 避免并发冲突       |

### PID 锁机制

```
.memory/.dream_lock
内容："12345:1683456789.123"
       ↑      ↑
       PID    时间戳
```

防止多个会话同时整理记忆。

## 运行测试

```bash
pnpm s09
```

测试场景：

1. **测试 /memories 命令**：输入 `/memories` 查看当前记忆
2. **测试保存记忆**：说"我喜欢用 tab 缩进"，应该触发 save_memory
3. **测试记忆持久化**：退出后重新启动，看记忆是否还在

## 实战场景

### 保存用户偏好

```
用户："我喜欢用 tab 缩进"
LLM → save_memory({ name: "prefer_tabs", type: "user", ... })
下次会话：LLM 看到记忆 → 用 tab 缩进
```

### 保存项目知识

```
用户："auth 模块不能动，因为合规要求"
LLM → save_memory({ name: "auth_compliance", type: "project", ... })
```

### 保存外部资源

```
用户："bug 追踪在 Linear 的 INGEST 项目"
LLM → save_memory({ name: "linear_ingest", type: "reference", ... })
```

## 关键点提醒

1. **选择性存储**：不是所有信息都值得记住，只存"不容易重新推导"的
2. **4 种类型**：user、feedback、project、reference，各有用途
3. **frontmatter + body**：每个记忆是带元数据的 Markdown 文件
4. **系统提示词注入**：让 LLM 看到记忆，每次重新构建确保最新
5. **save_memory 工具**：LLM 可以主动保存，不需要用户手动操作

## 学完这章后，你应该能回答

- 为什么需要记忆系统？
- 什么应该存记忆，什么不应该？
- 记忆的 4 种类型分别是什么？
- 记忆文件的格式是什么（frontmatter + body）？
- 记忆如何注入到系统提示词？
- 为什么每次调用 LLM 前要重新构建系统提示词？
- save_memory 工具的参数有哪些？

---

**一句话记住：记忆只存"不容易重新推导"的信息，每次会话开始时加载到系统提示词。**
