/**
 * s11 Error Recovery
 * 错误恢复 REPL 入口
 *
 * 三条恢复路径：
 * 1. max_tokens → 注入续写消息
 * 2. prompt_too_long → 自动压缩
 * 3. connection error → 指数退避重试
 */

import readline from 'node:readline'
import { WORKDIR } from '../core/agent-loop'
import { BASE_TOOLS, BASE_HANDLERS } from '../core/tools'
import { MemoryManager, MEMORY_GUIDANCE } from '../persistence/memory'
import { SystemPromptBuilder } from '../persistence/prompt'
import { AnthropicAdapter } from '../persistence/adapter'
import {
  agentLoopWithRecovery,
  MAX_RECOVERY_ATTEMPTS,
  TOKEN_THRESHOLD,
  CONTINUATION_MESSAGE,
  countMessageTokens,
} from '../persistence/recovery'
import type { Message, ToolHandler } from '../core/types'

// ============================================================================
// 核心指令
// ============================================================================

const S11_BASE_SYSTEM = `You are a coding agent at ${WORKDIR}. Use tools to solve tasks.

You have a memory system that persists information across sessions.
When you learn something worth remembering, use save_memory to save it.

${MEMORY_GUIDANCE}

This agent has error recovery enabled:
- If your output is truncated, you will be asked to continue automatically.
- If the context grows too large, it will be compacted automatically.
- If the API has transient errors, retries will happen with exponential backoff.`

// ============================================================================
// REPL 入口
// ============================================================================

async function main() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  // 1. 创建适配器（用于精确 token 计算）
  const adapter = new AnthropicAdapter()

  // 2. 创建 MemoryManager 并加载记忆
  const memoryManager = new MemoryManager()
  memoryManager.loadAll()

  // 3. 创建 SystemPromptBuilder
  const promptBuilder = new SystemPromptBuilder({
    tools: BASE_TOOLS,
    memoryManager,
    baseSystem: S11_BASE_SYSTEM,
  })

  // 4. 显示启动信息
  const fullPrompt = promptBuilder.build()
  const tokenEstimate = adapter.countTokens(fullPrompt)
  console.log(`[System prompt: ${fullPrompt.length} chars, ${tokenEstimate} tokens]`)
  console.log(
    `[Error recovery enabled: max_tokens / prompt_too_long / connection backoff (max ${MAX_RECOVERY_ATTEMPTS} retries)]`,
  )
  console.log(`[Token threshold for proactive compact: ${TOKEN_THRESHOLD}]`)

  if (memoryManager.memories.size > 0) {
    console.log(`[${memoryManager.memories.size} memories loaded]`)
  } else {
    console.log('[No existing memories]')
  }

  // 5. 工具 handlers
  const handlers: Record<string, ToolHandler> = {
    ...BASE_HANDLERS,
    save_memory: (input) => {
      const result = memoryManager.saveMemory(
        input.name as string,
        input.description as string,
        input.type as string,
        input.content as string,
      )
      promptBuilder.invalidateCache()
      return result
    },
  }

  // 6. 消息历史
  const history: Message[] = []

  // 7. REPL 主循环
  while (true) {
    let query: string
    try {
      query = await new Promise<string>((resolve, reject) => {
        rl.question('\x1b[36ms11 >> \x1b[0m', (answer) => {
          if (answer === undefined) reject(new Error('EOF'))
          else resolve(answer)
        })
      })
    } catch {
      break
    }

    // 退出命令
    if (
      query.trim().toLowerCase() === 'q' ||
      query.trim().toLowerCase() === 'exit' ||
      !query.trim()
    ) {
      break
    }

    // /help 命令
    if (query.trim() === '/help') {
      console.log('Commands:')
      console.log('  /help      - Show this help message')
      console.log('  /status    - Show recovery config and token stats')
      console.log('  /compact   - Manually trigger auto-compact')
      console.log('  q/exit     - Exit the session')
      continue
    }

    // /status 命令 - 显示恢复配置和 token 统计
    if (query.trim() === '/status') {
      const estimatedTokens = countMessageTokens(history, adapter.countTokens.bind(adapter))
      console.log('Recovery config:')
      console.log(`  Max retries: ${MAX_RECOVERY_ATTEMPTS}`)
      console.log(`  Token threshold: ${TOKEN_THRESHOLD}`)
      console.log(`  Continuation message: "${CONTINUATION_MESSAGE.slice(0, 60)}..."`)
      console.log(`  Tokenizer: ${adapter.name}`)
      console.log(`Current context: ${history.length} messages, ${estimatedTokens} tokens`)
      continue
    }

    // /compact 命令 - 手动触发压缩
    if (query.trim() === '/compact') {
      if (history.length === 0) {
        console.log('  (no messages to compact)')
        continue
      }
      const beforeTokens = countMessageTokens(history, adapter.countTokens.bind(adapter))
      console.log(`[Compacting ${history.length} messages (~${beforeTokens} tokens)...]`)
      const { autoCompact } = await import('../persistence/recovery')
      const compacted = await autoCompact(history)
      history.length = 0
      history.push(...compacted)
      const afterTokens = countMessageTokens(history, adapter.countTokens.bind(adapter))
      console.log(`[Compacted to ${afterTokens} tokens]`)
      continue
    }

    // 正常请求 → 使用带恢复的 Agent Loop
    history.push({ role: 'user', content: query })

    await agentLoopWithRecovery(history, {
      tools: BASE_TOOLS,
      handlers,
      system: promptBuilder.build(),
      countTokens: adapter.countTokens.bind(adapter),
    })

    // 显示最后的回复
    const lastContent = history[history.length - 1]?.content
    if (Array.isArray(lastContent)) {
      for (const block of lastContent) {
        if (block.type === 'text') {
          console.log(block.text)
        }
      }
    }
    console.log('')
  }

  rl.close()
  console.log('Goodbye!')
}

main().catch(console.error)
