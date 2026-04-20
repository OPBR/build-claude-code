/**
 * Agent Loop - 核心循环（通用版本）
 * 支持 dispatch map 模式，可用于 s01, s02 等所有 session
 */

import Anthropic from '@anthropic-ai/sdk'
import { execSync } from 'child_process'
import 'dotenv/config'
import { config } from 'dotenv'
config({ override: true })
import type { Message, ContentBlock, ToolResultBlock, ToolDefinition, ToolHandler } from './types'
import type { TodoManager } from '../planning/todo'

// ============================================================================
// Windows 编码修复
// ============================================================================
if (process.platform === 'win32') {
  try {
    execSync('chcp 65001 >nul 2>&1', { shell: 'cmd.exe' })
  } catch {
    // ignore
  }
}

// ============================================================================
// 配置
// ============================================================================

export const WORKDIR = process.cwd()
export const MODEL =
  process.env.MODEL_ID || process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514'

export const authToken = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN
export const baseURL = process.env.ANTHROPIC_BASE_URL

export const client = new Anthropic({
  apiKey: authToken,
  baseURL,
})

// ============================================================================
// Agent Loop Options
// ============================================================================

interface AgentLoopOptions {
  tools: ToolDefinition[]
  handlers: Record<string, ToolHandler>
  system?: string
  todoManager?: TodoManager // s03: 可选的 TodoManager
}

// ============================================================================
// Agent Loop - 核心
// ============================================================================

/**
 * 通用 Agent 循环
 * @param messages 消息历史
 * @param options 配置选项
 */
export async function agentLoop(messages: Message[], options: AgentLoopOptions): Promise<void> {
  const { tools, handlers, system, todoManager } = options

  // 默认系统提示词
  const systemPrompt =
    system ?? `You are a coding agent at ${WORKDIR}. Use tools to solve tasks. Act, don't explain.`

  // 将 ToolDefinition 转换为 Anthropic SDK 格式
  const anthropicTools: Anthropic.Messages.Tool[] = tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema as Anthropic.Messages.Tool.InputSchema,
  }))

  while (true) {
    // 1. 调用 LLM
    const response = await client.messages.create({
      model: MODEL,
      system: systemPrompt,
      messages,
      tools: anthropicTools,
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

    // 4. 执行所有工具调用（dispatch map 模式）
    const results: (ToolResultBlock | { type: 'text'; text: string })[] = []
    let usedTodo = false // s03: 记录是否使用了 todo 工具

    for (const block of response.content) {
      if (block.type === 'tool_use') {
        const toolBlock = block as Anthropic.Messages.ToolUseBlock

        // 从 dispatch map 获取 handler
        const handler = handlers[toolBlock.name]
        if (!handler) {
          console.log(`\x1b[31mUnknown tool: ${toolBlock.name}\x1b[0m`)
          results.push({
            type: 'tool_result',
            tool_use_id: toolBlock.id,
            content: `Error: Unknown tool "${toolBlock.name}"`,
          })
          continue
        }

        // 打印工具调用
        console.log(`\x1b[33m> ${toolBlock.name}\x1b[0m`)
        if (toolBlock.name === 'bash') {
          console.log(`\x1b[33m  $ ${(toolBlock.input as { command: string }).command}\x1b[0m`)
        }

        // 执行工具
        const output = await handler(toolBlock.input as Record<string, unknown>)
        console.log(output.slice(0, 200))

        results.push({
          type: 'tool_result',
          tool_use_id: toolBlock.id,
          content: output,
        })

        // s03: 记录是否使用了 todo
        if (toolBlock.name === 'todo') {
          usedTodo = true
        }
      }
    }

    // s03: 提醒机制
    if (todoManager) {
      if (usedTodo) {
        // 使用了 todo，重置计数
        // (TodoManager.update 已经重置了 roundsSinceUpdate)
      } else {
        // 没有使用 todo，记录一轮
        todoManager.noteRoundWithoutUpdate()
        const reminder = todoManager.reminder()
        if (reminder) {
          // 提醒插入到 results 开头
          results.unshift({ type: 'text', text: reminder })
          console.log(`\x1b[35m${reminder}\x1b[0m`)
        }
      }
    }

    // 5. 将结果追加回消息
    messages.push({
      role: 'user',
      content: results as ContentBlock[],
    })

    // 循环继续...
  }
}

// ============================================================================
// Helper: 提取文本回复
// ============================================================================

export function extractTextReply(messages: Message[]): string {
  const lastContent = messages[messages.length - 1]?.content
  if (Array.isArray(lastContent)) {
    for (const block of lastContent) {
      if (block.type === 'text') {
        return block.text
      }
    }
  }
  return ''
}
