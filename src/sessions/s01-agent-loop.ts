/**
 * s01 Session 入口
 * 运行基础 Agent Loop
 */

import { agentLoop } from '../core/agent-loop'
import readline from 'node:readline'
import type { Message } from '../core/types'
import 'dotenv/config'

async function main() {
  console.log('\x1b[36m╔════════════════════════════════════╗\x1b[0m')
  console.log('\x1b[36m║  s01 - Agent Loop                  ║\x1b[0m')
  console.log('\x1b[36m║  "One loop & Bash is all you need" ║\x1b[0m')
  console.log('\x1b[36m╚════════════════════════════════════╝\x1b[0m')
  console.log()

  // 检查 API Key
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('\x1b[31mError: ANTHROPIC_API_KEY not set\x1b[0m')
    console.error('Please copy .env.example to .env and add your API key')
    process.exit(1)
  }

  console.log(`Working directory: ${process.cwd()}`)
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
        await agentLoop(history)

        // 打印最终回复
        const lastContent = history[history.length - 1]?.content
        if (Array.isArray(lastContent)) {
          for (const block of lastContent) {
            if (block.type === 'text') {
              console.log(block.text)
            }
          }
        }
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
