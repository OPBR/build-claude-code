/**
 * s11 Error Recovery
 * 错误恢复：分类错误 → 选择恢复路径 → 继续运行
 *
 * 三条恢复路径：
 * 1. Continuation（max_tokens 输出截断 → 注入续写消息）
 * 2. Compact（prompt_too_long 上下文溢出 → 自动压缩）
 * 3. Backoff（connection 网络错误 → 指数退避重试）
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import Anthropic from '@anthropic-ai/sdk'
import { client, MODEL, WORKDIR } from '../core/agent-loop'
import type {
  Message,
  ContentBlock,
  ToolResultBlock,
  ToolDefinition,
  ToolHandler,
  ErrorCategory,
  RecoveryDecision,
} from '../core/types'

// ============================================================================
// 常量
// ============================================================================

/** 最大重试次数 */
export const MAX_RECOVERY_ATTEMPTS = 3

/** 退避基数（毫秒） */
const BACKOFF_BASE_DELAY = 1000

/** 退避上限（毫秒） */
const BACKOFF_MAX_DELAY = 30000

/** 主动压缩的 token 阈值（字符数估算） */
export const TOKEN_THRESHOLD = 50000

/** 续写消息：明确说"不要重来、不要重复" */
export const CONTINUATION_MESSAGE =
  'Output limit hit. Continue directly from where you stopped -- ' +
  'no recap, no repetition. Pick up mid-sentence if needed.'

/** transcript 目录 */
const TRANSCRIPT_DIR = path.join(WORKDIR, '.transcripts')

// ============================================================================
// 错误分类
// ============================================================================

/**
 * 判断错误属于哪个类别
 * 分类先于动作：不同错误需要不同恢复策略
 */
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

/**
 * 根据错误类别选择恢复动作
 */
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

// ============================================================================
// 指数退避
// ============================================================================

/**
 * 计算退避延迟
 * 公式：min(base × 2^attempt, max) + jitter
 * jitter 防止 thundering-herd（多个客户端同时重试）
 */
export function backoffDelay(attempt: number): number {
  const delay = Math.min(BACKOFF_BASE_DELAY * Math.pow(2, attempt), BACKOFF_MAX_DELAY)
  const jitter = Math.random() * 1000 // 0~1 秒的随机抖动
  return delay + jitter
}

// ============================================================================
// 自动压缩
// ============================================================================

/**
 * 写 transcript（完整历史备份）
 * 压缩前先备份，确保磁盘上保留无损记录
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
 * autoCompact：用 LLM 摘要替换对话历史
 * 复用 s06 的 compactHistory 机制，但目的不同：
 * - s06 是主动维护（上下文卫生）
 * - s11 是被动补救（从 API 失败中恢复）
 */
export async function autoCompact(messages: Message[]): Promise<Message[]> {
  // 1. 先写 transcript（完整历史备份）
  const transcriptPath = await writeTranscript(messages)
  console.log(`\x1b[90m[transcript saved: ${path.relative(WORKDIR, transcriptPath)}]\x1b[0m`)

  // 2. 调 LLM 生成摘要
  let summary: string
  try {
    const conversation = JSON.stringify(messages).slice(0, 80000)
    const prompt =
      'Summarize this coding-agent conversation for continuity. Include:\n' +
      '1) Task overview and success criteria\n' +
      '2) Current state: completed work, files touched\n' +
      '3) Key decisions and failed approaches\n' +
      '4) Remaining next steps\n' +
      'Be concise but preserve critical details.\n\n' +
      conversation

    const response = await client.messages.create({
      model: MODEL,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 4000,
    })

    const textBlocks = response.content.filter((b) => b.type === 'text') as Array<{ text: string }>
    summary = textBlocks
      .map((b) => b.text)
      .join('\n')
      .trim()
  } catch (e) {
    summary = `(compact failed: ${(e as Error).message}). Previous context lost.`
  }

  // 返回只含摘要的简洁上下文
  return [
    {
      role: 'user',
      content:
        'This session continues from a previous conversation that was compacted.\n' +
        `Summary of prior context:\n\n${summary}\n\n` +
        'Continue from where we left off without re-asking the user.',
    },
  ]
}

// ============================================================================
// Token 计算
// ============================================================================

/**
 * 计算消息历史的 token 数
 * 使用适配器的 countTokens 精确计算（每个 provider 用自己的 tokenizer）
 */
export function countMessageTokens(
  messages: Message[],
  countTokens: (text: string) => number,
): number {
  return countTokens(JSON.stringify(messages))
}

// ============================================================================
// 带错误恢复的 Agent Loop
// ============================================================================

/** agentLoopWithRecovery 的配置 */
export interface RecoveryLoopOptions {
  tools: ToolDefinition[]
  handlers: Record<string, ToolHandler>
  system?: string
  countTokens: (text: string) => number
}

/**
 * 带错误恢复的 Agent Loop
 *
 * 三条恢复路径（first match wins）：
 * 1. max_tokens  → 注入续写消息，重试
 * 2. prompt_too_long → 自动压缩，重试
 * 3. connection error → 指数退避，重试
 * 4. 所有重试耗尽 → 优雅退出
 */
