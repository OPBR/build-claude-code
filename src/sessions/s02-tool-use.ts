/**
 * s02 Session 入口 - Tool Use
 * 使用 dispatch map 调用多个工具
 */

import readline from 'node:readline'
import { agentLoop, extractTextReply, WORKDIR } from '../core/agent-loop'
import { BASE_TOOLS, BASE_HANDLERS } from '../core/tools'
import type { Message } from '../core/types'

async function main() {
  console.log('\x1b[36m╔════════════════════════════════════╗\x1b[0m')
  console.log('\x1b[36m║  s02 - Tool Use                    ║\x1b[0m')
  console.log('\x1b[36m║  "Add tools = add a handler"       ║\x1b[0m')
  console.log('\x1b[36m╚════════════════════════════════════╝\x1b[0m')
  console.log()

  // 检查 API Key
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    console.error('\x1b[31mError: API key not set\x1b[0m')
    console.error('Please copy .env.example to .env and add your API key')
    process.exit(1)
  }

  console.log(`Working directory: ${WORKDIR}`)
  console.log('Tools: bash, read_file, write_file, edit_file')
  console.log('Type "q" or "exit" to quit.\n')

  const history: Message[] = []
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  const prompt = (): void => {
    rl.question('\x1b[36ms02 >> \x1b[0m', async (query: string) => {
      const trimmed = query.trim().toLowerCase()

      if (trimmed === 'q' || trimmed === 'exit' || trimmed === '') {
        rl.close()
        console.log('Goodbye!')
        return
      }

      history.push({ role: 'user', content: query })

      try {
        await agentLoop(history, BASE_TOOLS, BASE_HANDLERS)
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
