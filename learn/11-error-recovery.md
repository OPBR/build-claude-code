# 11 - Error Recovery

## 学习目标

- 理解错误恢复的核心思想：分类先于动作
- 实现 `classifyError()` — 关键词匹配分类错误
- 实现 `chooseRecovery()` — 类别到动作的结构化映射
- 实现 `backoffDelay()` — 指数退避 + 随机抖动
- 实现 `autoCompact()` — LLM 摘要替换对话历史（含 transcript 备份）
- 实现 `countMessageTokens()` — 依赖注入的 Token 计算
- 实现 `agentLoopWithRecovery()` — 三条恢复路径嵌入主循环
- 理解主动压缩 vs 被动压缩的双保险策略
- 理解 ProviderAdapter.countTokens 的多模型适配

## 核心概念

### 问题背景

到了 s10，Agent 的"骨架"已经搭好了：

| 阶段 | 能力            | 说明               |
| ---- | --------------- | ------------------ |
| s01  | Agent Loop      | 循环调用 LLM       |
| s02  | Tool Use        | 操作文件、执行命令 |
| s05  | Skill Loader    | 按需加载知识       |
| s06  | Context Compact | 上下文不会撑爆     |
| s08  | Hook System     | 固定时机插入行为   |
| s09  | Memory System   | 跨会话记忆         |
| s10  | System Prompt   | 动态组装提示词     |

但这些都是**正向通路** — 假设一切顺利。现实世界中，API 调用不会永远顺利：

| 异常场景                              | 后果                 |
| ------------------------------------- | -------------------- |
| 模型输出被截断（max_tokens）          | 回复不完整，任务中断 |
| 上下文超出窗口限制（prompt_too_long） | API 直接报错         |
| 网络抖动、限流、超时                  | 请求失败，Agent 崩溃 |

一个没有错误恢复能力的 Agent，遇到任何异常都会直接崩溃 — 之前的对话历史、任务上下文，全部丢失。

### 解决方案

> **"分类错误 → 选择恢复路径 → 继续运行。不要让 Agent 因为可恢复的错误而崩溃。"**

类比餐厅厨房的应急方案：

```text
正常流程：
  点单 → 做菜 → 上菜

应急方案：
  食材缺了  → 换一道菜（prompt_too_long → compact）
  燃气断了  → 等恢复后继续（connection_error → backoff）
  菜做太长  → 先上半份，继续做（max_tokens → continuation）

每种异常有对应的处理方案，而不是直接关店。
```

## 三条恢复路径

### 路径总览

| 路径             | 触发条件                                  | 恢复动作                       | 处理位置       |
| ---------------- | ----------------------------------------- | ------------------------------ | -------------- |
| **Continuation** | `stop_reason === 'max_tokens'`            | 注入续写消息                   | API 成功后检查 |
| **Compact**      | `classifyError` 返回 `'prompt_too_long'`  | 调用 LLM 生成摘要，替换历史    | catch 分支     |
| **Backoff**      | `classifyError` 返回 `'connection_error'` | `sleep(backoffDelay(attempt))` | catch 分支     |

**关键区分**：`max_tokens` 不是 API 错误 — API 调用成功了，只是 `stop_reason` 是 `'max_tokens'` 而不是 `'end_turn'`。所以它在正常响应处理处，不在 catch 块里。

```text
API 调用
├─ 成功（无异常）
│  ├─ stop_reason === 'max_tokens'  → 路径 1：注入续写消息
│  ├─ stop_reason === 'tool_use'    → 执行工具
│  └─ stop_reason === 'end_turn'    → 正常结束
│
└─ 失败（抛异常）→ catch 块
   ├─ prompt_too_long  → 路径 2：autoCompact
   ├─ connection_error → 路径 3：指数退避重试
   └─ unknown          → 优雅退出
```

### 路径 1：Continuation（输出截断续写）

**问题**：模型输出太长，被 `max_tokens` 截断，回复不完整。

**方案**：检测到 `stop_reason === 'max_tokens'` 后，注入一条续写消息：

