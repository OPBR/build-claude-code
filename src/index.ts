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
  ErrorCategory,
  RecoveryDecision,
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

// 后台任务导出 (s13)
export { BackgroundManager } from './persistence/background'

export type { BackgroundTask } from './persistence/background'

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

// 错误恢复导出 (s11)
export {
  agentLoopWithRecovery,
  classifyError,
  chooseRecovery,
  backoffDelay,
  autoCompact,
  countMessageTokens,
  MAX_RECOVERY_ATTEMPTS,
  TOKEN_THRESHOLD,
  CONTINUATION_MESSAGE,
} from './persistence/recovery'

export type { RecoveryLoopOptions } from './persistence/recovery'