export async function agentLoopWithRecovery(
  messages: Message[],
  options: RecoveryLoopOptions,
): Promise<void> {
  const { tools, handlers, system, countTokens: tokenCounter } = options

  const systemPrompt =
    system ?? `You are a coding agent at ${WORKDIR}. Use tools to solve tasks. Act, don't explain.`

  const anthropicTools: Anthropic.Messages.Tool[] = tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema as Anthropic.Messages.Tool.InputSchema,
  }))

  // 连续 max_tokens 截断计数器
  let maxOutputRecoveryCount = 0

  while (true) {
    // ── API 调用 + 错误恢复 ──
    let response: Anthropic.Messages.Message | null = null

    for (let attempt = 0; attempt <= MAX_RECOVERY_ATTEMPTS; attempt++) {
      try {
        response = await client.messages.create({
          model: MODEL,
          system: systemPrompt,
          messages,
          tools: anthropicTools,
          max_tokens: 8000,
        })
        break // 成功，跳出重试循环
      } catch (error) {
        const category = classifyError(error)
        const decision = chooseRecovery(category, attempt)

        // 先检查是否还有重试次数
        if (attempt >= MAX_RECOVERY_ATTEMPTS) {
          console.log(
            `\x1b[31m[Error] ${decision.reason} (all ${MAX_RECOVERY_ATTEMPTS} retries exhausted)\x1b[0m`,
          )
          return
        }

        console.log(
          `\x1b[33m[Recovery] ${decision.reason} (attempt ${attempt + 1}/${MAX_RECOVERY_ATTEMPTS})\x1b[0m`,
        )

        if (decision.action === 'compact') {
          // 策略 2：上下文溢出 → 自动压缩
          messages.length = 0
          messages.push(...(await autoCompact(messages)))
          continue // 重试（用压缩后的历史）
        }

        if (decision.action === 'backoff') {
          // 策略 3：网络错误 → 指数退避
          const delay = backoffDelay(attempt)
          console.log(
            `\x1b[33m[Recovery] Waiting ${Math.round(delay / 1000)}s before retry...\x1b[0m`,
          )
          await new Promise((resolve) => setTimeout(resolve, delay))
          continue // 重试
        }

        // 无法恢复
        console.log(`\x1b[31m[Error] ${decision.reason}\x1b[0m`)
        return
      }
    }

    if (!response) {
      console.log('\x1b[31m[Error] No response received after all retries.\x1b[0m')
      return
    }

    // 记录 assistant 回复
    messages.push({
      role: 'assistant',
      content: response.content as ContentBlock[],
    })

    // ── 策略 1：max_tokens 输出截断 ──
    if (response.stop_reason === 'max_tokens') {
      maxOutputRecoveryCount++
      if (maxOutputRecoveryCount <= MAX_RECOVERY_ATTEMPTS) {
        console.log(
          `\x1b[33m[Recovery] max_tokens hit (${maxOutputRecoveryCount}/${MAX_RECOVERY_ATTEMPTS}). Injecting continuation...\x1b[0m`,
        )
        messages.push({ role: 'user', content: CONTINUATION_MESSAGE })
        continue // 重试循环
      }
      console.log('\x1b[31m[Error] max_tokens recovery exhausted. Stopping.\x1b[0m')
      return
    }

    // 成功的非 max_tokens 响应 → 重置计数器
    maxOutputRecoveryCount = 0

    // 正常退出（end_turn）
    if (response.stop_reason !== 'tool_use') {
      return
    }

    // ── 处理工具调用 ──
    const results: (ToolResultBlock | { type: 'text'; text: string })[] = []

    for (const block of response.content) {
      if (block.type !== 'tool_use') continue

      const toolBlock = block as Anthropic.Messages.ToolUseBlock
      const handler = handlers[toolBlock.name]

      if (!handler) {
        results.push({
          type: 'tool_result',
          tool_use_id: toolBlock.id,
          content: `Error: Unknown tool "${toolBlock.name}"`,
        })
        continue
      }

      console.log(`\x1b[33m> ${toolBlock.name}\x1b[0m`)

      let output: string
      try {
        output = await handler(toolBlock.input as Record<string, unknown>)
      } catch (e) {
        output = `Error: ${(e as Error).message}`
      }

      console.log(output.slice(0, 200))
      results.push({
        type: 'tool_result',
        tool_use_id: toolBlock.id,
        content: output,
      })
    }

    messages.push({
      role: 'user',
      content: results as ContentBlock[],
    })

    // ── 主动压缩检查（预防而非被动） ──
    const estimatedTokens = countMessageTokens(messages, tokenCounter)
    if (estimatedTokens > TOKEN_THRESHOLD) {
      console.log(
        `\x1b[33m[Recovery] Token estimate ${estimatedTokens} exceeds threshold ${TOKEN_THRESHOLD}. Auto-compacting...\x1b[0m`,
      )
      messages.length = 0
      messages.push(...(await autoCompact(messages)))
    }

    // 循环继续...
  }
}
