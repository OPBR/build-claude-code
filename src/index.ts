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
