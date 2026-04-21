/**
 * 核心类型定义
 * 所有 session 共享的基础类型
 */

// ============================================================================
// Anthropic API 相关类型
// ============================================================================

export interface Message {
  role: 'user' | 'assistant'
  content: string | ContentBlock[]
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock

export interface TextBlock {
  type: 'text'
  text: string
}

export interface ToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

export interface ToolResultBlock {
  type: 'tool_result'
  tool_use_id: string
  content: string
  is_error?: boolean
}

export interface ToolDefinition {
  name: string
  description: string
  input_schema: ToolInputSchema
}

export interface ToolInputSchema {
  type: 'object'
  properties: Record<string, ToolProperty>
  required?: string[]
}

export interface ToolProperty {
  type: string
  description?: string
  enum?: string[]
  items?: ToolProperty
  properties?: Record<string, ToolProperty> // s03: 支持嵌套对象
  required?: string[] // s03: 支持嵌套对象的 required
}

// ============================================================================
// 工具处理相关
// ============================================================================

export type ToolHandler = (input: Record<string, unknown>) => string | Promise<string>

export interface ToolRegistry {
  definitions: ToolDefinition[]
  handlers: Record<string, ToolHandler>
}

// ============================================================================
// Todo 相关 (s03)
// ============================================================================

export interface TodoItem {
  id: string
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  activeForm?: string
}

// ============================================================================
// Subagent 相关 (s04)
// ============================================================================

export interface SubagentContext {
  messages: Message[] // 子 Agent 自己的上下文（从空白开始）
  tools: ToolDefinition[] // 子 Agent 可用的工具（过滤后的）
  handlers: Record<string, ToolHandler> // 工具执行函数
  maxTurns: number // 最大轮数，防止无限跑
  systemPrompt: string // 子 Agent 的系统提示词
}

// ============================================================================
// Task 相关 (s07)
// ============================================================================

export interface Task {
  id: number
  subject: string
  description?: string
  status: 'pending' | 'in_progress' | 'completed'
  owner?: string
  blockedBy?: number[]
  createdAt?: number
  updatedAt?: number
}

// ============================================================================
// Skill 相关 (s05)
// ============================================================================

export interface Skill {
  name: string
  meta: Record<string, string>
  body: string
  path: string
}

// ============================================================================
// Team 相关 (s09)
// ============================================================================

export interface TeamMessage {
  type:
    | 'message'
    | 'broadcast'
    | 'shutdown_request'
    | 'shutdown_response'
    | 'plan_approval_response'
  from: string
  content: string
  timestamp: number
  extra?: Record<string, unknown>
}

export interface TeammateConfig {
  name: string
  role: string
  status: 'working' | 'idle' | 'shutdown'
}

// ============================================================================
// Background Task 相关 (s08)
// ============================================================================

export interface BackgroundTask {
  id: string
  status: 'running' | 'completed' | 'error' | 'timeout'
  command: string
  result?: string
}

export interface BackgroundNotification {
  task_id: string
  status: string
  result: string
}

// ============================================================================
// Worktree 相关 (s12)
// ============================================================================

export interface WorktreeEntry {
  name: string
  path: string
  branch: string
  task_id?: number
  status: 'active' | 'removed' | 'kept'
  created_at?: number
}

export interface LifecycleEvent {
  event: string
  ts: number
  task?: Record<string, unknown>
  worktree?: Record<string, unknown>
  error?: string
}
