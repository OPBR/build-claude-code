/**
 * s01 Session 入口 - 最小 Agent Loop
 * 只有一个 bash 工具，展示核心循环模式
 */

import readline from 'node:readline'
import { agentLoop, extractTextReply, WORKDIR } from '../core/agent-loop'
import { BASE_TOOLS, runBash } from '../core/tools'
import type { Message, ToolDefinition, ToolHandler } from '../core/types'

// s01 只使用 bash 工具（最小版本）
const S01_TOOLS: ToolDefinition[] = [BASE_TOOLS[0]] // 只有 bash
const S01_HANDLERS: Record<string, ToolHandler> = { bash: runBash }

async function main() {
  console.log('\x1b[36m╔════════════════════════════════════╗\x1b[0m')
  console.log('\x1b[36m║  s01 - Agent Loop                  ║\x1b[0m')
  console.log('\x1b[36m║  "One loop & Bash is all you need" ║\x1b[0m')
  console.log('\x1b[36m╚════════════════════════════════════╝\x1b[0m')
  console.log()

  // 检查 API Key
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    console.error('\x1b[31mError: API key not set\x1b[0m')
    console.error('Please copy .env.example to .env and add your API key')
    process.exit(1)
  }

  console.log(`Working directory: ${WORKDIR}`)
  console.log('Type "q" or "exit" to quit.\n')

  const history: Message[] = []
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  const prompt = (): void => {
    rl.question('\x1b[36ms01 >> \x1b[0m', async (query: string) => {
      const trimmed = query.trim().toLowerCase()

      if (trimmed === 'q' || trimmed === 'exit' || trimmed === '') {
        rl.close()
        console.log('Goodbye!')
        return
      }

      history.push({ role: 'user', content: query })

      try {
        await agentLoop(history, {
          tools: S01_TOOLS,
          handlers: S01_HANDLERS,
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