```typescript
export const CONTINUATION_MESSAGE =
  'Output limit hit. Continue directly from where you stopped -- ' +
  'no recap, no repetition. Pick up mid-sentence if needed.'
```

核心策略：**明确说"不要重来、不要重复"**。如果不加这个约束，模型可能会从头复述一遍。

```typescript
// 在 agentLoopWithRecovery 中
if (response.stop_reason === 'max_tokens') {
  maxOutputRecoveryCount++
  if (maxOutputRecoveryCount <= MAX_RECOVERY_ATTEMPTS) {
    messages.push({ role: 'user', content: CONTINUATION_MESSAGE })
    continue // 重试循环
  }
  return
}
```

### 路径 2：Compact（上下文溢出压缩）

**问题**：对话历史太长，超出模型的上下文窗口，API 返回 `prompt_too_long` 错误。

**方案**：先备份完整历史到磁盘，再用 LLM 生成摘要替换。

```typescript
export async function autoCompact(messages: Message[]): Promise<Message[]> {
  // 1. 先写 transcript（完整历史备份）
  const transcriptPath = await writeTranscript(messages)

  // 2. 调 LLM 生成摘要
  const conversation = JSON.stringify(messages).slice(0, 80000)
  const prompt = 'Summarize this coding-agent conversation for continuity...'
  const response = await client.messages.create({
    model: MODEL,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 4000,
  })

  // 3. 返回只含摘要的简洁上下文
  return [
    {
      role: 'user',
      content: `Summary of prior context:\n\n${summary}\n\nContinue from where we left off.`,
    },
  ]
}
```

**关键设计**：压缩是**内存有损、磁盘无损**的操作。transcript 写到 `.transcripts/transcript_{timestamp}.jsonl`，永不修改、永不删除。

### 路径 3：Backoff（网络错误退避重试）

**问题**：网络抖动、限流、超时等瞬时错误。

**方案**：指数退避 + 随机抖动。

```typescript
export function backoffDelay(attempt: number): number {
  const delay = Math.min(BACKOFF_BASE_DELAY * Math.pow(2, attempt), BACKOFF_MAX_DELAY)
  const jitter = Math.random() * 1000
  return delay + jitter
}
```

公式：`min(base × 2^attempt, max) + jitter`

| attempt | 计算             | 大约等待 |
| ------- | ---------------- | -------- |
| 0       | 1000 × 2⁰ + ~500 | ~1.5s    |
| 1       | 1000 × 2¹ + ~500 | ~2.5s    |
| 2       | 1000 × 2² + ~500 | ~4.5s    |

**为什么加 jitter？** 如果多个 Agent 同时遇到限流，没有 jitter 的话它们会在同一时刻重试，造成"惊群效应"（thundering herd）。随机抖动让重试时间分散开。

## 错误分类

### classifyError

```typescript
export function classifyError(error: unknown): ErrorCategory {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase()

  // 上下文溢出
  if (
    message.includes('overlong_prompt') ||
    (message.includes('prompt') && message.includes('long'))
  ) {
    return 'prompt_too_long'
  }

  // 网络错误
  if (
    message.includes('connection') ||
    message.includes('timeout') ||
    message.includes('rate') ||
    message.includes('429') ||
    message.includes('529') ||
    message.includes('network')
  ) {
    return 'connection_error'
  }

  return 'unknown'
}
```

**设计选择**：用关键词匹配而不是异常类型。因为不同 provider 抛出的错误格式不同，但关键词相对稳定。

### chooseRecovery

```typescript
export function chooseRecovery(category: ErrorCategory, attempt: number): RecoveryDecision {
  const maxAttempts = MAX_RECOVERY_ATTEMPTS

  switch (category) {
    case 'prompt_too_long':
      return {
        category,
        action: 'compact',
        attempt,
        maxAttempts,
        reason: 'Context too long for model window. Compact and retry.',
      }
    case 'connection_error':
      return {
        category,
        action: 'backoff',
        attempt,
        maxAttempts,
        reason: 'Transient transport error. Back off and retry.',
      }
    default:
      return {
        category,
        action: 'fail',
        attempt,
        maxAttempts,
        reason: 'Unknown error. Cannot recover.',
      }
  }
}
```

