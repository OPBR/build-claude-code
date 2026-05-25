/**
 * s10 多模型适配器
 *
 * 不同 LLM 提供商的 API 格式不同：
 * - system prompt 格式
 * - 工具定义格式
 * - 响应格式
 *
 * 用适配器模式隔离差异，核心 Agent Loop 逻辑不变。
 */

import type { ToolDefinition, ContentBlock } from '../core/types'
import { countTokens as anthropicCountTokens } from '@anthropic-ai/tokenizer'
import { getEncoding } from 'js-tiktoken'

// ============================================================================
// 响应类型
// ============================================================================

/** Anthropic API 响应 */
export interface AnthropicResponse {
  content: ContentBlock[]
  stop_reason: 'tool_use' | 'end_turn' | 'max_tokens'
}

/** OpenAI API - 工具调用 */
export interface OpenAIToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

/** OpenAI API - 消息 */
export interface OpenAIMessage {
  role: 'assistant'
  content: string | null
  tool_calls?: OpenAIToolCall[]
}

/** OpenAI API - 选项 */
export interface OpenAIChoice {
  index: number
  message: OpenAIMessage
  finish_reason: 'stop' | 'tool_calls' | 'length'
}

/** OpenAI API 响应 */
export interface OpenAIResponse {
  id: string
  choices: OpenAIChoice[]
}

// ============================================================================
// 接口定义
// ============================================================================

/** LLM 请求参数 */
export interface LLMRequestParams {
  model: string
  system: string
  messages: unknown[]
  tools: ToolDefinition[]
  max_tokens: number
}

/** 标准化后的 LLM 响应 */
export interface NormalizedResponse {
  content: ContentBlock[]
  stopReason: 'tool_use' | 'end_turn' | 'max_tokens'
}

/** 适配器接口 */
export interface ProviderAdapter {
  name: string

  /** 格式化 system prompt */
  formatSystem(system: string): unknown

  /** 格式化工具定义 */
  formatTools(tools: ToolDefinition[]): unknown[]

  /** 构建完整的请求参数 */
  buildRequest(params: LLMRequestParams): Record<string, unknown>

  /** 解析响应为标准化格式 */
  parseResponse(response: unknown): NormalizedResponse

  /** 精确计算 token 数（每个 provider 用自己的 tokenizer） */
  countTokens(text: string): number
}

// ============================================================================
// Anthropic 适配器
// ============================================================================

export class AnthropicAdapter implements ProviderAdapter {
  name = 'anthropic'

  countTokens(text: string): number {
    return anthropicCountTokens(text)
  }

  formatSystem(system: string): string {
    // Anthropic 直接用 system 参数
    return system
  }

  formatTools(tools: ToolDefinition[]): unknown[] {
    return tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema,
    }))
  }

  buildRequest(params: LLMRequestParams): Record<string, unknown> {
    return {
      model: params.model,
      system: this.formatSystem(params.system),
      messages: params.messages,
      tools: this.formatTools(params.tools),
      max_tokens: params.max_tokens,
    }
  }

  parseResponse(response: unknown): NormalizedResponse {
    const res = response as AnthropicResponse
    return {
      content: res.content,
      stopReason: res.stop_reason === 'tool_use' ? 'tool_use' : res.stop_reason,
    }
  }
}

// ============================================================================
// OpenAI 兼容适配器
// ============================================================================

export class OpenAIAdapter implements ProviderAdapter {
  name = 'openai'

  // cl100k_base 用于 GPT-4 / GPT-3.5-turbo / GPT-4o
  private enc = getEncoding('cl100k_base')

  countTokens(text: string): number {
    return this.enc.encode(text).length
  }

  formatSystem(system: string): { role: 'system'; content: string } {
    // OpenAI 用 messages 中的 system 角色
    return { role: 'system', content: system }
  }

  formatTools(tools: ToolDefinition[]): unknown[] {
    return tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      },
    }))
  }

  buildRequest(params: LLMRequestParams): Record<string, unknown> {
    const systemMessage = this.formatSystem(params.system)
    return {
      model: params.model,
      messages: [systemMessage, ...params.messages],
      tools: this.formatTools(params.tools),
      max_tokens: params.max_tokens,
    }
  }

  parseResponse(response: unknown): NormalizedResponse {
    const res = response as OpenAIResponse
    const choice = res.choices?.[0]
    if (!choice) {
      return { content: [{ type: 'text', text: '' }], stopReason: 'end_turn' }
    }

    const message = choice.message

    // 有工具调用
    if (message.tool_calls?.length) {
      const content: ContentBlock[] = message.tool_calls.map((tc) => ({
        type: 'tool_use' as const,
        id: tc.id,
        name: tc.function.name,
        input: JSON.parse(tc.function.arguments),
      }))
      return { content, stopReason: 'tool_use' }
    }

    // 纯文本回复
    // OpenAI 的 'length' 映射到 'max_tokens'，'stop' 映射到 'end_turn'
    const stopReason: NormalizedResponse['stopReason'] =
      choice.finish_reason === 'stop'
        ? 'end_turn'
        : choice.finish_reason === 'length'
          ? 'max_tokens'
          : 'end_turn'

    return {
      content: [{ type: 'text', text: message.content || '' }],
      stopReason,
    }
  }
}

// ============================================================================
// 工厂函数
// ============================================================================

/** 根据环境变量选择适配器 */
export function createAdapter(provider?: string): ProviderAdapter {
  switch (provider) {
    case 'openai':
      return new OpenAIAdapter()
    case 'anthropic':
    default:
      return new AnthropicAdapter()
  }
}
