/**
 * s04 Session 入口 - Subagent
 * 上下文隔离，子任务获得干净的上下文
 */

import readline from 'node:readline'
import { agentLoop, extractTextReply, WORKDIR } from '../core/agent-loop'
import { BASE_TOOLS, BASE_HANDLERS } from '../core/tools'
import { TASK_TOOL_DEFINITION, createTaskHandler } from '../planning/subagent'
import type { Message, ToolDefinition, ToolHandler } from '../core/types'

// s04 系统提示词（智能判断何时使用 task）
const S04_SYSTEM = `You are a coding agent at ${WORKDIR}.

<task_tool_guidance>
Use the task tool when the request involves:
- Analyzing, exploring, or searching multiple files/directories
- Finding patterns or gathering information across the codebase
- Tasks where intermediate steps are noise but final summary matters
- Requests starting with "analyze", "find", "search", "list", "explore"

Do NOT use task tool for:
- Single file operations (read/edit one file)
- Simple bash commands
- Tasks that need current conversation context
</task_tool_guidance>

The task tool spawns a subagent with fresh messages. This keeps the parent context clean.
Directly handle simple tasks; delegate complex exploration to subagent.`

async function main() {
  console.log('\x1b[36m╔════════════════════════════════════╗\x1b[0m')
  console.log('\x1b[36m║  s04 - Subagent                    ║\x1b[0m')
  console.log('\x1b[36m║  "Fresh context, clean parent"     ║\x1b[0m')
  console.log('\x1b[36m╚════════════════════════════════════╝\x1b[0m')
  console.log()

  // 检查 API Key
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    console.error('\x1b[31mError: API key not set\x1b[0m')
    console.error('Please copy .env.example to .env and add your API key')
    process.exit(1)
  }

  // s04 工具：基础 4 个 + task
  const S04_TOOLS: ToolDefinition[] = [...BASE_TOOLS, TASK_TOOL_DEFINITION]
  const S04_HANDLERS: Record<string, ToolHandler> = {
    ...BASE_HANDLERS,
    task: createTaskHandler(),
  }

  console.log(`Working directory: ${WORKDIR}`)
  console.log('Tools: bash, read_file, write_file, edit_file, task')
  console.log('Type "q" or "exit" to quit.\n')

  const history: Message[] = []
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  const prompt = (): void => {
    rl.question('\x1b[36ms04 >> \x1b[0m', async (query: string) => {
      const trimmed = query.trim().toLowerCase()

      if (trimmed === 'q' || trimmed === 'exit' || trimmed === '') {
        rl.close()
        console.log('Goodbye!')
        return
      }

      history.push({ role: 'user', content: query })

      try {
        await agentLoop(history, {
          tools: S04_TOOLS,
          handlers: S04_HANDLERS,
          system: S04_SYSTEM,
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
