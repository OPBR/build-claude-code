/**
 * s01 - Agent Loop
 * 核心循环：一个 while + stop_reason 判断
 */

import Anthropic from '@anthropic-ai/sdk'
import { execSync } from 'child_process'
import * as readline from 'node:readline'
import 'dotenv/config'
import type { Message, ContentBlock, ToolResultBlock } from './types'

// ============================================================================
// 配置
// ============================================================================

const WORKDIR = process.cwd()
const MODEL = process.env.MODEL_ID || 'claude-sonnet-4-20250514'

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  baseURL: process.env.ANTHROPIC_BASE_URL,
})

const SYSTEM = `You are a coding agent at ${WORKDIR}. Use bash to solve tasks. Act, don't explain.`

// ============================================================================
// 工具定义与实现
// ============================================================================

const TOOLS: Anthropic.Messages.Tool[] = [
  {
    name: 'bash',
    description: 'Run a shell command.',
    input_schema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The shell command to execute',
        },
      },
      required: ['command'],
    },
  },
]

// 安全检查：阻止危险命令
const DANGEROUS_COMMANDS = ['rm -rf /', 'sudo', 'shutdown', 'reboot', '> /dev/']

function runBash(command: string): string {
  // 安全检查
  for (const dangerous of DANGEROUS_COMMANDS) {
    if (command.includes(dangerous)) {
      return `Error: Dangerous command blocked: "${dangerous}" detected`
    }
  }

  try {
    const result = execSync(command, {
      cwd: WORKDIR,
      encoding: 'utf-8',
      timeout: 120000, // 120秒超时
      maxBuffer: 50 * 1024 * 1024, // 50MB
    })
    return result.trim() || '(no output)'
  } catch (error: unknown) {
    if (error instanceof Error) {
      const execError = error as ExecError
      const output = (execError.stdout || '') + (execError.stderr || '')
      return output.trim() || `Error: ${execError.message}`
    }
    return 'Error: Unknown error'
  }
}

interface ExecError extends Error {
  stdout?: string
  stderr?: string
}

// ============================================================================
// Agent Loop - 核心循环
// ============================================================================

/**
 * 核心 Agent 循环
 *
 * 模式：while (stop_reason == "tool_use") -> 调用 LLM -> 执行工具 -> 追加结果
 */
export async function agentLoop(messages: Message[]): Promise<void> {
  while (true) {
    // 1. 调用 LLM
    const response = await client.messages.create({
      model: MODEL,
      system: SYSTEM,
      messages: messages,
      tools: TOOLS,
      max_tokens: 8000,
    })

    // 2. 记录 assistant 回复
    messages.push({
      role: 'assistant',
      content: response.content as ContentBlock[],
    })

    // 3. 如果模型决定停止，退出循环
    if (response.stop_reason !== 'tool_use') {
      return
    }

    // 4. 执行所有工具调用
    const results: ToolResultBlock[] = []
    for (const block of response.content) {
      if (block.type === 'tool_use') {
        const toolBlock = block as Anthropic.Messages.ToolUseBlock

        const input = toolBlock.input as { command: string }
        console.log(`\x1b[33m$ ${input.command}\x1b[0m`)

        // 执行工具
        const output = runBash(input.command)
        console.log(output.slice(0, 200))

        results.push({
          type: 'tool_result',
          tool_use_id: toolBlock.id,
          content: output,
        })
      }
    }

    // 5. 将结果追加回消息
    messages.push({
      role: 'user',
      content: results,
    })

    // 循环继续...
  }
}

// ============================================================================
// REPL 入口
// ============================================================================

async function repl() {
  console.log('\x1b[36m╔════════════════════════════════════╗\x1b[0m')
  console.log('\x1b[36m║  s01 - Agent Loop                  ║\x1b[0m')
  console.log('\x1b[36m║  "One loop & Bash is all you need" ║\x1b[0m')
  console.log('\x1b[36m╚════════════════════════════════════╝\x1b[0m')
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
        console.error('Error:', error)
      }

      console.log()
      prompt()
    })
  }

  prompt()
}

// 仅当直接运行时启动 REPL
// ES Module 检测：如果当前文件是入口点
if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`) {
  repl()
}
