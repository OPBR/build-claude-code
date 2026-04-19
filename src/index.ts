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
  Skill,
  TeamMessage,
  TeammateConfig,
  BackgroundTask,
  BackgroundNotification,
  WorktreeEntry,
  LifecycleEvent,
} from './core/types'

// 函数导出
export { agentLoop } from './core/agent-loop'
export {
  BASE_TOOLS,
  BASE_HANDLERS,
  runBash,
  runRead,
  runWrite,
  runEdit,
  safePath,
  WORKDIR,
} from './core/tools'
