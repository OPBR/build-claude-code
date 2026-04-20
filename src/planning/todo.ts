/**
 * Todo Manager - 会话内计划管理
 * s03: 把"正在做什么"从模型脑内移到系统可观察的状态
 */

import type { TodoItem } from '../core/types'

// ============================================================================
// 配置
// ============================================================================

/** 多轮没更新计划后触发提醒 */
const PLAN_REMINDER_INTERVAL = 3

/** 计划最大条目数（防止过长） */
const MAX_PLAN_ITEMS = 12

// ============================================================================
// Planning State
// ============================================================================

interface PlanningState {
  items: TodoItem[]
  roundsSinceUpdate: number
}

// ============================================================================
// Todo Manager
// ============================================================================

/**
 * 会话内计划管理器
 *
 * 核心约束：同一时间最多一个 in_progress
 * 目的：强制模型聚焦当前一步
 */
export class TodoManager {
  private state: PlanningState = {
    items: [],
    roundsSinceUpdate: 0,
  }

  /**
   * 更新计划（模型整份重写）
   * @param items 新的计划条目列表
   * @returns 渲染后的可读文本
   */
  update(items: unknown[]): string {
    if (items.length > MAX_PLAN_ITEMS) {
      throw new Error(`Keep the session plan short (max ${MAX_PLAN_ITEMS} items)`)
    }

    const normalized: TodoItem[] = []
    let inProgressCount = 0

    for (let i = 0; i < items.length; i++) {
      const rawItem = items[i] as Record<string, unknown>

      const content = String(rawItem.content || '').trim()
      const status = String(rawItem.status || 'pending').toLowerCase() as
        | 'pending'
        | 'in_progress'
        | 'completed'
      const activeForm = String(rawItem.activeForm || '').trim()

      // 验证
      if (!content) {
        throw new Error(`Item ${i}: content required`)
      }
      if (!['pending', 'in_progress', 'completed'].includes(status)) {
        throw new Error(`Item ${i}: invalid status '${status}'`)
      }
      if (status === 'in_progress') {
        inProgressCount++
      }

      normalized.push({
        id: String(i + 1),
        content,
        status,
        activeForm,
      })
    }

    // 核心约束：最多一个 in_progress
    if (inProgressCount > 1) {
      throw new Error('Only one plan item can be in_progress')
    }

    this.state.items = normalized
    this.state.roundsSinceUpdate = 0

    return this.render()
  }

  /**
   * 记录一轮没有更新计划
   */
  noteRoundWithoutUpdate(): void {
    this.state.roundsSinceUpdate++
  }

  /**
   * 获取提醒文本（如果需要）
   * @returns 提醒文本或 null
   */
  reminder(): string | null {
    // 无计划时不提醒
    if (this.state.items.length === 0) {
      return null
    }
    // 未达到阈值时不提醒
    if (this.state.roundsSinceUpdate < PLAN_REMINDER_INTERVAL) {
      return null
    }
    return '<reminder>Refresh your current plan before continuing.</reminder>'
  }

  /**
   * 渲染计划为可读文本
   */
  render(): string {
    if (this.state.items.length === 0) {
      return 'No session plan yet.'
    }

    const lines: string[] = []
    for (const item of this.state.items) {
      const marker: Record<string, string> = {
        pending: '[ ]',
        in_progress: '[>]',
        completed: '[x]',
      }
      let line = `${marker[item.status]} ${item.content}`
      if (item.status === 'in_progress' && item.activeForm) {
        line += ` (${item.activeForm})`
      }
      lines.push(line)
    }

    // 进度统计
    const completed = this.state.items.filter((i) => i.status === 'completed').length
    lines.push(`\n(${completed}/${this.state.items.length} completed)`)

    return lines.join('\n')
  }

  /**
   * 获取当前状态（用于调试）
   */
  getState(): PlanningState {
    return this.state
  }
}

// ============================================================================
// 工具定义
// ============================================================================

import type { ToolDefinition } from '../core/types'

/**
 * todo 工具定义
 */
export const TODO_TOOL_DEFINITION: ToolDefinition = {
  name: 'todo',
  description: 'Rewrite the current session plan for multi-step work.',
  input_schema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'What this step does' },
            status: {
              type: 'string',
              enum: ['pending', 'in_progress', 'completed'],
              description: 'Current status of this step',
            },
            activeForm: {
              type: 'string',
              description: 'Optional present-continuous label (e.g., "Reading the file")',
            },
          },
          required: ['content', 'status'],
        },
      },
    },
    required: ['items'],
  },
}

/**
 * 创建 todo handler
 * @param manager TodoManager 实例
 */
export function createTodoHandler(manager: TodoManager) {
  return (input: Record<string, unknown>): string => {
    const items = input.items as unknown[]
    try {
      return manager.update(items)
    } catch (error) {
      return `Error: ${error instanceof Error ? error.message : 'Unknown error'}`
    }
  }
}
