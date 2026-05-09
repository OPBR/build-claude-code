/**
 * s09 Memory System
 * 记忆系统 REPL 入口
 *
 * 核心特性：
 * - 跨会话保存有价值的信息
 * - 4 种记忆类型：user、feedback、project、reference
 * - 系统提示词注入：让 LLM 看到记忆
 * - save_memory 工具：LLM 可以主动保存记忆
 */

import readline from 'node:readline'
import Anthropic from '@anthropic-ai/sdk'
import { client, MODEL, WORKDIR } from '../core/agent-loop'
import { BASE_TOOLS, BASE_HANDLERS } from '../core/tools'
import { MemoryManager, MEMORY_GUIDANCE } from '../persistence/memory'
import type {
  Message,
  ToolResultBlock,
  ContentBlock,
  ToolUseBlock,
  TextBlock,
  ToolHandler,
} from '../core/types'

// ============================================================================
// 系统提示词（基础部分）
// ============================================================================

const S09_BASE_SYSTEM = `You are a coding agent at ${WORKDIR}. Use tools to solve tasks.

You have a memory system that persists information across sessions.
When you learn something worth remembering, use save_memory to save it.`

// ============================================================================
// 构建系统提示词（包含记忆）
// ============================================================================

/**
 * 构建系统提示词
 * 每次调用 LLM 前重新构建，确保新记忆立即可见
 */
function buildSystemPrompt(memoryManager: MemoryManager): string {
  const parts = [S09_BASE_SYSTEM]

  // 注入记忆内容
  const memorySection = memoryManager.loadMemoryPrompt()
  if (memorySection) {
    parts.push(memorySection)
  }

  // 注入记忆使用指南
  parts.push(MEMORY_GUIDANCE)

  return parts.join('\n\n')
}

// ============================================================================
// 主循环（带记忆系统）
// ============================================================================

async function agentLoopWithMemory(
  messages: Message[],
  memoryManager: MemoryManager,
): Promise<void> {
  // 转换工具定义为 Anthropic SDK 兼容类型
  const anthropicTools = BASE_TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema as Anthropic.Messages.Tool.InputSchema,
  }))

  // 创建包含 save_memory 的 handler 映射
  const handlers: Record<string, ToolHandler> = {
    ...BASE_HANDLERS,
    save_memory: (input) =>
      memoryManager.saveMemory(
        input.name as string,
        input.description as string,
        input.type as string,
        input.content as string,
      ),
  }

  while (true) {
    // 1. 每次调用前重新构建系统提示词（包含最新记忆）
    const system = buildSystemPrompt(memoryManager)

    // 2. 调用模型
    const response = await client.messages.create({
      model: MODEL,
      system: system,
      messages: messages,
      tools: anthropicTools,
      max_tokens: 8000,
    })

    // 3. 记录 assistant 回复到消息历史
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

    // 4. 如果模型决定停止，退出循环
    if (response.stop_reason !== 'tool_use') {
      return
    }

    // 5. 处理工具调用
    const results: ToolResultBlock[] = []

    for (const block of response.content) {
      if (block.type !== 'tool_use') continue

      const toolName = block.name
      const toolInput = block.input as Record<string, unknown>

      // 执行工具
      const handler = handlers[toolName]
      let output: string

      if (handler) {
        try {
          output = await handler(toolInput)
          console.log(`> ${toolName}: ${output.slice(0, 200)}`)
        } catch (e: unknown) {
          output = `Error: ${(e as Error).message}`
          console.log(`> ${toolName}: ${output}`)
        }
      } else {
        output = `Unknown tool: ${toolName}`
        console.log(`> ${toolName}: ${output}`)
      }

      results.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: output,
      })
    }

    // 6. 将结果追加回消息
    messages.push({ role: 'user', content: results })
  }
}

// ============================================================================
// REPL 入口
// ============================================================================

async function main() {
  // 创建 readline 接口
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  // 创建 MemoryManager 并加载记忆
  const memoryManager = new MemoryManager()
  memoryManager.loadAll()

  // 提示用户记忆状态
  if (memoryManager.memories.size > 0) {
    console.log(`[${memoryManager.memories.size} memories loaded into context]`)
  } else {
    console.log('[No existing memories. The agent can create them with save_memory.]')
  }

  // 消息历史
  const history: Message[] = []

  // REPL 主循环
  while (true) {
    // 获取用户输入
    let query: string
    try {
      query = await new Promise<string>((resolve, reject) => {
        rl.question('\x1b[36ms09 >> \x1b[0m', (answer) => {
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

    // /memories 命令 - 查看当前记忆
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

    // /help 命令
    if (query.trim() === '/help') {
      console.log('Commands:')
      console.log('  /memories - Show current memories')
      console.log('  /help     - Show this help message')
      console.log('  q/exit    - Exit the session')
      continue
    }

    // 正常请求
    history.push({ role: 'user', content: query })
    await agentLoopWithMemory(history, memoryManager)

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
