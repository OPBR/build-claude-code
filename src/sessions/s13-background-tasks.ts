/**
 * s13 Background Tasks
 * 慢操作丢到子进程后台执行，Agent 继续处理其他事情
 *
 * 核心：agent loop 中根据 shouldRunBackground 决定同步/后台路径
 * 后台完成后 <task_notification> 注入到下一轮对话
 * 主动推送：有后台任务时启动 queue processor，全部完成后关闭
 */

import readline from 'node:readline'
import { client, MODEL, WORKDIR } from '../core/agent-loop'
import { BASE_TOOLS, BASE_HANDLERS } from '../core/tools'
import { MemoryManager, MEMORY_GUIDANCE } from '../persistence/memory'
import { SystemPromptBuilder } from '../persistence/prompt'
import { TaskManager, TASK_TOOLS, createTaskHandlers } from '../persistence/task-manager'
import { BackgroundManager } from '../persistence/background'
import Anthropic from '@anthropic-ai/sdk'
import type {
  Message,
  ToolHandler,
  ToolDefinition,
  ContentBlock,
  ToolResultBlock,
} from '../core/types'

// ============================================================================
// 核心指令
// ============================================================================

const S13_BASE_SYSTEM = `You are a coding agent at ${WORKDIR}. Use tools to solve tasks.

You have a memory system that persists information across sessions.
When you learn something worth remembering, use save_memory to save it.

${MEMORY_GUIDANCE}

This agent has a task system for planning and tracking multi-step work.
Key workflow: create tasks with blockedBy dependencies → claim (checks deps) → complete (reports unblocked).
Task files persist in .tasks/ and survive across sessions.
When starting a new session, always list_tasks first to discover existing tasks and their IDs.
Task IDs are auto-generated in format "task_{timestamp}_{random}" (e.g. task_1748123456_0042).
Always use the exact ID returned by create_task or list_tasks — never make up IDs.

Background execution: bash tool supports run_in_background parameter.
For slow operations (install, build, test, deploy), set run_in_background=true.
The command will run in a background child process and you'll be notified when it completes.
Meanwhile, you can continue with other tasks like reading files or creating tasks.
Background task IDs are in format "bg_XXXX" (e.g. bg_0001).
When a background task completes, you will receive a <task_notification> automatically — no need to ask.`

// ============================================================================
// Session Context
// ============================================================================

interface SessionContext {
  history: Message[]
  handlers: Record<string, ToolHandler>
  allTools: ToolDefinition[]
  promptBuilder: SystemPromptBuilder
  bgManager: BackgroundManager
  isIdle: () => boolean
  setBusy: () => void
  setIdle: () => void
  queueTimer: NodeJS.Timeout | null
  /** 有后台任务时启动定时器，没有时跳过 */
  ensureQueue(): void
  /** 没有运行中的后台任务时关闭定时器 */
  checkQueueStop(): void
}

// ============================================================================
// Queue Processor：后台完成时自动推送给 Agent
// ============================================================================

/**
 * queue processor 的核心逻辑：后台完成 + Agent 空闲 → 自动注入通知 + agent turn
 */
function processQueue(ctx: SessionContext) {
  if (!ctx.isIdle()) return
  if (!ctx.bgManager.hasCompleted()) return

  console.log('\n  \x1b[35m[queue processor] delivering background notification(s)\x1b[0m')
  ctx.setBusy()

  runAgentTurn(ctx).then(() => {
    console.log('\x1b[36ms13 >> \x1b[0m')
    ctx.setIdle()
    ctx.checkQueueStop()
  })
}

// ============================================================================
// Agent Turn：一轮完整的 agent loop
// ============================================================================

/**
 * 运行一轮 agent turn
 * 1. 先注入已有的后台通知
 * 2. 调用 LLM → 执行工具（同步/后台） → 循环直到模型停止
 * 3. 显示最后的文本回复
 */
