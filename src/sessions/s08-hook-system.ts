/**
 * s08 Hook System
 * Hook 系统 REPL 入口
 *
 * 核心特性：
 * - 三种 Hook 事件：SessionStart、PreToolUse、PostToolUse
 * - 统一退出码约定：0=继续，1=阻止，2=注入消息
 * - Matcher 匹配：Hook 可以只对特定工具生效
 * - 配置文件加载：从 .hooks.json 读取 Hook 定义
 */

import readline from 'node:readline'
import Anthropic from '@anthropic-ai/sdk'
import { client, MODEL, WORKDIR } from '../core/agent-loop'
import { BASE_TOOLS, BASE_HANDLERS } from '../core/tools'
import { HookManager } from '../persistence/hook'
import type {
  Message,
  ToolResultBlock,
  ContentBlock,
  ToolUseBlock,
  TextBlock,
  HookContext,
} from '../core/types'

// ============================================================================
// 系统提示词
// ============================================================================

const S08_SYSTEM = `You are a coding agent at ${WORKDIR}. Use tools to solve tasks.
Hooks may modify or block your tool calls.
Some tool results may include additional context from hooks.

Hook exit codes:
- 0: Continue normally
- 1: Block the tool call
- 2: Inject a message

Use /hooks to see configured hooks.`

// ============================================================================
// 主循环（带 Hook 集成）
// ============================================================================

/**
 * Agent 主循环，集成 Hook 系统
 *
 * 流程：
 * 1. 模型调用（思考 + 工具请求）
 * 2. PreToolUse Hook（每个工具执行前）
 * 3. 执行工具
 * 4. PostToolUse Hook（每个工具执行后）
 * 5. 返回结果给模型
 * 6. 循环继续...
 */
async function agentLoopWithHooks(messages: Message[], hooks: HookManager): Promise<void> {
  // 转换工具定义为 Anthropic SDK 兼容类型
  const anthropicTools = BASE_TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema as Anthropic.Messages.Tool.InputSchema,
  }))

  while (true) {
    // 1. 调用模型
    const response = await client.messages.create({
      model: MODEL,
      system: S08_SYSTEM,
      messages: messages,
      tools: anthropicTools,
      max_tokens: 8000,
    })

    // 2. 记录 assistant 回复到消息历史
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

    // 3. 如果模型决定停止，退出循环
    if (response.stop_reason !== 'tool_use') {
      return
    }

    // 4. 处理工具调用
    const results: ToolResultBlock[] = []

    for (const block of response.content) {
      if (block.type !== 'tool_use') continue

      const toolName = block.name
      const toolInput = block.input as Record<string, unknown>

      // 构建 Hook 上下文
      const hookContext: HookContext = {
        tool_name: toolName,
        tool_input: toolInput,
      }

      // ========== PreToolUse Hook ==========
      const preResult = hooks.runHooks('PreToolUse', hookContext)

      // 处理 Hook 注入的消息
      for (const msg of preResult.messages) {
        results.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: `[Hook message]: ${msg}`,
        })
      }

      // 检查是否被阻止
      if (preResult.blocked) {
        // Hook 阻止了工具执行
        const reason = preResult.blockReason || 'Blocked by hook'
        results.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: `Tool blocked by PreToolUse hook: ${reason}`,
        })
        console.log(`  [BLOCKED] ${toolName}: ${reason}`)
        continue // 不执行工具，继续下一个
      }

      // ========== 执行工具 ==========
      const handler = BASE_HANDLERS[toolName]
      let output: string

      if (handler) {
        try {
          output = await handler(toolInput)
          console.log(`> ${toolName}: ${output.slice(0, 200)}`)
        } catch (e: unknown) {
          output = `Error: ${(e as Error).message}`
          console.log(`> ${toolName}: ${output}`)
        }
      } else {
        output = `Unknown tool: ${toolName}`
        console.log(`> ${toolName}: ${output}`)
      }

      // ========== PostToolUse Hook ==========
      hookContext.tool_output = output // 添加输出到上下文
      const postResult = hooks.runHooks('PostToolUse', hookContext)

      // 处理 PostToolUse Hook 注入的消息
      for (const msg of postResult.messages) {
        output += `\n[Hook note]: ${msg}`
      }

      // 添加结果
      results.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: output,
      })
    }

    // 5. 将结果追加回消息
    messages.push({ role: 'user', content: results })
  }
}

// ============================================================================
// REPL 入口
// ============================================================================

async function main() {
  // 创建 readline 接口（用户输入）
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  // 创建 HookManager，自动加载 .hooks.json 配置
  const hooks = new HookManager()
  console.log('')

  // ========== SessionStart Hook ==========
  // 会话开始时执行一次（比如打印欢迎信息）
  hooks.runHooks('SessionStart', { tool_name: '', tool_input: {} })

  // 消息历史
  const history: Message[] = []

  // REPL 主循环
  while (true) {
    // 获取用户输入
    let query: string
    try {
      query = await new Promise<string>((resolve, reject) => {
        rl.question('\x1b[36ms08 >> \x1b[0m', (answer) => {
          if (answer === undefined) reject(new Error('EOF'))
          else resolve(answer)
        })
      })
    } catch {
      break // EOF 或错误，退出
    }

    // 退出命令
    if (
      query.trim().toLowerCase() === 'q' ||
      query.trim().toLowerCase() === 'exit' ||
      !query.trim()
    ) {
      break
    }

    // /hooks 命令 - 查看当前 Hook 配置
    if (query.trim() === '/hooks') {
      console.log('Current hooks:')
      console.log('  SessionStart:', hooks.hooks.SessionStart.length, 'hooks')
      console.log('  PreToolUse:', hooks.hooks.PreToolUse.length, 'hooks')
      console.log('  PostToolUse:', hooks.hooks.PostToolUse.length, 'hooks')
      console.log('')
      console.log('Details:')
      for (const event of ['SessionStart', 'PreToolUse', 'PostToolUse'] as const) {
        for (const hook of hooks.hooks[event]) {
          console.log(
            `  [${event}] matcher=${hook.matcher || '*'} command="${hook.command.slice(0, 50)}"`,
          )
        }
      }
      continue
    }

    // /help 命令
    if (query.trim() === '/help') {
      console.log('Commands:')
      console.log('  /hooks  - Show current hook configuration')
      console.log('  /help   - Show this help message')
      console.log('  q/exit  - Exit the session')
      continue
    }

    // 正常请求：添加到历史，调用 agent
    history.push({ role: 'user', content: query })
    await agentLoopWithHooks(history, hooks)

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
