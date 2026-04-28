/**
 * s07 Permission System
 * 权限系统 REPL 入口
 *
 * 核心特性:
 * - 权限管道: deny -> mode -> allow -> ask
 * - 三种模式: default, plan, auto
 * - Bash 安全验证器
 * - 用户交互确认
 */

import readline from 'node:readline'
import Anthropic from '@anthropic-ai/sdk'
import { client, MODEL, WORKDIR } from '../core/agent-loop'
import { BASE_TOOLS, BASE_HANDLERS } from '../core/tools'
import { PermissionManager } from '../persistence/permission'
import type { Message, ToolResultBlock, ContentBlock, ToolUseBlock, TextBlock } from '../core/types'

// ============================================================================
// 系统提示词
// ============================================================================

const S07_SYSTEM = `You are a coding agent at ${WORKDIR}. Use tools to solve tasks.
The user controls permissions. Some tool calls may be denied.

Available permission modes:
- default: Ask user for unmatched operations
- plan: Read-only mode, no writes allowed
- auto: Auto-approve safe reads, ask for writes

Use /mode to switch modes. Use /rules to see current rules.`

// ============================================================================
// 主循环（带权限检查）
// ============================================================================

async function agentLoopWithPermission(
  messages: Message[],
  perms: PermissionManager,
  rl: readline.Interface,
): Promise<void> {
  // 转换工具定义为 Anthropic SDK 兼容类型
  const anthropicTools = BASE_TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema as Anthropic.Messages.Tool.InputSchema,
  }))

  while (true) {
    const response = await client.messages.create({
      model: MODEL,
      system: S07_SYSTEM,
      messages: messages,
      tools: anthropicTools,
      max_tokens: 8000,
    })

    // 记录 assistant 回复
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
      // thinking block 等，转换为 text
      return { type: 'text', text: JSON.stringify(block) } as TextBlock
    })
    messages.push({ role: 'assistant', content: assistantContent })

    // 如果模型决定停止，退出循环
    if (response.stop_reason !== 'tool_use') {
      return
    }

    // 处理工具调用
    const results: ToolResultBlock[] = []

    for (const block of response.content) {
      if (block.type !== 'tool_use') continue

      const toolName = block.name
      const toolInput = block.input as Record<string, unknown>

      // --- 权限检查 ---
      const decision = perms.check(toolName, toolInput)

      let output: string

      if (decision.behavior === 'deny') {
        output = `Permission denied: ${decision.reason}`
        console.log(`  [DENIED] ${toolName}: ${decision.reason}`)
      } else if (decision.behavior === 'ask') {
        // 需要用户确认
        console.log(`\n  [Permission] ${toolName}: ${JSON.stringify(toolInput).slice(0, 200)}`)

        // 等待用户输入
        const answer = await new Promise<string>((resolve) => {
          rl.question('  Allow? (y/n/always): ', resolve)
        })

        if (answer.toLowerCase() === 'always') {
          // 添加永久允许规则
          perms.rules.push({ tool: toolName, path: '*', behavior: 'allow' })
          perms.consecutiveDenials = 0
          const handler = BASE_HANDLERS[toolName]
          output = handler ? await handler(toolInput) : `Unknown tool: ${toolName}`
          console.log(`> ${toolName}: ${output.slice(0, 200)}`)
        } else if (answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes') {
          perms.consecutiveDenials = 0
          const handler = BASE_HANDLERS[toolName]
          output = handler ? await handler(toolInput) : `Unknown tool: ${toolName}`
          console.log(`> ${toolName}: ${output.slice(0, 200)}`)
        } else {
          output = `Permission denied by user for ${toolName}`
          perms.consecutiveDenials++
          console.log(`  [USER DENIED] ${toolName}`)
          if (perms.consecutiveDenials >= perms.maxConsecutiveDenials) {
            console.log(
              `  [${perms.consecutiveDenials} consecutive denials -- consider switching to plan mode]`,
            )
          }
        }
      } else {
        // allow - 直接执行
        const handler = BASE_HANDLERS[toolName]
        output = handler ? await handler(toolInput) : `Unknown tool: ${toolName}`
        console.log(`> ${toolName}: ${output.slice(0, 200)}`)
      }

      results.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: output,
      })
    }

    // 将结果追加回消息
    messages.push({ role: 'user', content: results })
  }
}

// ============================================================================
// REPL
// ============================================================================

async function main() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  // 选择权限模式
  console.log('Permission modes: default, plan, auto')
  const modeInput = await new Promise<string>((resolve) => {
    rl.question('Mode (default): ', (answer) => resolve(answer.trim().toLowerCase() || 'default'))
  })

  if (!['default', 'plan', 'auto'].includes(modeInput)) {
    console.log('Invalid mode, using default')
  }

  const perms = new PermissionManager(
    ['default', 'plan', 'auto'].includes(modeInput)
      ? (modeInput as 'default' | 'plan' | 'auto')
      : 'default',
  )
  console.log(`[Permission mode: ${perms.mode}]`)
  console.log('')

  const history: Message[] = []

  while (true) {
    // 获取用户输入
    let query: string
    try {
      query = await new Promise<string>((resolve, reject) => {
        rl.question('\x1b[36ms07 >> \x1b[0m', (answer) => {
          if (answer === undefined) reject(new Error('EOF'))
          else resolve(answer)
        })
      })
    } catch {
      break
    }

    if (
      query.trim().toLowerCase() === 'q' ||
      query.trim().toLowerCase() === 'exit' ||
      !query.trim()
    ) {
      break
    }

    // /mode 命令切换模式
    if (query.startsWith('/mode')) {
      const parts = query.split(' ')
      if (parts.length === 2 && ['default', 'plan', 'auto'].includes(parts[1])) {
        perms.mode = parts[1] as 'default' | 'plan' | 'auto'
        console.log(`[Switched to ${parts[1]} mode]`)
      } else {
        console.log('Usage: /mode <default|plan|auto>')
      }
      continue
    }

    // /rules 命令查看当前规则
    if (query.trim() === '/rules') {
      console.log('Current rules:')
      perms.rules.forEach((rule, i) => {
        console.log(`  ${i}: ${JSON.stringify(rule)}`)
      })
      continue
    }

    // /validators 命令查看 Bash 验证器
    if (query.trim() === '/validators') {
      console.log('Bash validators:')
      console.log('  - sudo: \\bsudo\\b')
      console.log('  - rm_rf: \\brm\\s+(-[a-zA-Z]*)?r')
      console.log('  - shell_metachar: [;&|`$]')
      console.log('  - cmd_substitution: \\$\\(')
      console.log('  - ifs_injection: \\bIFS\\s*=')
      continue
    }

    // 正常请求
    history.push({ role: 'user', content: query })
    await agentLoopWithPermission(history, perms, rl)

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
