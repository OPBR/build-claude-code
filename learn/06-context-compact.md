# 06 - Context Compact (s06)

## 核心概念

> **"Keep working, keep compact"**

上下文不是越多越好，而是要把"仍然有用的部分"留在活跃工作面里。三层压缩策略：大结果持久化、旧结果微压缩、整体摘要。

s06 的核心是**上下文压缩**，不是"删除历史"。

**关键洞察：压缩的核心，是让模型在更短的活跃上下文里，仍然保住继续工作的连续性。**

## ASCII 架构图

```
tool output
   |
   +-- 太大 (>30KB) -----------> 保存到磁盘 + 留预览 (2KB)
   |                            .task_outputs/tool-results/
   v
messages
   |
   +-- 太旧 (非最近3轮) --------> 替换成占位提示
   |                            "[Earlier tool result compacted...]"
   v
if whole context still too large (>50KB):
   |
   v
compact history -> summary          .transcripts/transcript_xxx.jsonl
   |
   v
新的简洁上下文（只含摘要）
```

三层策略：持久化 → 微压缩 → 完整摘要。

## 数据结构

```typescript
// src/core/types.ts

/** 上下文压缩状态 */
interface CompactState {
  hasCompacted: boolean // 是否已做过完整压缩
  lastSummary: string // 最近一次压缩摘要
  recentFiles: string[] // 最近碰过的文件路径（压缩后可追踪）
}
```

## 配置常量

```typescript
// src/persistence/compact.ts

/** 上下文上限（估算） */
export const CONTEXT_LIMIT = 50000

/** 保留最近几个完整工具结果 */
const KEEP_RECENT_TOOL_RESULTS = 3

/** 输出超过多少写磁盘 */
const PERSIST_THRESHOLD = 30000

/** 预览字符数 */
const PREVIEW_CHARS = 2000
```

## 第 1 层：persistLargeOutput

```typescript
// src/persistence/compact.ts
export async function persistLargeOutput(toolUseId: string, output: string): Promise<string> {
  if (output.length <= PERSIST_THRESHOLD) {
    return output // 不大，直接返回
  }

  // 写磁盘
  const storedPath = `.task_outputs/tool-results/${toolUseId}.txt`
  await fs.writeFile(storedPath, output, 'utf-8')

  // 返回标记（含预览）
  return `<persisted-output>
Full output saved to: ${storedPath}
Preview:
${output.slice(0, PREVIEW_CHARS)}
</persisted-output>`
}
```

**关键思想**：让模型知道"发生了什么"，但不强迫它背着整份大输出。

## 第 2 层：microCompact

```typescript
// src/persistence/compact.ts
export function microCompact(messages: Message[]): Message[] {
  const toolResults = collectToolResultBlocks(messages)

  if (toolResults.length <= KEEP_RECENT_TOOL_RESULTS) {
    return messages // 不多，不压缩
  }

  // 只保留最近 3 个，更旧的改占位
  const oldResults = toolResults.slice(0, -KEEP_RECENT_TOOL_RESULTS)

  for (const { block } of oldResults) {
    if (block.content.length > 120) {
      block.content = '[Earlier tool result compacted. Re-run the tool if you need full detail.]'
    }
  }

  return messages
}
```

**关键思想**：不是删历史，是把细节搬走，让系统继续工作。

## 第 3 层：compactHistory

```typescript
// src/persistence/compact.ts
export async function compactHistory(
  messages: Message[],
  state: CompactState,
  focus?: string,
): Promise<Message[]> {
  // 1. 先写 transcript（完整历史备份）
  const transcriptPath = await writeTranscript(messages)

  // 2. 调 LLM 生成摘要
  let summary = await summarizeHistory(messages)

  // 3. 添加 focus 信息（手动压缩时）
  if (focus) {
    summary += `\n\nFocus to preserve next: ${focus}`
  }

  // 4. 添加 recent files 信息
  if (state.recentFiles.length > 0) {
    const recentLines = state.recentFiles.map((f) => `- ${f}`).join('\n')
    summary += `\n\nRecent files to reopen if needed:\n${recentLines}`
  }

  // 5. 更新状态
  state.hasCompacted = true
  state.lastSummary = summary

  // 6. 返回新的简洁上下文
  return [
    {
      role: 'user',
      content: `This conversation was compacted so the agent can continue working.\n\n${summary}`,
    },
  ]
}
```

## 摘要必须保住的内容

