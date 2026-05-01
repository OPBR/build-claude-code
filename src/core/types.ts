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
// Permission 相关 (s07)
// ============================================================================

/** 权限模式 */
export type PermissionMode = 'default' | 'plan' | 'auto'

/** 权限行为 */
export type PermissionBehavior = 'allow' | 'deny' | 'ask'

/** 权限规则 */
export interface PermissionRule {
  tool: string // 工具名或 "*"
  behavior: PermissionBehavior
  path?: string // 路径 glob 模式
  content?: string // 内容 glob 模式（用于 bash）
}

/** 权限决策结果 */
export interface PermissionDecision {
  behavior: PermissionBehavior
  reason: string
}

/** Bash 安全验证失败项 */
export interface BashValidationFailure {
  name: string // 验证器名称
  pattern: string // 匹配的模式
}

// ============================================================================
// Task 相关 (s12)
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

/** Skill 元信息（轻量，用于目录展示） */
export interface SkillManifest {
  name: string // skill 名称
  description: string // 一句话描述
  path: string // 文件路径
}

/** Skill 完整内容（按需加载） */
export interface SkillDocument {
  manifest: SkillManifest // 元信息
  body: string // 完整正文
}

// ============================================================================
// Compact 相关 (s06)
// ============================================================================

/** 上下文压缩状态 */
export interface CompactState {
  hasCompacted: boolean // 是否已做过完整压缩
  lastSummary: string // 最近一次压缩摘要
  recentFiles: string[] // 最近碰过的文件（压缩后可追踪）
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
// Hook 相关 (s08)
// ============================================================================

/** Hook 事件名（什么时候触发） */
export type HookEvent = 'SessionStart' | 'PreToolUse' | 'PostToolUse'

/** 单个 Hook 的定义 */
export interface HookDefinition {
  matcher?: string // 工具名匹配，"*" 或省略表示所有工具
  command: string // 要执行的 shell 命令
}

/** Hook 执行时的上下文（告诉 Hook 当前发生了什么） */
export interface HookContext {
  tool_name: string // 工具名
  tool_input: Record<string, unknown> // 工具输入参数
  tool_output?: string // 工具输出结果（PostToolUse 才有）
}

/** Hook 执行后的结果 */
export interface HookResult {
  blocked: boolean // 是否阻止工具执行
  blockReason?: string // 阻止的原因
  messages: string[] // 要注入给模型的消息
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
