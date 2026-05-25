/**
 * s12 Task System
 * 文件持久化的任务图，支持 blockedBy 依赖
 *
 * 对标原项目 s12_task_system/code.py
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { WORKDIR } from '../core/agent-loop'
import type { Task, ToolDefinition, ToolHandler } from '../core/types'

// ============================================================================
// 常量
// ============================================================================

const TASKS_DIR = path.join(WORKDIR, '.tasks')

// ============================================================================
// ID 生成
// ============================================================================

/**
 * 生成任务 ID：task_{timestamp}_{random4位}
 * 对标原项目：f"task_{int(time.time())}_{random.randint(0, 9999):04d}"
 */
function generateTaskId(): string {
  const ts = Math.floor(Date.now() / 1000)
  const rand = Math.floor(Math.random() * 10000)
    .toString()
    .padStart(4, '0')
  return `task_${ts}_${rand}`
}

/**
 * 任务管理器
 */
export class TaskManager {
  private dir: string

  constructor(tasksDir: string = TASKS_DIR) {
    this.dir = tasksDir
  }

  /**
   * 确保 .tasks/ 目录存在
   */
  private async ensureDir(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true })
  }

  /**
   * 获取任务文件路径
   */
  private taskPath(taskId: string): string {
    return path.join(this.dir, `${taskId}.json`)
  }

  /**
   * 从文件加载任务
   */
  async load(taskId: string): Promise<Task> {
    const filePath = this.taskPath(taskId)
    const content = await fs.readFile(filePath, 'utf-8')
    return JSON.parse(content) as Task
  }

  /**
   * 保存任务到文件
   */
  async save(task: Task): Promise<void> {
    await this.ensureDir()
    const filePath = this.taskPath(task.id)
    await fs.writeFile(filePath, JSON.stringify(task, null, 2), 'utf-8')
  }

  /**
   * 创建新任务
   */
  async create(subject: string, description: string = '', blockedBy: string[] = []): Promise<Task> {
    // 验证 blockedBy 中的 ID 是否存在
    for (const depId of blockedBy) {
      try {
        await this.load(depId)
      } catch {
        throw new Error(
          `Dependency task ${depId} not found. Use list_tasks to see existing task IDs.`,
        )
      }
    }

    const now = Math.floor(Date.now() / 1000)
    const task: Task = {
      id: generateTaskId(),
      subject,
      description,
      status: 'pending',
      owner: null,
      blockedBy,
      createdAt: now,
      updatedAt: now,
    }
    await this.save(task)
    return task
  }

  /**
   * 获取单个任务详情
   */
  async get(taskId: string): Promise<Task> {
    return this.load(taskId)
  }

  /**
   * 列出所有任务（按创建时间排序）
   */
  async listAll(): Promise<Task[]> {
    await this.ensureDir()
    const files = await fs.readdir(this.dir)
    const taskFiles = files.filter((f) => f.endsWith('.json')).sort()

    const tasks: Task[] = []
    for (const file of taskFiles) {
      try {
        const content = await fs.readFile(path.join(this.dir, file), 'utf-8')
        tasks.push(JSON.parse(content) as Task)
      } catch {
        // 跳过损坏的文件
      }
    }
    return tasks
  }

  /**
   * 检查任务是否可以开始（所有 blockedBy 依赖都已完成）
   * 对标原项目 can_start()
   */
  async canStart(taskId: string): Promise<boolean> {
    const task = await this.load(taskId)
    for (const depId of task.blockedBy) {
      try {
        const dep = await this.load(depId)
        if (dep.status !== 'completed') {
          return false
        }
      } catch {
        // 依赖任务不存在 = 阻塞
        return false
      }
    }
    return true
  }

  /**
   * 领取任务：pending → in_progress
   * 对标原项目 claim_task()
   */
  async claimTask(taskId: string, owner: string = 'agent'): Promise<string> {
    const task = await this.load(taskId)

    // 状态检查
    if (task.status !== 'pending') {
      return `Task ${taskId} is ${task.status}, cannot claim`
    }

    // 依赖检查
    if (!(await this.canStart(taskId))) {
      const blockedDeps = []
      for (const depId of task.blockedBy) {
        try {
          const dep = await this.load(depId)
          if (dep.status !== 'completed') {
            blockedDeps.push(depId)
          }
        } catch {
          blockedDeps.push(depId)
        }
      }
      return `Blocked by: [${blockedDeps.join(', ')}]`
    }

    // 领取
    task.owner = owner
    task.status = 'in_progress'
    task.updatedAt = Math.floor(Date.now() / 1000)
    await this.save(task)

    return `Claimed ${taskId} (${task.subject})`
  }

  /**
   * 完成任务：in_progress → completed
   * 完成后报告哪些下游任务被解锁
   * 对标原项目 complete_task()
   */
  async completeTask(taskId: string): Promise<string> {
    const task = await this.load(taskId)

    // 状态检查
    if (task.status !== 'in_progress') {
      return `Task ${taskId} is ${task.status}, cannot complete`
    }

    // 标记完成
    task.status = 'completed'
    task.updatedAt = Math.floor(Date.now() / 1000)
    await this.save(task)

    // 扫描所有 pending 任务，找出刚被解锁的
    const allTasks = await this.listAll()
    const unblocked: string[] = []
    for (const t of allTasks) {
      if (t.status === 'pending' && t.blockedBy.length > 0 && (await this.canStart(t.id))) {
        unblocked.push(t.subject)
      }
    }

    let msg = `Completed ${taskId} (${task.subject})`
    if (unblocked.length > 0) {
      msg += `\nUnblocked: ${unblocked.join(', ')}`
    }
    return msg
  }

  /**
   * 渲染任务列表（人类可读格式）
   * 对标原项目的 list_tasks 输出格式
   */
  async renderList(): Promise<string> {
    const tasks = await this.listAll()
    if (tasks.length === 0) {
      return 'No tasks. Use create_task to add some.'
    }

    const lines: string[] = []
    for (const t of tasks) {
      const icon =
        t.status === 'pending'
          ? '○'
          : t.status === 'in_progress'
            ? '●'
            : t.status === 'completed'
              ? '✓'
              : '?'
      const deps = t.blockedBy.length > 0 ? ` (blockedBy: ${t.blockedBy.join(', ')})` : ''
      const owner = t.owner ? ` [${t.owner}]` : ''
      lines.push(`  ${icon} ${t.id}: ${t.subject} [${t.status}]${owner}${deps}`)
    }
    return lines.join('\n')
  }
}

