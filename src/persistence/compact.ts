/**
 * Context Compact - 上下文压缩
 * s06: 三层压缩策略实现无限会话
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import Anthropic from '@anthropic-ai/sdk'
import { client, MODEL, WORKDIR } from '../core/agent-loop'
import type {
  Message,
  ToolResultBlock,
  ToolDefinition,
  ToolInputSchema,
  CompactState,
} from '../core/types'

// ============================================================================
// 配置常量
// ============================================================================

/** 上下文上限（估算） */
export const CONTEXT_LIMIT = 50000

/** 保留最近几个完整工具结果 */
const KEEP_RECENT_TOOL_RESULTS = 3

/** 输出超过多少写磁盘 */
const PERSIST_THRESHOLD = 30000

/** 预览字符数 */
const PREVIEW_CHARS = 2000

/** transcript 目录 */
const TRANSCRIPT_DIR = path.join(WORKDIR, '.transcripts')

/** tool results 目录 */
const TOOL_RESULTS_DIR = path.join(WORKDIR, '.task_outputs', 'tool-results')

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 估算上下文大小
 */
export function estimateContextSize(messages: Message[]): number {
  return JSON.stringify(messages).length
}

/**
 * 记录最近访问的文件
 */
export function trackRecentFile(state: CompactState, filePath: string): void {
  // 已存在则移除（保持最新在后）
  const index = state.recentFiles.indexOf(filePath)
  if (index !== -1) {
    state.recentFiles.splice(index, 1)
  }
  state.recentFiles.push(filePath)
  // 只保留最近 5 个
  if (state.recentFiles.length > 5) {
    state.recentFiles = state.recentFiles.slice(-5)
  }
}

// ============================================================================
// 第 1 层：大结果持久化
// ============================================================================

/**
 * 持久化大工具输出
 * @param toolUseId 工具调用 ID
 * @param output 输出内容
 * @returns 如果太大，返回 persisted-output 标记；否则返回原内容
 */
export async function persistLargeOutput(toolUseId: string, output: string): Promise<string> {
  if (output.length <= PERSIST_THRESHOLD) {
    return output
  }

  // 创建目录
  await fs.mkdir(TOOL_RESULTS_DIR, { recursive: true })

  // 写磁盘
  const storedPath = path.join(TOOL_RESULTS_DIR, `${toolUseId}.txt`)
  await fs.writeFile(storedPath, output, 'utf-8')

  // 生成预览标记
  const preview = output.slice(0, PREVIEW_CHARS)
  const relPath = path.relative(WORKDIR, storedPath)

  return `<persisted-output>
Full output saved to: ${relPath}
Preview:
${preview}
</persisted-output>`
}

// ============================================================================
// 第 2 层：微压缩
// ============================================================================

/**
 * 收集 messages 中的 tool_result blocks
 */
function collectToolResultBlocks(
  messages: Message[],
): Array<{ messageIndex: number; blockIndex: number; block: ToolResultBlock }> {
  const blocks: Array<{ messageIndex: number; blockIndex: number; block: ToolResultBlock }> = []

  for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
    const message = messages[messageIndex]
    if (message.role !== 'user' || !Array.isArray(message.content)) {
      continue
    }

    for (let blockIndex = 0; blockIndex < message.content.length; blockIndex++) {
      const block = message.content[blockIndex]
      if (typeof block === 'object' && block.type === 'tool_result') {
        blocks.push({ messageIndex, blockIndex, block: block as ToolResultBlock })
      }
    }
  }

  return blocks
}

/**
 * 微压缩：只保留最近 3 个完整结果，更旧的改占位
 */
export function microCompact(messages: Message[]): Message[] {
  const toolResults = collectToolResultBlocks(messages)

  if (toolResults.length <= KEEP_RECENT_TOOL_RESULTS) {
    return messages
  }

  // 只压缩旧的（非最近 3 个）
  const oldResults = toolResults.slice(0, -KEEP_RECENT_TOOL_RESULTS)

  for (const { block } of oldResults) {
    const content = block.content
    if (typeof content !== 'string' || content.length <= 120) {
      continue
    }
    // 替换为占位提示
    block.content = '[Earlier tool result compacted. Re-run the tool if you need full detail.]'
  }

  return messages
}

// ============================================================================
// 第 3 层：完整压缩
// ============================================================================

/**
 * 写 transcript（完整历史备份）
 */
async function writeTranscript(messages: Message[]): Promise<string> {
  await fs.mkdir(TRANSCRIPT_DIR, { recursive: true })

  const timestamp = Math.floor(Date.now() / 1000)
  const transcriptPath = path.join(TRANSCRIPT_DIR, `transcript_${timestamp}.jsonl`)

  const lines = messages.map((m) => JSON.stringify(m))
  await fs.writeFile(transcriptPath, lines.join('\n'), 'utf-8')

  return transcriptPath
}

/**
 * 调 LLM 生成历史摘要
 */
async function summarizeHistory(messages: Message[]): Promise<string> {
  const conversation = JSON.stringify(messages).slice(0, 80000)

  const prompt = `Summarize this coding-agent conversation so work can continue.
Preserve:
1. The current goal
2. Important findings and decisions
3. Files read or changed
4. Remaining work
5. User constraints and preferences
Be compact but concrete.

${conversation}`

  const response = await client.messages.create({
    model: MODEL,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 2000,
  })

  // 提取文本
  const textBlocks = response.content.filter(
    (b) => b.type === 'text',
  ) as Anthropic.Messages.TextBlock[]
  return textBlocks
    .map((b) => b.text)
    .join('\n')
    .trim()
}

/**
 * 完整压缩历史
 * @param messages 消息历史
 * @param state 压缩状态
 * @param focus 可选的关注点（手动压缩时指定）
 */
export async function compactHistory(
  messages: Message[],
  state: CompactState,
  focus?: string,
): Promise<Message[]> {
  // 1. 先写 transcript（完整历史备份）
  const transcriptPath = await writeTranscript(messages)
  console.log(`[transcript saved: ${path.relative(WORKDIR, transcriptPath)}]`)

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

// ============================================================================
// compact 工具定义
// ============================================================================

/**
 * compact 工具定义
 */
export const COMPACT_TOOL_DEFINITION: ToolDefinition = {
  name: 'compact',
  description:
    'Summarize earlier conversation so work can continue in a smaller context. Use when the conversation gets too long.',
  input_schema: {
    type: 'object',
    properties: {
      focus: {
        type: 'string',
        description: 'Specific focus to preserve in summary',
      },
    },
  } as ToolInputSchema,
}

// ============================================================================
// 创建初始 CompactState
// ============================================================================

/**
 * 创建初始压缩状态
 */
export function createCompactState(): CompactState {
  return {
    hasCompacted: false,
    lastSummary: '',
    recentFiles: [],
  }
}