**为什么用结构化返回而不是直接执行？**

| 做法       | 问题                                                                                    |
| ---------- | --------------------------------------------------------------------------------------- |
| 直接执行   | `catch (e) { if (timeout) sleep(1000); retry() }` — 逻辑藏在 catch 块里，难以测试和日志 |
| 结构化返回 | `const decision = chooseRecovery(category, attempt)` — 决策和执行分离，可测试、可日志   |

## Token 计算

### 为什么需要精确 Token 计算

s06 的主动压缩用的是字符数估算（`JSON.stringify(messages).length`），误差较大。s11 引入了精确的 tokenizer：

| Provider  | Tokenizer                    | 说明                            |
| --------- | ---------------------------- | ------------------------------- |
| Anthropic | `@anthropic-ai/tokenizer`    | 官方 tokenizer，和 API 计费一致 |
| OpenAI    | `js-tiktoken`（cl100k_base） | OpenAI 的 BPE tokenizer         |

### 依赖注入模式

```typescript
export function countMessageTokens(
  messages: Message[],
  countTokens: (text: string) => number, // 注入的计数函数
): number {
  return countTokens(JSON.stringify(messages))
}
```

不直接依赖具体的 tokenizer，而是通过参数注入。调用方决定用哪个：

```typescript
// 使用 Anthropic tokenizer
const adapter = new AnthropicAdapter()
countMessageTokens(history, adapter.countTokens.bind(adapter))
```

### ProviderAdapter.countTokens

```typescript
export interface ProviderAdapter {
  name: string
  formatSystem(system: string): unknown
  formatTools(tools: ToolDefinition[]): unknown[]
  buildRequest(params: LLMRequestParams): Record<string, unknown>
  parseResponse(response: unknown): NormalizedResponse
  countTokens(text: string): number // s11 新增
}

// Anthropic 适配器
export class AnthropicAdapter implements ProviderAdapter {
  countTokens(text: string): number {
    return anthropicCountTokens(text)
  }
}

// OpenAI 适配器
export class OpenAIAdapter implements ProviderAdapter {
  private enc = getEncoding('cl100k_base')
  countTokens(text: string): number {
    return this.enc.encode(text).length
  }
}
```

## 主动压缩 vs 被动压缩

这是理解 s11 最关键的对比。两者都调 `autoCompact()`，但触发时机和目的完全不同：

| 维度     | 主动压缩（Proactive）       | 被动压缩（Passive）               |
| -------- | --------------------------- | --------------------------------- |
| 触发时机 | 每轮工具执行后检查 token 数 | API 返回 `prompt_too_long` 错误时 |
| 目的     | 预防上下文溢出              | 从上下文溢出中恢复                |
| 类比     | 定期体检                    | 急诊治疗                          |
| 来源     | s06 的延续                  | s11 新增                          |

```text
主动压缩（每轮检查）：
  工具执行完毕 → countMessageTokens > 50000? → autoCompact

被动压缩（错误触发）：
  API 报错 prompt_too_long → classifyError → autoCompact → 重试
```

**两者的关系**：主动压缩是第一道防线，被动压缩是兜底。正常情况下主动压缩会把 token 数控制在阈值以下，被动压缩永远不会触发。但如果某一轮消息突然暴涨（比如工具返回了超大结果），主动压缩来不及检查，被动压缩就会介入。

## 完整流程