```text
Prompt: "Summarize this coding-agent conversation so work can continue.
Preserve:
1. The current goal           ← 当前目标
2. Important findings         ← 重要发现
3. Files read or changed      ← 已修改文件
4. Remaining work             ← 剩余工作
5. User constraints           ← 用户约束
Be compact but concrete."
```

**如果这些没保住，压缩虽然腾出了空间，却打断了工作连续性。**

## compact 工具定义

```typescript
// src/persistence/compact.ts
export const COMPACT_TOOL_DEFINITION: ToolDefinition = {
  name: 'compact',
  description:
    'Summarize earlier conversation so work can continue in a smaller context. Use when the conversation gets too long.',
  input_schema: {
    type: 'object',
    properties: {
      focus: { type: 'string', description: 'Specific focus to preserve in summary' },
    },
  },
}
```

手动触发 `compact` 工具 = 模型主动说"上下文太长了，帮我压缩一下"。

## 主循环接入

```typescript
// src/sessions/s06-context-compact.ts
async function agentLoopWithCompact(
  messages: Message[],
  state: CompactState,
  tools: ToolDefinition[],
): Promise<void> {
  while (true) {
    // 每轮开始前做微压缩
    messages = microCompact(messages)

    // 检查是否需要完整压缩
    if (estimateContextSize(messages) > CONTEXT_LIMIT) {
      console.log('[auto compact]')
      messages = await compactHistory(messages, state)
    }

    // 调用模型
    const response = await client.messages.create({
      model: MODEL,
      system: S06_SYSTEM,
      messages,
      tools,
    })

    // ... 执行工具 ...

    // 手动压缩
    if (manualCompact) {
      console.log('[manual compact]')
      messages = await compactHistory(messages, state, focus)
    }
  }
}
```

## 相对 s05 的变更

| 组件     | s05                   | s06                           |
| -------- | --------------------- | ----------------------------- |
| Tools    | 5 (base + load_skill) | 5 (base + compact)            |
| 核心机制 | 按需知识加载          | 三层上下文压缩                |
| 解决问题 | Prompt 臃肿           | 上下文膨胀                    |
| 新增目录 | skills/\*/            | .task_outputs/, .transcripts/ |

**s05 管理"知道的事"，s06 管理"历史长度"。两者互补。**

## 运行测试

```bash
pnpm run s06

# 测试对话示例
s06 >> 分析整个项目的文件结构
> bash
...输出...
> read_file
...读取文件...

# 多轮后自动压缩
[auto compact]
[transcript saved: .transcripts/transcript_xxx.jsonl]

# 手动压缩
s06 >> compact
[manual compact]
[transcript saved: .transcripts/transcript_xxx.jsonl]

s06 >> q
```

## Compact vs Memory 的边界

| 类型        | 解决什么问题       | 加载时机         |
| ----------- | ------------------ | ---------------- |
| **compact** | 当前会话太长怎么办 | 会话内，按需触发 |
| **memory**  | 跨会话值得保留什么 | 新会话启动时加载 |

**混淆后果**：compact 不持久化，memory 不处理"当前太长"。

## 常见误区

### ❌ 以为压缩等于删除

不是。是把"不必常驻活跃上下文"的内容换一种表示，全文还在磁盘上。

### ❌ 只在撞上限后临时乱补

更好做法：三层策略从一开始就有：

- 大结果先落盘
- 旧结果先缩短
- 整体过长再摘要

### ❌ 摘要只写成一句空话

如果摘要没有保住文件、决定、下一步，它对继续工作没有帮助。

### ❌ 压缩后工作连续性断掉

压缩的核心目的：让模型在更短的上下文里，**仍然能继续干活**。

## 教学边界

s06 是**三层压缩教学版**，不是完整产品化系统：

| 特性       | s06 Compact | 生产级 Compact |
| ---------- | ----------- | -------------- |
| 持久化位置 | 单一目录    | 多存储后端     |
| 压缩触发   | 简单阈值    | 多维度判断     |
| 摘要格式   | 单次 LLM    | 分层渐进       |
| 恢复机制   | 手动重跑    | 智能回溯       |

先做三层正确模型，再做高级功能。

## 下一步

s07 将展示：**文件持久化任务板 + 依赖图。Task System 如何管理长期任务。**

---

**Session 06 完成 ✓**

- 理解了上下文膨胀的根本原因
- 实现了三层压缩策略（持久化 + 微压缩 + 摘要）
- 理解了摘要必须保住的内容（目标、文件、决定、下一步）
- 理解了手动压缩和自动压缩的触发逻辑
- 运行了 s06 REPL 测试
