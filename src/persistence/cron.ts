/**
 * s14 Cron Scheduler
 * 定时任务调度：cron 表达式匹配 + 队列交付
 *
 * 对标原项目 s14_cron_scheduler/code.py
 * 差异：Node.js 单线程不需要 Lock，用 setInterval/setTimeout 代替 threading.Thread
 */

import fs from 'node:fs'
import path from 'node:path'
import type { ToolDefinition, ToolHandler } from '../core/types'
import { WORKDIR } from '../core/agent-loop'

// ============================================================================
// CronJob 数据结构
// ============================================================================

/**
 * 一个 cron 定时任务
 *
 * 为什么是这 5 个字段？对标原项目 CronJob dataclass：
 *   id:       唯一标识，注册后返回给 LLM，后续取消/列表用
 *   cron:     5-field cron 表达式，决定"什么时候触发"
 *   prompt:   触发时注入给 Agent 的消息，决定"触发后做什么"
 *   recurring: 周期性 vs 一次性。一次性触发后自动删除
 *   durable:  持久化 vs 会话级。durable 写磁盘，跨重启恢复
 */
export interface CronJob {
  id: string // "cron_XXXXXX"，随机 6 位数字
  cron: string // "0 9 * * *" (5-field: min hour dom month dow)
  prompt: string // 触发时注入给 Agent 的消息
  recurring: boolean // True=周期性，False=一次性（触发后自动删除）
  durable: boolean // True=写磁盘 .scheduled_tasks.json，跨重启恢复
}

// ============================================================================
// cron 匹配函数
// ============================================================================

/**
 * 判断一个 cron 字段值是否匹配当前时间的对应数值
 *
 * 这是 cron 匹配的最底层函数——5-field cron 表达式的每个字段
 * 都是独立的匹配规则，cronFieldMatches 负责解析单个规则并判断是否匹配。
 *
 * 支持的语法（和原项目 _cron_field_matches 一致）：
 *   "*"       → 匹配所有值（"每分钟"、"每小时"、"每天"）
 *   "* /N"    → 每隔 N（"* /5" = 每隔 5，值 0,5,10,15,... 匹配）
 *   "N"       → 具体值（"0" = 只匹配 0）
 *   "N-M"     → 范围（"1-5" = 匹配 1,2,3,4,5）
 *   "N,M,..." → 列表（"1,15" = 匹配 1 或 15）
 *
 * 为什么先判断逗号再判断范围？因为逗号优先级更高：
 * "1-5,10" = 范围1-5 或 值10。逗号里的每个子项独立匹配。
 * 如果先判断范围，"1-5,10" 会被错误地解析。
 *
 * @param field  cron 字段值（如 "*"、"* /5"、"1-5"、"1,15"）
 * @param value  当前时间的对应数值（如 10、9、1、12）
 * @returns      是否匹配
 */
export function cronFieldMatches(field: string, value: number): boolean {
  // 1. "*" → 匹配所有值
  if (field === '*') return true

  // 2. "*/N" → 值能被 N 整除就匹配
  //    例子："*/5" 在分钟位 → 0,5,10,15,... 都匹配
  //    为什么要求 step > 0？防止 "*/0" 导致所有值都匹配（0 整除任何数）
  if (field.startsWith('*/')) {
    const step = parseInt(field.slice(2), 10)
    return step > 0 && value % step === 0
  }

  // 3. "N,M,..." → 列表，逗号分隔的每个子项独立匹配
  //    例子："1,15" → 匹配 1 或 15
  //    递归调用 cronFieldMatches，所以子项可以是任何语法（"1-5,10" 也行）
  //    为什么优先判断逗号？因为逗号是最高优先级的分隔符
  if (field.includes(',')) {
    return field.split(',').some((f) => cronFieldMatches(f.trim(), value))
  }

  // 4. "N-M" → 范围，从 N 到 M 的所有值都匹配
  //    例子："1-5" → 匹配 1,2,3,4,5
  //    注意：N <= M 才是合法范围（验证函数会检查）
  if (field.includes('-')) {
    const [lo, hi] = field.split('-', 2).map(Number)
    return lo <= value && value <= hi
  }

  // 5. "N" → 具体值，只有等于 N 才匹配
  //    例子："0" → 只匹配 0
  return value === parseInt(field, 10)
}

/**
 * 判断 5-field cron 表达式是否匹配给定时间
 * 对标原项目 cron_matches()
 *
 * JavaScript 和 Python 的日期映射差异：
 *   DOW: Python Monday=0 需要 (weekday+1)%7 转换；JS Sunday=0 直接用 getDay()
 *   Month: Python 1-indexed；JS 0-indexed 需要 getMonth()+1
 */