// ============================================================================
// 工具定义
// ============================================================================

export const TASK_TOOLS: ToolDefinition[] = [
  {
    name: 'create_task',
    description: 'Create a new task with optional blockedBy dependencies.',
    input_schema: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: 'Short title for the task' },
        description: {
          type: 'string',
          description: 'Detailed description of the task',
        },
        blockedBy: {
          type: 'array',
          items: { type: 'string' },
          description: 'Task IDs that must be completed before this task can start',
        },
      },
      required: ['subject'],
    },
  },
  {
    name: 'list_tasks',
    description: 'List all tasks with status, owner, and dependencies.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_task',
    description: 'Get full details of a specific task by ID.',
    input_schema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'The task ID to look up' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'claim_task',
    description:
      'Claim a pending task. Sets owner and changes status to in_progress. ' +
      'Fails if dependencies are not met or task is not pending.',
    input_schema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'The task ID to claim' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'complete_task',
    description: 'Complete an in-progress task. Reports which downstream tasks are unblocked.',
    input_schema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'The task ID to complete' },
      },
      required: ['task_id'],
    },
  },
]

// ============================================================================
// 工具 handlers
// ============================================================================

export function createTaskHandlers(taskManager: TaskManager): Record<string, ToolHandler> {
  return {
    create_task: async (input) => {
      const task = await taskManager.create(
        input.subject as string,
        (input.description as string) || '',
        (input.blockedBy as string[]) || [],
      )
      const deps = task.blockedBy.length > 0 ? ` (blockedBy: ${task.blockedBy.join(', ')})` : ''
      return `Created ${task.id}: ${task.subject}${deps}`
    },

    list_tasks: async () => {
      return taskManager.renderList()
    },

    get_task: async (input) => {
      try {
        const task = await taskManager.get(input.task_id as string)
        return JSON.stringify(task, null, 2)
      } catch {
        return `Error: Task ${input.task_id} not found`
      }
    },

    claim_task: async (input) => {
      return taskManager.claimTask(input.task_id as string)
    },

    complete_task: async (input) => {
      return taskManager.completeTask(input.task_id as string)
    },
  }
}
