/**
 * s06 Session 入口 - Context Compact
 * 三层压缩策略实现无限会话
 */

import readline from 'node:readline'
import Anthropic from '@anthropic-ai/sdk'
import { client, MODEL, WORKDIR } from '../core/agent-loop'
import { BASE_TOOLS, runBash, runRead, runWrite, runEdit } from '../core/tools'
import {
  createCompactState,
  estimateContextSize,
  trackRecentFile,
  persistLargeOutput,
  microCompact,
  compactHistory,
  COMPACT_TOOL_DEFINITION,
  CONTEXT_LIMIT,
} from '../persistence/compact'
import type { Message, ContentBlock, ToolDefinition, CompactState } from '../core/types'

// s06 系统提示词
const S06_SYSTEM = `You are a coding agent at ${WORKDIR}. Keep working step by step, and use compact if the conversation gets too long.`

// ============================================================================
// 工具执行（带压缩逻辑）
// ============================================================================

/**
 * 执行工具（带持久化和文件追踪）
 */
async function executeToolWithCompact(
  block: { name: string; id: string; input: Record<string, unknown> },
  state: CompactState,
): Promise<string> {
  const { name, id, input } = block

  if (name === 'bash') {
    const command = input.command as string
    const output = await runBash({ command })
    return persistLargeOutput(id, output)
  }

  if (name === 'read_file') {
    const filePath = input.path as string
    trackRecentFile(state, filePath)

    const content = await runRead({ path: filePath, limit: input.limit as number | undefined })
    return persistLargeOutput(id, content)
  }

  if (name === 'write_file') {
    return runWrite({ path: input.path as string, content: input.content as string })
  }

  if (name === 'edit_file') {
    return runEdit({
      path: input.path as string,
      old_text: input.old_text as string,
      new_text: input.new_text as string,
    })
  }

  if (name === 'compact') {
    return 'Compacting conversation...'
  }

  return `Unknown tool: ${name}`
}

// ============================================================================
// 主循环（带压缩）
// ============================================================================

/**
 * Agent 循环（带三层压缩）
 */
async function agentLoopWithCompact(
  messages: Message[],
  state: CompactState,
  tools: ToolDefinition[],
): Promise<void> {
  while (true) {
    // 每轮开始前做微压缩
    messages = microCompact(messages)

    // 检查是否需要完整压缩
    if (estimateContextSize(messages) > CONTEXT_LIMIT) {
      console.log('[auto compact]')
      messages = await compactHistory(messages, state)
    }

    // 调用模型
    const anthropicTools = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema as Anthropic.Messages.Tool.InputSchema,
    }))

    const response = await client.messages.create({
      model: MODEL,
      system: S06_SYSTEM,
      messages,
      tools: anthropicTools,
      max_tokens: 8000,
    })

    messages.push({ role: 'assistant', content: response.content as ContentBlock[] })

    if (response.stop_reason !== 'tool_use') {
      return
    }

    // 执行工具
    const results: ContentBlock[] = []
    let manualCompact = false
    let compactFocus: string | undefined

    for (const block of response.content) {
      if (block.type !== 'tool_use') continue

      const toolBlock = block as Anthropic.Messages.ToolUseBlock
      const output = await executeToolWithCompact(
        {
          name: toolBlock.name,
          id: toolBlock.id,
          input: toolBlock.input as Record<string, unknown>,
        },
        state,
      )

      if (toolBlock.name === 'compact') {
        manualCompact = true
        const input = toolBlock.input as Record<string, unknown> | undefined
        compactFocus = (input?.focus as string) || undefined
      }

      console.log(`> ${toolBlock.name}: ${output.slice(0, 200)}`)
      results.push({
        type: 'tool_result',
        tool_use_id: toolBlock.id,
        content: output,
      })
    }

    messages.push({ role: 'user', content: results })

    // 手动压缩
    if (manualCompact) {
      console.log('[manual compact]')
      messages = await compactHistory(messages, state, compactFocus)
    }
  }
}

/**
 * 提取文本回复
 */
function extractTextReply(messages: Message[]): string {
  const lastContent = messages[messages.length - 1]?.content
  if (Array.isArray(lastContent)) {
    for (const block of lastContent) {
      if (block.type === 'text') {
        return (block as { text: string }).text
      }
    }
  }
  return ''
}

// ============================================================================
// REPL 入口
// ============================================================================

async function main() {
  console.log('\x1b[36m╔════════════════════════════════════╗\x1b[0m')
  console.log('\x1b[36m║  s06 - Context Compact             ║\x1b[0m')
  console.log('\x1b[36m║  "Keep working, keep compact"      ║\x1b[0m')
  console.log('\x1b[36m╚════════════════════════════════════╝\x1b[0m')
  console.log()

  // 检查 API Key
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    console.error('\x1b[31mError: API key not set\x1b[0m')
    console.error('Please copy .env.example to .env and add your API key')
    process.exit(1)
  }

  // 初始化压缩状态
  const compactState = createCompactState()

  // s06 工具：基础 4 个 + compact
  const S06_TOOLS: ToolDefinition[] = [...BASE_TOOLS, COMPACT_TOOL_DEFINITION]

  console.log(`Working directory: ${WORKDIR}`)
  console.log('Tools: bash, read_file, write_file, edit_file, compact')
  console.log('Type "q" or "exit" to quit.\n')

  const history: Message[] = []
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  const prompt = (): void => {
    rl.question('\x1b[36ms06 >> \x1b[0m', async (query: string) => {
      const trimmed = query.trim().toLowerCase()

      if (trimmed === 'q' || trimmed === 'exit' || trimmed === '') {
        rl.close()
        console.log('Goodbye!')
        return
      }

      history.push({ role: 'user', content: query })

      try {
        await agentLoopWithCompact(history, compactState, S06_TOOLS)
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
