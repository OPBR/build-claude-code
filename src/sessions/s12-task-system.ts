/**
 * s12 Task System
 * 文件持久化的任务图，支持 blockedBy 依赖
 *
 * 5 个任务工具：create_task, list_tasks, get_task, claim_task, complete_task
 */

import readline from 'node:readline'
import { client, MODEL, WORKDIR } from '../core/agent-loop'
import { BASE_TOOLS, BASE_HANDLERS } from '../core/tools'
import { MemoryManager, MEMORY_GUIDANCE } from '../persistence/memory'
import { SystemPromptBuilder } from '../persistence/prompt'
import { TaskManager, TASK_TOOLS, createTaskHandlers } from '../persistence/task-manager'
import Anthropic from '@anthropic-ai/sdk'
import type { Message, ToolHandler, ContentBlock, ToolResultBlock } from '../core/types'

// ============================================================================
// 核心指令
// ============================================================================

const S12_BASE_SYSTEM = `You are a coding agent at ${WORKDIR}. Use tools to solve tasks.

You have a memory system that persists information across sessions.
When you learn something worth remembering, use save_memory to save it.

${MEMORY_GUIDANCE}

This agent has a task system for planning and tracking multi-step work.
Key workflow: create tasks with blockedBy dependencies → claim (checks deps) → complete (reports unblocked).
Task files persist in .tasks/ and survive across sessions.
When starting a new session, always list_tasks first to discover existing tasks and their IDs.
Task IDs are auto-generated in format "task_{timestamp}_{random}" (e.g. task_1748123456_0042).
Always use the exact ID returned by create_task or list_tasks — never make up IDs.`

// ============================================================================
// REPL 入口
// ============================================================================

async function main() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  // 1. 创建 TaskManager
  const taskManager = new TaskManager()

  // 2. 创建 MemoryManager 并加载记忆
  const memoryManager = new MemoryManager()
  memoryManager.loadAll()

  // 3. 创建 SystemPromptBuilder
  const promptBuilder = new SystemPromptBuilder({
    tools: [...BASE_TOOLS, ...TASK_TOOLS],
    memoryManager,
    baseSystem: S12_BASE_SYSTEM,
  })

  // 4. 显示启动信息
  const fullPrompt = promptBuilder.build()
  console.log(`[System prompt: ${fullPrompt.length} chars]`)
  console.log(`[Task system enabled: .tasks/ directory]`)

  if (memoryManager.memories.size > 0) {
    console.log(`[${memoryManager.memories.size} memories loaded]`)
  } else {
    console.log('[No existing memories]')
  }

  // 6. 工具 handlers
  const handlers: Record<string, ToolHandler> = {
    ...BASE_HANDLERS,

    // 记忆工具
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

    // 任务工具（从 task-manager 导入）
    ...createTaskHandlers(taskManager),
  }

  // 7. 消息历史
  const history: Message[] = []

  // 8. REPL 主循环
  while (true) {
    let query: string
    try {
      query = await new Promise<string>((resolve, reject) => {
        rl.question('\x1b[36ms12 >> \x1b[0m', (answer) => {
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
      console.log('  /status    - Show task system status')
      console.log('  q/exit     - Exit the session')
      continue
    }

    // /status 命令
    if (query.trim() === '/status') {
      const tasks = await taskManager.listAll()
      const pending = tasks.filter((t) => t.status === 'pending').length
      const inProgress = tasks.filter((t) => t.status === 'in_progress').length
      const completed = tasks.filter((t) => t.status === 'completed').length
      console.log('Task system status:')
      console.log(
        `  Tasks: ${tasks.length} total (${pending} pending, ${inProgress} in progress, ${completed} completed)`,
      )
      console.log(`  Storage: .tasks/`)
      if (tasks.length > 0) {
        console.log('')
        console.log(await taskManager.renderList())
      }
      continue
    }

    // 正常请求
    history.push({ role: 'user', content: query })

    // Agent Loop（基础版，复用 s01 模式）
    const systemPrompt = promptBuilder.build()
    const allTools = [...BASE_TOOLS, ...TASK_TOOLS]

    while (true) {
      const anthropicTools: Anthropic.Tool[] = allTools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema as Anthropic.Tool.InputSchema,
      }))

      const response = await client.messages.create({
        model: MODEL,
        system: systemPrompt,
        messages: history,
        tools: anthropicTools,
        max_tokens: 8000,
      })

      history.push({
        role: 'assistant',
        content: response.content as ContentBlock[],
      })

      if (response.stop_reason !== 'tool_use') {
        break
      }

      // 执行工具
      const results: ToolResultBlock[] = []
      for (const block of response.content) {
        if (block.type !== 'tool_use') continue
        const handler = handlers[block.name]
        let output: string
        try {
          output = handler
            ? String(await handler(block.input as Record<string, unknown>))
            : `Unknown tool: ${block.name}`
        } catch (e) {
          output = `Error: ${(e as Error).message}`
        }
        console.log(`\x1b[36m> ${block.name}\x1b[0m`)
        console.log(output.slice(0, 300))
        results.push({
          type: 'tool_result' as const,
          tool_use_id: block.id,
          content: output,
        })
      }
      history.push({ role: 'user', content: results })
    }

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
