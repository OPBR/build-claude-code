/**
 * Subagent Manager - 上下文隔离
 * s04: 把局部任务放进独立上下文里做，做完只把必要结果带回来
 */

import Anthropic from '@anthropic-ai/sdk'
import { client, MODEL, WORKDIR } from '../core/agent-loop'
import { BASE_TOOLS, BASE_HANDLERS } from '../core/tools'
import type {
  Message,
  ContentBlock,
  ToolDefinition,
  ToolHandler,
  SubagentContext,
} from '../core/types'

// ============================================================================
// 配置
// ============================================================================

/** 子 Agent 最大轮数（防止无限跑） */
const MAX_SUBAGENT_TURNS = 30

/** 子 Agent 系统提示词 */
const SUBAGENT_SYSTEM = `You are a coding subagent at ${WORKDIR}. Complete the given task, then summarize your findings. Be concise in your final summary.`

// ============================================================================
// 工具定义
// ============================================================================

import type { ToolInputSchema } from '../core/types'

/**
 * task 工具定义
 */
export const TASK_TOOL_DEFINITION: ToolDefinition = {
  name: 'task',
  description:
    'Launch a subagent with isolated context for exploration tasks. Use this when: (1) analyzing/searching multiple files or directories, (2) gathering information across codebase, (3) the task needs multiple steps but only final summary matters. Returns only the summary, keeping parent context clean.',
  input_schema: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: 'The specific task for the subagent to complete',
      },
      description: {
        type: 'string',
        description: 'Short label for this task (e.g., "analyze core", "find tests")',
      },
    },
    required: ['prompt'],
  } as ToolInputSchema,
}

// ============================================================================
// 子 Agent 工具集（不含 task，防止递归）
// ============================================================================

/**
 * 子 Agent 可用的工具（只有基础工具，不含 task）
 */
const CHILD_TOOLS: ToolDefinition[] = BASE_TOOLS // bash, read_file, write_file, edit_file
const CHILD_HANDLERS: Record<string, ToolHandler> = BASE_HANDLERS

// ============================================================================
// 子 Agent 执行
// ============================================================================

/**
 * 运行子 Agent（独立上下文）
 * @param prompt 子任务描述
 * @returns 摘要文本（只返回最终结果）
 */
export async function runSubagent(prompt: string): Promise<string> {
  // 1. 创建空白上下文
  const subMessages: Message[] = [{ role: 'user', content: prompt }]

  // 2. 子 Agent 配置
  const context: SubagentContext = {
    messages: subMessages,
    tools: CHILD_TOOLS,
    handlers: CHILD_HANDLERS,
    maxTurns: MAX_SUBAGENT_TURNS,
    systemPrompt: SUBAGENT_SYSTEM,
  }

  // 3. 循环执行，最多 maxTurns 轮
  let lastResponse: Anthropic.Messages.Message | null = null

  for (let turn = 0; turn < context.maxTurns; turn++) {
    // 将 ToolDefinition 转换为 Anthropic SDK 格式
    const anthropicTools: Anthropic.Messages.Tool[] = context.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema as Anthropic.Messages.Tool.InputSchema,
    }))

    const response = await client.messages.create({
      model: MODEL,
      system: context.systemPrompt,
      messages: context.messages,
      tools: anthropicTools,
      max_tokens: 8000,
    })

    lastResponse = response
    context.messages.push({
      role: 'assistant',
      content: response.content as ContentBlock[],
    })

    // 如果模型决定停止，退出循环
    if (response.stop_reason !== 'tool_use') {
      break
    }

    // 执行工具调用
    const results: ContentBlock[] = []
    for (const block of response.content) {
      if (block.type === 'tool_use') {
        const toolBlock = block as Anthropic.Messages.ToolUseBlock

        // 从 dispatch map 获取 handler
        const handler = context.handlers[toolBlock.name]
        if (!handler) {
          results.push({
            type: 'tool_result',
            tool_use_id: toolBlock.id,
            content: `Error: Unknown tool "${toolBlock.name}"`,
          })
          continue
        }

        // 执行工具
        const output = await handler(toolBlock.input as Record<string, unknown>)
        results.push({
          type: 'tool_result',
          tool_use_id: toolBlock.id,
          content: output.slice(0, 50000), // 限制输出长度
        })
      }
    }

    // 将结果追加回消息
    context.messages.push({
      role: 'user',
      content: results,
    })
  }

  // 4. 只返回最终文本摘要（中间过程丢弃）
  if (lastResponse) {
    const textBlocks = lastResponse.content.filter(
      (b) => b.type === 'text',
    ) as Anthropic.Messages.TextBlock[]
    if (textBlocks.length > 0) {
      return textBlocks.map((b) => b.text).join('\n')
    }
  }

  return '(no summary)'
}

// ============================================================================
// Handler 创建
// ============================================================================

/**
 * 创建 task handler
 */
export function createTaskHandler(): ToolHandler {
  return async (input: Record<string, unknown>): Promise<string> => {
    const prompt = input.prompt as string
    const description = input.description as string | undefined

    if (!prompt) {
      return 'Error: prompt is required'
    }

    // 打印日志
    console.log(
      `\x1b[33m> task (${description || 'subtask'}): ${prompt.slice(0, 80)}${prompt.length > 80 ? '...' : ''}\x1b[0m`,
    )

    // 运行子 Agent
    const summary = await runSubagent(prompt)

    // 打印摘要（截断显示）
    console.log(`\x1b[33m  ${summary.slice(0, 200)}${summary.length > 200 ? '...' : ''}\x1b[0m`)

    return summary
  }
}