async function runAgentTurn(ctx: SessionContext) {
  // 注入已有的后台通知
  const notifications = ctx.bgManager.collectResults()
  if (notifications.length > 0) {
    ctx.history.push({
      role: 'user',
      content: notifications.join('\n'),
    })
  }

  const systemPrompt = ctx.promptBuilder.build()
  const anthropicTools: Anthropic.Tool[] = ctx.allTools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema as Anthropic.Tool.InputSchema,
  }))

  while (true) {
    const response = await client.messages.create({
      model: MODEL,
      system: systemPrompt,
      messages: ctx.history,
      tools: anthropicTools,
      max_tokens: 8000,
    })

    ctx.history.push({
      role: 'assistant',
      content: response.content as ContentBlock[],
    })

    if (response.stop_reason !== 'tool_use') {
      break
    }

    // 执行工具（同步/后台两条路径）
    const results: (ToolResultBlock | { type: 'text'; text: string })[] = []

    for (const block of response.content) {
      if (block.type !== 'tool_use') continue
      const toolBlock = block as Anthropic.Messages.ToolUseBlock
      const toolInput = toolBlock.input as Record<string, unknown>

      if (ctx.bgManager.shouldRunBackground(toolBlock.name, toolInput)) {
        // 后台路径：spawn 子进程，返回占位 tool_result
        const bgId = ctx.bgManager.startTask(toolBlock.name, toolInput)
        ctx.ensureQueue() // 有后台任务了，确保定时器在跑
        results.push({
          type: 'tool_result' as const,
          tool_use_id: toolBlock.id,
          content: `[Background task ${bgId} started] Result will be available when complete.`,
        })
      } else {
        // 同步路径：正常执行 handler
        const handler = ctx.handlers[toolBlock.name]
        let output: string
        try {
          output = handler ? String(await handler(toolInput)) : `Unknown tool: ${toolBlock.name}`
        } catch (e) {
          output = `Error: ${(e as Error).message}`
        }
        console.log(`\x1b[36m> ${toolBlock.name}\x1b[0m`)
        console.log(output.slice(0, 300))
        results.push({
          type: 'tool_result' as const,
          tool_use_id: toolBlock.id,
          content: output,
        })
      }
    }

    // 收集本轮后台通知，合入同一条 user 消息
    const bgNotifications = ctx.bgManager.collectResults()
    if (bgNotifications.length > 0) {
      for (const notif of bgNotifications) {
        results.unshift({ type: 'text', text: notif })
      }
    }

    ctx.history.push({ role: 'user', content: results as ContentBlock[] })
  }

  // 显示最后的文本回复
  const lastContent = ctx.history[ctx.history.length - 1]?.content
  if (Array.isArray(lastContent)) {
    for (const block of lastContent) {
      if (block.type === 'text') {
        console.log(block.text)
      }
    }
  }
  console.log('')
}

// ============================================================================
// REPL 入口
// ============================================================================

async function main() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  // 1. 创建各 Manager
  const taskManager = new TaskManager()
  const bgManager = new BackgroundManager()

  // 2. 创建 MemoryManager
  const memoryManager = new MemoryManager()
  memoryManager.loadAll()

  // 3. 创建 SystemPromptBuilder
  const allTools = [...BASE_TOOLS, ...TASK_TOOLS]
  const promptBuilder = new SystemPromptBuilder({
    tools: allTools,
    memoryManager,
    baseSystem: S13_BASE_SYSTEM,
  })

  // 4. 显示启动信息
  const fullPrompt = promptBuilder.build()
  console.log(`[System prompt: ${fullPrompt.length} chars]`)
  console.log('[Task system + background execution enabled]')
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

    ...createTaskHandlers(taskManager),
  }

  // 6. 消息历史 + 空闲状态 + 定时器管理
  const history: Message[] = []
  let agentBusy = false
  let queueTimer: NodeJS.Timeout | null = null

  const isIdle = () => !agentBusy
  const setBusy = () => {
    agentBusy = true
  }
  const setIdle = () => {
    agentBusy = false
  }

  // 定时器管理：有后台任务才开，没有才关
  const ensureQueue = () => {
    if (queueTimer) return // 已经在跑了
    queueTimer = setInterval(() => processQueue(ctx), 500)
    console.log('  \x1b[35m[queue processor] started\x1b[0m')
  }

  const checkQueueStop = () => {
    if (!queueTimer) return // 没在跑
    if (bgManager.listRunning().length > 0) return // 还有运行中的后台任务
    if (bgManager.hasCompleted()) return // 还有已完成但未交付的通知，定时器不能关
    clearInterval(queueTimer)
    queueTimer = null
    console.log('  \x1b[35m[queue processor] stopped (no running tasks)\x1b[0m')
  }

  // 7. 构造 SessionContext
  const ctx: SessionContext = {
    history,
    handlers,
    allTools,
    promptBuilder,
    bgManager,
    isIdle,
    setBusy,
    setIdle,
    queueTimer,
    ensureQueue,
    checkQueueStop,
  }

  // 8. REPL 主循环
  while (true) {
    let query: string
    try {
      query = await new Promise<string>((resolve, reject) => {
        rl.question('\x1b[36ms13 >> \x1b[0m', (answer) => {
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
      console.log('  /status    - Show task and background status')
      console.log('  q/exit     - Exit the session')
      continue
    }

    // /status 命令
    if (query.trim() === '/status') {
      const tasks = await taskManager.listAll()
      const pending = tasks.filter((t) => t.status === 'pending').length
      const inProgress = tasks.filter((t) => t.status === 'in_progress').length
      const completed = tasks.filter((t) => t.status === 'completed').length
      console.log('Status:')
      console.log(
        `  Tasks: ${tasks.length} total (${pending} pending, ${inProgress} in progress, ${completed} completed)`,
      )
      const running = bgManager.listRunning()
      console.log(`  Background: ${running.length} running`)
      for (const bg of running) {
        console.log(`    ${bg.id}: ${bg.command.slice(0, 40)} [${bg.status}]`)
      }
      continue
    }

    // 等待 queue processor 的 turn 完成后再处理用户输入，防止两个 turn 同时修改 history
    while (!isIdle()) {
      await new Promise((r) => setTimeout(r, 50))
    }

    // 正常请求：标记 busy → push query → runAgentTurn → setIdle → checkQueueStop
    setBusy()
    history.push({ role: 'user', content: query })

    await runAgentTurn(ctx)

    setIdle()
    checkQueueStop()
  }

  // 清理：退出时如果定时器还在跑就关掉
  if (queueTimer) clearInterval(queueTimer)
  rl.close()
  console.log('Goodbye!')
}

main().catch(console.error)
