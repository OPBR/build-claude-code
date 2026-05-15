/**
 * s10 System Prompt
 * 系统提示词管道组装 REPL 入口
 *
 * 核心特性：
 * - 6 个 section 独立组装
 * - 稳定/动态分离（DYNAMIC_BOUNDARY）
 * - CLAUDE.md 三层加载
 * - 缓存优化
 * - Token 预算
 * - 注入防护三层防御
 */

import readline from 'node:readline'
import Anthropic from '@anthropic-ai/sdk'
import { client, MODEL, WORKDIR } from '../core/agent-loop'
import { BASE_TOOLS, BASE_HANDLERS } from '../core/tools'
import { MemoryManager, MEMORY_GUIDANCE } from '../persistence/memory'
import {
  SystemPromptBuilder,
  DYNAMIC_BOUNDARY,
  buildSystemReminder,
  wrapAsData,
  sanitizeForPrompt,
  detectPromptLeakage,
  estimateTokens,
} from '../persistence/prompt'
import type {
  Message,
  ToolResultBlock,
  ContentBlock,
  ToolUseBlock,
  TextBlock,
  ToolHandler,
} from '../core/types'

// ============================================================================
// 核心指令（包含记忆使用指南）
// ============================================================================

const S10_BASE_SYSTEM = `You are a coding agent at ${WORKDIR}. Use tools to solve tasks.

You have a memory system that persists information across sessions.
When you learn something worth remembering, use save_memory to save it.

${MEMORY_GUIDANCE}`

// ============================================================================
// 主循环
// ============================================================================

async function agentLoop(
  messages: Message[],
  promptBuilder: SystemPromptBuilder,
  handlers: Record<string, ToolHandler>,
): Promise<void> {
  const anthropicTools: Anthropic.Messages.Tool[] = BASE_TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema as Anthropic.Messages.Tool.InputSchema,
  }))

  while (true) {
    // 1. 构建系统提示词（使用 SystemPromptBuilder）
    const system = promptBuilder.build()

    // 2. 调用模型
    const response = await client.messages.create({
      model: MODEL,
      system,
      messages,
      tools: anthropicTools,
      max_tokens: 8000,
    })

    // 3. 记录 assistant 回复
    const assistantContent: ContentBlock[] = response.content.map((block) => {
      if (block.type === 'text') {
        return { type: 'text', text: block.text } as TextBlock
      }
      if (block.type === 'tool_use') {
        return {
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: block.input as Record<string, unknown>,
        } as ToolUseBlock
      }
      return { type: 'text', text: JSON.stringify(block) } as TextBlock
    })
    messages.push({ role: 'assistant', content: assistantContent })

    // 4. 输出校验（第 3 层防御）
    const outputText = assistantContent
      .filter((b): b is TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')

    if (outputText) {
      const { leaked, similarity } = detectPromptLeakage(outputText, system)
      if (leaked) {
        console.log(
          `\x1b[33m[Security] Possible prompt leakage detected (similarity: ${similarity})\x1b[0m`,
        )
      }
    }

    // 5. 如果模型决定停止，退出循环
    if (response.stop_reason !== 'tool_use') {
      return
    }

    // 6. 处理工具调用
    const results: ToolResultBlock[] = []
    let usedSaveMemory = false

    for (const block of response.content) {
      if (block.type !== 'tool_use') continue

      const handler = handlers[block.name]
      let output: string

      if (handler) {
        try {
          output = await handler(block.input as Record<string, unknown>)
          console.log(`> ${block.name}: ${output.slice(0, 200)}`)
        } catch (e: unknown) {
          output = `Error: ${(e as Error).message}`
          console.log(`> ${block.name}: ${output}`)
        }
      } else {
        output = `Unknown tool: ${block.name}`
        console.log(`> ${block.name}: ${output}`)
      }

      results.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: output,
      })

      if (block.name === 'save_memory') {
        usedSaveMemory = true
      }
    }

    // 7. 如果保存了记忆，清除缓存（下次重新构建稳定部分）
    if (usedSaveMemory) {
      promptBuilder.invalidateCache()
    }

    // 8. 将结果追加回消息
    messages.push({ role: 'user', content: results })
  }
}

// ============================================================================
// REPL 入口
// ============================================================================

async function main() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  // 1. 创建 MemoryManager 并加载记忆
  const memoryManager = new MemoryManager()
  memoryManager.loadAll()

  // 2. 创建 SystemPromptBuilder
  const promptBuilder = new SystemPromptBuilder({
    tools: BASE_TOOLS,
    memoryManager,
    baseSystem: S10_BASE_SYSTEM,
  })

  // 3. 显示提示词统计
  const fullPrompt = promptBuilder.build()
  const tokenEstimate = estimateTokens(fullPrompt)
  console.log(`[System prompt assembled: ${fullPrompt.length} chars, ~${tokenEstimate} tokens]`)

  // 4. 提示记忆状态
  if (memoryManager.memories.size > 0) {
    console.log(`[${memoryManager.memories.size} memories loaded into context]`)
  } else {
    console.log('[No existing memories. The agent can create them with save_memory.]')
  }

  // 5. 工具 handlers（包含 save_memory）
  const handlers: Record<string, ToolHandler> = {
    ...BASE_HANDLERS,
    save_memory: (input) => {
      const result = memoryManager.saveMemory(
        input.name as string,
        input.description as string,
        input.type as string,
        input.content as string,
      )
      // 保存后清除缓存
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
        rl.question('\x1b[36ms10 >> \x1b[0m', (answer) => {
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

    // /prompt 命令 - 显示完整系统提示词
    if (query.trim() === '/prompt') {
      console.log('--- System Prompt ---')
      console.log(promptBuilder.build())
      console.log('--- End ---')
      continue
    }

    // /sections 命令 - 显示 section 标题
    if (query.trim() === '/sections') {
      const prompt = promptBuilder.build()
      for (const line of prompt.split('\n')) {
        if (line.startsWith('# ') || line === DYNAMIC_BOUNDARY) {
          console.log(`  ${line}`)
        }
      }
      continue
    }

    // /budget 命令 - 显示 token 预算信息
    if (query.trim() === '/budget') {
      const prompt = promptBuilder.build()
      console.log(`Total: ~${estimateTokens(prompt)} tokens (${prompt.length} chars)`)
      continue
    }

    // /help 命令
    if (query.trim() === '/help') {
      console.log('Commands:')
      console.log('  /prompt    - Show full system prompt')
      console.log('  /sections  - Show section headers')
      console.log('  /budget    - Show token estimate')
      console.log('  /memories  - Show current memories')
      console.log('  /help      - Show this help message')
      console.log('  q/exit     - Exit the session')
      continue
    }

    // /memories 命令
    if (query.trim() === '/memories') {
      if (memoryManager.memories.size > 0) {
        console.log('Current memories:')
        for (const [name, mem] of memoryManager.memories) {
          console.log(`  [${mem.type}] ${name}: ${mem.description}`)
        }
      } else {
        console.log('  (no memories)')
      }
      continue
    }

    // 正常请求
    history.push({ role: 'user', content: query })
    await agentLoop(history, promptBuilder, handlers)

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
