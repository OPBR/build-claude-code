/**
 * s01 - Agent Loop
 * 核心循环：一个 while + stop_reason 判断
 */

import Anthropic from '@anthropic-ai/sdk'
import { execSync } from 'child_process'
import readline from 'node:readline'
import 'dotenv/config'
import { config } from 'dotenv'
config({ override: true }) // 强制覆盖系统环境变量
import type { Message, ContentBlock, ToolResultBlock } from './types'

// ============================================================================
// Windows 编码修复
// ============================================================================
// 在进程启动时设置控制台为 UTF-8 模式
if (process.platform === 'win32') {
  // 使用 chcp 命令设置控制台编码为 UTF-8
  try {
    execSync('chcp 65001 >nul 2>&1', { shell: 'cmd.exe' })
  } catch {
    // ignore
  }
}

// ============================================================================
// 配置
// ============================================================================

const WORKDIR = process.cwd()
// 支持多种模型环境变量名
const MODEL = process.env.MODEL_ID || process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514'

// 支持 ANTHROPIC_API_KEY 或 ANTHROPIC_AUTH_TOKEN
const authToken = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN
const baseURL = process.env.ANTHROPIC_BASE_URL

const client = new Anthropic({
  apiKey: authToken, // 使用 apiKey 发送 X-Api-Key header
  baseURL,
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
    // Windows 使用 PowerShell (UTF-8)，其他平台使用默认 shell
    const shell = process.platform === 'win32' ? 'powershell.exe' : undefined
    const shellCommand = process.platform === 'win32' ? command : command

    const result = execSync(shellCommand, {
      cwd: WORKDIR,
      encoding: 'utf-8',
      timeout: 120000, // 120秒超时
      maxBuffer: 50 * 1024 * 1024, // 50MB
      shell,
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
