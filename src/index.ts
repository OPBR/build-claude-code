/**
 * build-claude-code
 * 从0到1构建 Claude Code 风格的 AI Coding Agent
 */

export const VERSION = '0.0.1'
export const PROJECT_NAME = 'build-claude-code'

// 类型导出
export type {
  Message,
  ContentBlock,
  TextBlock,
  ToolUseBlock,
  ToolResultBlock,
  ToolDefinition,
  ToolHandler,
  TodoItem,
  Task,
  SkillManifest,
  SkillDocument,
  TeamMessage,
  TeammateConfig,
  WorktreeEntry,
  LifecycleEvent,
  HookEvent,
  HookDefinition,
  HookContext,
  HookResult,
  MemoryType,
  MemoryEntry,
  ParsedMemory,
  PromptBuilderOptions,
  PromptBudget,
  InjectionScore,
} from './core/types'

// 核心函数导出
export { agentLoop, extractTextReply, WORKDIR, MODEL, client } from './core/agent-loop'

// 工具导出
export {
  BASE_TOOLS,
  BASE_HANDLERS,
  runBash,
  runRead,
  runWrite,
  runEdit,
  safePath,
} from './core/tools'

// 记忆系统导出 (s09)
export { MemoryManager, MEMORY_GUIDANCE } from './persistence/memory'

// 系统提示词导出 (s10)
export {
  SystemPromptBuilder,
  DYNAMIC_BOUNDARY,
  buildSystemReminder,
  estimateTokens,
  DEFAULT_BUDGET,
  wrapAsData,
  sanitizeForPrompt,
  detectInjection,
  detectPromptLeakage,
} from './persistence/prompt'

// 任务系统导出 (s12)
export { TaskManager, TASK_TOOLS, createTaskHandlers } from './persistence/task-manager'

// 多模型适配器导出 (s10)
export { AnthropicAdapter, OpenAIAdapter, createAdapter } from './persistence/adapter'

export type {
  ProviderAdapter,
  LLMRequestParams,
  NormalizedResponse,
  AnthropicResponse,
  OpenAIResponse,
  OpenAIChoice,
  OpenAIMessage,
  OpenAIToolCall,
} from './persistence/adapter'