export function cronMatches(cronExpr: string, now: Date): boolean {
  const fields = cronExpr.trim().split(/\s+/)
  if (fields.length !== 5) return false

  const [minute, hour, dom, month, dow] = fields

  // 分钟、小时、月：必须全部匹配
  if (!cronFieldMatches(minute, now.getMinutes())) return false
  if (!cronFieldMatches(hour, now.getHours())) return false
  if (!cronFieldMatches(month, now.getMonth() + 1)) return false

  // 日（DOM）和星期（DOW）：标准 cron 用 OR 语义
  // 例子："0 0 1 * 1" = 每月1号 OR 每个周一，任一满足就触发
  // 四种情况：
  //   dom=* dow=*   → 都没约束，直接匹配
  //   dom=* dow=N   → 只看星期
  //   dom=N dow=*   → 只看日
  //   dom=N dow=N   → 两者都约束，OR 语义（日匹配 OR 星期匹配）
  const domOk = cronFieldMatches(dom, now.getDate())
  const dowOk = cronFieldMatches(dow, now.getDay())
  const domUnconstrained = dom === '*'
  const dowUnconstrained = dow === '*'

  if (domUnconstrained && dowUnconstrained) return true
  if (domUnconstrained) return dowOk
  if (dowUnconstrained) return domOk
  return domOk || dowOk // 两者都约束：OR 语义
}

// ============================================================================
// cron 校验函数
// ============================================================================

/**
 * 校验单个 cron 字段值是否在合法范围内
 * 对标原项目 _validate_cron_field()
 */
function validateCronField(field: string, lo: number, hi: number): string | null {
  if (field === '*') return null
  if (field.startsWith('*')) {
    const stepStr = field.slice(2) // 去掉 "*/"，留步进值
    if (!/^\d+$/.test(stepStr)) return `Invalid step: ${field}`
    const step = parseInt(stepStr, 10)
    if (step <= 0) return `Step must be > 0: ${field}`
    return null
  }
  if (field.includes(',')) {
    for (const part of field.split(',')) {
      const err = validateCronField(part.trim(), lo, hi)
      if (err) return err
    }
    return null
  }
  if (field.includes('-')) {
    const parts = field.split('-', 2)
    if (!/^\d+$/.test(parts[0]) || !/^\d+$/.test(parts[1])) return `Invalid range: ${field}`
    const a = parseInt(parts[0], 10)
    const b = parseInt(parts[1], 10)
    if (a < lo || a > hi || b < lo || b > hi) return `Range ${field} out of bounds [${lo}-${hi}]`
    if (a > b) return `Range start > end: ${field}`
    return null
  }
  if (!/^\d+$/.test(field)) return `Invalid field: ${field}`
  const val = parseInt(field, 10)
  if (val < lo || val > hi) return `Value ${val} out of bounds [${lo}-${hi}]`
  return null
}

/**
 * 校验 5-field cron 表达式是否合法
 * 对标原项目 validate_cron()
 * 返回 null 表示合法，返回错误信息表示非法
 */
export function validateCron(cronExpr: string): string | null {
  const fields = cronExpr.trim().split(/\s+/)
  if (fields.length !== 5) return `Expected 5 fields, got ${fields.length}`

  // 5 个字段的合法范围
  const bounds: [number, number][] = [
    [0, 59], // 分钟
    [0, 23], // 小时
    [1, 31], // 日
    [1, 12], // 月
    [0, 6], // 星期
  ]
  const names = ['minute', 'hour', 'day-of-month', 'month', 'day-of-week']

  for (let i = 0; i < 5; i++) {
    const err = validateCronField(fields[i], bounds[i][0], bounds[i][1])
    if (err) return `${names[i]}: ${err}`
  }
  return null
}

// ============================================================================
// CronManager
// ============================================================================

const DURABLE_PATH = path.join(WORKDIR, '.scheduled_tasks.json')

/**
 * Cron 任务管理器
 * 对标原项目的 schedule_job / cancel_job / cron_queue / consume_cron_queue / save_durable_jobs / load_durable_jobs
 *
 * 为什么封装成类？原项目用模块级全局变量（scheduled_jobs, cron_queue, _last_fired），
 * 我们用类封装，避免全局状态污染，也和 TaskManager / BackgroundManager 保持一致的风格。
 */
export class CronManager {
  private jobs: Map<string, CronJob> = new Map() // job_id → CronJob
  private queue: CronJob[] = [] // 已触发、待交付的任务
  private lastFired: Map<string, string> = new Map() // job_id → "YYYY-MM-DD HH:MM"

  /**
   * 注册 cron 任务
   * 先 validateCron，再创建 CronJob 对象
   * 返回 CronJob（成功）或错误信息字符串（失败）——和原项目 schedule_job 一致
   */
  scheduleJob(
    cron: string,
    prompt: string,
    recurring: boolean = true,
    durable: boolean = true,
  ): CronJob | string {
    const err = validateCron(cron)
    if (err) return err

    const job: CronJob = {
      id: `cron_${Math.floor(Math.random() * 1000000)
        .toString()
        .padStart(6, '0')}`,
      cron,
      prompt,
      recurring,
      durable,
    }

    this.jobs.set(job.id, job)
    if (durable) this.saveDurable()
    return job
  }

