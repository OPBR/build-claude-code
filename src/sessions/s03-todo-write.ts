/**
 * s03 Session 入口 - TodoWrite
 * 会话内计划管理，让 Agent 有规划能力
 */

import readline from 'node:readline'
import { agentLoop, extractTextReply, WORKDIR } from '../core/agent-loop'
import { BASE_TOOLS, BASE_HANDLERS } from '../core/tools'
import { TodoManager, TODO_TOOL_DEFINITION, createTodoHandler } from '../planning/todo'
import type { Message, ToolDefinition, ToolHandler } from '../core/types'

// s03 系统提示词（强调使用 todo 工具）
const S03_SYSTEM = `You are a coding agent at ${WORKDIR}.
Use the todo tool for multi-step work.
Keep exactly one step in_progress when a task has multiple steps.
Refresh the plan as work advances. Prefer tools over prose.`

async function main() {
  console.log('\x1b[36m╔════════════════════════════════════╗\x1b[0m')
  console.log('\x1b[36m║  s03 - TodoWrite                   ║\x1b[0m')
  console.log('\x1b[36m║  "No plan, agent drifts"           ║\x1b[0m')
  console.log('\x1b[36m╚════════════════════════════════════╝\x1b[0m')
  console.log()

  // 检查 API Key
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    console.error('\x1b[31mError: API key not set\x1b[0m')
    console.error('Please copy .env.example to .env and add your API key')
    process.exit(1)
  }

  // 初始化 TodoManager
  const todoManager = new TodoManager()

  // s03 工具：基础 4 个 + todo
  const S03_TOOLS: ToolDefinition[] = [...BASE_TOOLS, TODO_TOOL_DEFINITION]
  const S03_HANDLERS: Record<string, ToolHandler> = {
    ...BASE_HANDLERS,
    todo: createTodoHandler(todoManager),
  }

  console.log(`Working directory: ${WORKDIR}`)
  console.log('Tools: bash, read_file, write_file, edit_file, todo')
  console.log('Type "q" or "exit" to quit.\n')

  const history: Message[] = []
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  const prompt = (): void => {
    rl.question('\x1b[36ms03 >> \x1b[0m', async (query: string) => {
      const trimmed = query.trim().toLowerCase()

      if (trimmed === 'q' || trimmed === 'exit' || trimmed === '') {
        rl.close()
        console.log('Goodbye!')
        return
      }

      history.push({ role: 'user', content: query })

      try {
        await agentLoop(history, {
          tools: S03_TOOLS,
          handlers: S03_HANDLERS,
          system: S03_SYSTEM,
          todoManager, // 传入 TodoManager 以启用提醒机制
        })
        const reply = extractTextReply(history)
        if (reply) console.log(reply)
      } catch (error) {
        console.error('\x1b[31mError:\x1b[0m', error)
      }

      console.log()
      prompt()
    })
  }

  prompt()
}

main()