```text
agentLoopWithRecovery(messages, options)
│
├─┐ while (true)
│ │
│ │  ┌─ API 调用重试循环 (attempt 0..3) ─────────────────────┐
│ │  │                                                        │
│ │  │  response = await callLLM(messages)                    │
│ │  │         │                                              │
│ │  │    成功? ──Yes──→ break                                │
│ │  │         │                                              │
│ │  │    No (catch)                                          │
│ │  │         │                                              │
│ │  │    classifyError(error) → chooseRecovery               │
│ │  │         │                                              │
│ │  │    ┌────┴────┐                                         │
│ │  │    │         │                                         │
│ │  │ prompt_   connection_                                  │
│ │  │ too_long  error                                        │
│ │  │    │         │                                         │
│ │  │ autoCompact  backoffDelay                              │
│ │  │    │         │                                         │
│ │  │ continue    sleep → continue                           │
│ │  └────────────────────────────────────────────────────────┘
│ │
│ │  messages.push(assistant response)
│ │
│ │  ┌─ stop_reason 分支 ────────────────────────────────────┐
│ │  │                                                        │
│ │  │  max_tokens? ──Yes──→ 注入 CONTINUATION_MESSAGE        │
│ │  │                    → continue（重试循环）                │
│ │  │                                                        │
│ │  │  end_turn? ──Yes──→ return（正常退出）                  │
│ │  │                                                        │
│ │  │  tool_use? ──Yes──→ 执行工具                           │
│ │  └────────────────────────────────────────────────────────┘
│ │
│ │  ┌─ 主动压缩检查 ────────────────────────────────────────┐
│ │  │  countMessageTokens > TOKEN_THRESHOLD?                 │
│ │  │    → autoCompact(messages)                             │
│ │  └────────────────────────────────────────────────────────┘
│ │
└─┘ 循环继续
```

## 文件清单

| 文件                                 | 内容                                                                          |
| ------------------------------------ | ----------------------------------------------------------------------------- |
| `src/core/types.ts`                  | `ErrorCategory`、`RecoveryDecision` 类型定义                                  |
| `src/persistence/recovery.ts`        | 核心恢复逻辑（classify、choose、backoff、autoCompact、agentLoopWithRecovery） |
| `src/persistence/adapter.ts`         | `countTokens` 方法（Anthropic + OpenAI）                                      |
| `src/sessions/s11-error-recovery.ts` | REPL 入口（/status、/compact 命令）                                           |
| `src/index.ts`                       | 导出 s11 公共 API                                                             |

## 关键常量

| 常量                    | 值                                       | 说明                  |
| ----------------------- | ---------------------------------------- | --------------------- |
| `MAX_RECOVERY_ATTEMPTS` | 3                                        | 最大重试次数          |
| `BACKOFF_BASE_DELAY`    | 1000ms                                   | 退避基数              |
| `BACKOFF_MAX_DELAY`     | 30000ms                                  | 退避上限              |
| `TOKEN_THRESHOLD`       | 50000                                    | 主动压缩的 token 阈值 |
| `CONTINUATION_MESSAGE`  | "Output limit hit. Continue directly..." | 续写提示词            |

## s06 vs s11

| 维度       | s06 compact.ts                                           | s11 recovery.ts                                               |
| ---------- | -------------------------------------------------------- | ------------------------------------------------------------- |
| 目的       | 主动维护（上下文卫生）                                   | 被动补救（从错误中恢复）                                      |
| 触发       | token 数超阈值，或手动 `/compact`                        | API 返回 `prompt_too_long`，或 token 数超阈值                 |
| Token 计算 | 字符数估算                                               | 精确 tokenizer                                                |
| Transcript | ✅ 有备份                                                | ✅ 有备份（补上了）                                           |
| 摘要提示词 | 保留：goal、findings、files、remaining work、constraints | 保留：task overview、current state、key decisions、next steps |

## 测试方法

```bash
pnpm s11
```

### 测试 connection_error

网络不通或 API key 无效时自动触发。输出：

```text
[Recovery] Transient transport error. Back off and retry. (attempt 1/3)
[Recovery] Waiting 2s before retry...
[Recovery] Transient transport error. Back off and retry. (attempt 2/3)
[Recovery] Waiting 3s before retry...
[Recovery] Transient transport error. Back off and retry. (attempt 3/3)
[Recovery] Waiting 5s before retry...
[Error] Transient transport error. (all 3 retries exhausted)
```

### 测试 max_tokens

临时把 `recovery.ts` 的 `max_tokens` 改成 50，然后问一个需要长回答的问题。

### 测试 prompt_too_long

临时在 `classifyError` 里加一行：`if (message.includes('test overflow')) return 'prompt_too_long'`

### REPL 命令

- `/help` — 显示帮助
- `/status` — 查看恢复配置和 token 统计
- `/compact` — 手动触发压缩
- `q` / `exit` — 退出