  /** 取消 cron 任务 */
  cancelJob(jobId: string): string {
    const job = this.jobs.get(jobId)
    if (!job) return `Job ${jobId} not found`
    this.jobs.delete(jobId)
    this.lastFired.delete(jobId)
    if (job.durable) this.saveDurable()
    return `Cancelled ${jobId}`
  }

  /** 列出所有 cron 任务 */
  listJobs(): CronJob[] {
    return [...this.jobs.values()]
  }

  /**
   * 触发一个 cron 任务：入队 + 记录 lastFired
   * 由 scheduler 定时器调用，不在 agent_loop 内
   */
  fireJob(jobId: string, minuteMarker: string): void {
    const job = this.jobs.get(jobId)
    if (!job) return
    this.queue.push(job)
    this.lastFired.set(jobId, minuteMarker)

    // 一次性任务：触发后自动删除
    if (!job.recurring) {
      this.jobs.delete(jobId)
      if (job.durable) this.saveDurable()
    }
  }

  /** 获取上次触发时间（scheduler 定时器用，判断是否该触发） */
  getLastFired(jobId: string): string | undefined {
    return this.lastFired.get(jobId)
  }

  /** 消费已触发的队列（agent_loop 用，交付后清空） */
  consumeQueue(): CronJob[] {
    const fired = [...this.queue]
    this.queue.length = 0
    return fired
  }

  /** 队列是否有待交付任务（queue processor 用） */
  hasQueue(): boolean {
    return this.queue.length > 0
  }

  /** 持久化：写磁盘，只写 durable=true 的 jobs */
  saveDurable(): void {
    const durable = [...this.jobs.values()].filter((j) => j.durable)
    fs.writeFileSync(DURABLE_PATH, JSON.stringify(durable, null, 2), 'utf-8')
  }

  /** 持久化：从磁盘加载，跳过非法表达式，返回加载个数 */
  loadDurable(): number {
    if (!fs.existsSync(DURABLE_PATH)) return 0
    try {
      const data = JSON.parse(fs.readFileSync(DURABLE_PATH, 'utf-8'))
      let count = 0
      for (const j of data) {
        const job: CronJob = {
          id: j.id,
          cron: j.cron,
          prompt: j.prompt,
          recurring: j.recurring,
          durable: j.durable,
        }
        const err = validateCron(job.cron)
        if (err) {
          console.log(`  \x1b[31m[cron] skipping invalid job ${job.id}: ${err}\x1b[0m`)
          continue
        }
        this.jobs.set(job.id, job)
        count++
      }
      if (count > 0) console.log(`  \x1b[35m[cron] loaded ${count} durable job(s)\x1b[0m`)
      return count
    } catch {
      return 0
    }
  }
}

// ============================================================================
// 工具定义
// ============================================================================

export const CRON_TOOLS: ToolDefinition[] = [
  {
    name: 'schedule_cron',
    description: 'Schedule a cron job. cron is 5-field: min hour dom month dow.',
    input_schema: {
      type: 'object',
      properties: {
        cron: {
          type: 'string',
          description: '5-field cron expression (e.g. "* /5 * * * *" for every 5 min)',
        },
        prompt: { type: 'string', description: 'Message to inject when fired' },
        recurring: {
          type: 'boolean',
          description: 'True=recurring (default), False=one-shot (auto-delete after fire)',
        },
        durable: {
          type: 'boolean',
          description: 'True=persist to disk (default), False=session-only',
        },
      },
      required: ['cron', 'prompt'],
    },
  },
  {
    name: 'list_crons',
    description: 'List all registered cron jobs.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'cancel_cron',
    description: 'Cancel a cron job by ID.',
    input_schema: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'The cron job ID to cancel' },
      },
      required: ['job_id'],
    },
  },
]

// ============================================================================
// 工具 handlers
// ============================================================================

/** 工厂函数：创建 cron 工具的 handlers，和 createTaskHandlers 模式一致 */
export function createCronHandlers(cronManager: CronManager): Record<string, ToolHandler> {
  return {
    schedule_cron: (input) => {
      const result = cronManager.scheduleJob(
        input.cron as string,
        input.prompt as string,
        (input.recurring as boolean) ?? true,
        (input.durable as boolean) ?? true,
      )
      // scheduleJob 返回 CronJob（成功）或 string（错误信息）
      if (typeof result === 'string') return `Error: ${result}`
      return `Scheduled ${result.id}: '${result.cron}' → ${result.prompt}`
    },

    list_crons: () => {
      const jobs = cronManager.listJobs()
      if (jobs.length === 0) return 'No cron jobs. Use schedule_cron to add one.'
      return jobs
        .map((j) => {
          const tag = j.recurring ? 'recurring' : 'one-shot'
          const dur = j.durable ? 'durable' : 'session'
          return `  ${j.id}: '${j.cron}' → ${j.prompt.slice(0, 40)} [${tag}, ${dur}]`
        })
        .join('\n')
    },

    cancel_cron: (input) => {
      return cronManager.cancelJob(input.job_id as string)
    },
  }
}
