/**
 * s08 Hook System
 * 钩子系统 - 在固定时机插入额外行为
 *
 * 核心概念：
 * - 主循环只暴露"时机"（SessionStart、PreToolUse、PostToolUse）
 * - Hook 可以执行任何 shell 命令
 * - 退出码约定：0=继续，1=阻止，2=注入消息
 */

import { execSync } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import * as path from 'path'
import { HookEvent, HookDefinition, HookContext, HookResult } from '../core/types'

// ============================================================================
// Hook 退出码枚举
// ============================================================================

/**
 * Hook 命令的退出码约定
 *
 * 用户脚本通过退出码告诉系统要做什么：
 * - Continue：继续执行，什么都不做
 * - Block：阻止工具执行
 * - InjectMessage：继续执行，但注入消息给模型
 */
export enum HookExitCode {
  /** 退出码 0：继续执行 */
  Continue = 0,
  /** 退出码 1：阻止执行 */
  Block = 1,
  /** 退出码 2：注入消息 */
  InjectMessage = 2,
}

// ============================================================================
// 内部类型
// ============================================================================

/** 单个 Hook 执行的返回结果（内部使用） */
interface HookExecutionResult {
  exitCode: HookExitCode // 退出码（枚举）
  stdout: string // 正常输出
  stderr: string // 错误输出（注入消息从这里取）
}

// ============================================================================
// 配置
// ============================================================================

/** 工作目录 */
const WORKDIR = process.cwd()

/** Hook 配置文件路径 */
const DEFAULT_CONFIG_PATH = path.join(WORKDIR, '.hooks.json')

/** Hook 执行超时时间（秒） */
const HOOK_TIMEOUT = 30

/** 工作区信任标记文件 */
const TRUST_MARKER = path.join(WORKDIR, '.claude', '.claude_trusted')

// ============================================================================
// HookManager 类
// ============================================================================

/**
 * Hook 管理器
 *
 * 负责三件事：
 * 1. 加载配置 - 从 .hooks.json 读取 Hook 定义
 * 2. 执行 Hook - 运行 shell 命令
 * 3. 返回结果 - 告诉主循环是否阻止、是否注入消息
 */
export class HookManager {
  /** 存储所有 Hook 配置，按事件分类 */
  hooks: Record<HookEvent, HookDefinition[]>

  /** 是否为 SDK 模式（SDK 模式下信任是隐式的） */
  private sdkMode: boolean

  /**
   * 构造函数
   *
   * @param configPath 配置文件路径，默认为 .hooks.json
   * @param sdkMode 是否为 SDK 模式
   */
  constructor(configPath?: string, sdkMode: boolean = false) {
    // 初始化空的 Hook 存储
    this.hooks = {
      SessionStart: [],
      PreToolUse: [],
      PostToolUse: [],
    }
    this.sdkMode = sdkMode

    // 加载配置文件
    this.loadConfig(configPath || DEFAULT_CONFIG_PATH)
  }

  /**
   * 加载 Hook 配置
   *
   * 从 .hooks.json 读取配置，按事件分类存储
   */
  private loadConfig(configPath: string): void {
    if (!existsSync(configPath)) {
      // 配置文件不存在，使用空配置
      return
    }

    try {
      const content = readFileSync(configPath, 'utf-8')
      const config = JSON.parse(content)

      // 从 config.hooks 中读取各事件的 Hook
      const hooksConfig = config.hooks || {}
      for (const event of ['SessionStart', 'PreToolUse', 'PostToolUse'] as HookEvent[]) {
        if (Array.isArray(hooksConfig[event])) {
          this.hooks[event] = hooksConfig[event]
        }
      }

      console.log(`[Hooks loaded from ${configPath}]`)
    } catch (error) {
      console.log(`[Hook config error: ${error}]`)
    }
  }

  /**
   * 检查工作区是否被信任
   *
   * 安全机制：不信任的工作区不会执行 Hook
   * 防止恶意项目利用 Hook 执行危险命令
   */
  private checkWorkspaceTrust(): boolean {
    // SDK 模式下信任是隐式的
    if (this.sdkMode) {
      return true
    }
    // 检查信任标记文件是否存在
    return existsSync(TRUST_MARKER)
  }

  /**
   * 检查 matcher 是否匹配工具名
   *
   * @param matcher 匹配规则，如 "bash"、"write_file"、"*" 等
   * @param toolName 工具名
   * @returns 是否匹配
   */
  private matches(matcher: string | undefined, toolName: string): boolean {
    // matcher 为空或 "*" 表示匹配所有工具
    if (!matcher || matcher === '*') {
      return true
    }
    // 精确匹配
    return matcher === toolName
  }

  /**
   * 执行某个事件的所有 Hook
   *
   * 这是核心方法，主循环会调用它
   *
   * @param event 事件名（SessionStart、PreToolUse、PostToolUse）
   * @param context 当时的上下文（工具名、输入、输出）
   * @returns HookResult：是否阻止、是否注入消息
   */
  runHooks(event: HookEvent, context: HookContext): HookResult {
    // 初始化结果
    const result: HookResult = {
      blocked: false,
      messages: [],
    }

    // 信任检查：不信任的工作区不执行 Hook
    if (!this.checkWorkspaceTrust()) {
      return result
    }

    // 获取该事件的所有 Hook
    const hooks = this.hooks[event] || []

    // 遍历每个 Hook
    for (const hook of hooks) {
      // 1. 检查 matcher 是否匹配
      if (!this.matches(hook.matcher, context.tool_name)) {
        // 不匹配，跳过这个 Hook
        continue
      }

      // 2. 执行 Hook 命令（现在返回完整信息）
      const hookExecResult = this.executeHook(hook, context, event)

      // 3. 根据退出码处理结果
      if (hookExecResult.exitCode === HookExitCode.Continue) {
        // 退出码 0：继续（什么都不做）
        continue
      } else if (hookExecResult.exitCode === HookExitCode.Block) {
        // 退出码 1：阻止
        result.blocked = true
        // blockReason 从 stderr 获取
        result.blockReason = hookExecResult.stderr.trim() || 'Blocked by hook'
        console.log(`  [hook:${event}] BLOCKED: ${result.blockReason}`)
        // 一旦阻止，不再执行后续 Hook
        break
      } else if (hookExecResult.exitCode === HookExitCode.InjectMessage) {
        // 退出码 2：注入消息
        // 消息内容从 stderr 获取
        const message = hookExecResult.stderr.trim()
        if (message) {
          result.messages.push(message)
          console.log(`  [hook:${event}] INJECT: ${message.slice(0, 200)}`)
        }
      }
    }

    return result
  }

  /**
   * 执行单个 Hook 命令
   *
   * @param hook Hook 定义
   * @param context 执行上下文
   * @param event 当前事件名
   * @returns HookExecutionResult：退出码 + stdout + stderr
   */
  private executeHook(
    hook: HookDefinition,
    context: HookContext,
    event: HookEvent,
  ): HookExecutionResult {
    // 构建环境变量，把上下文传给 Hook
    // 使用 Record 类型，允许动态添加属性
    const env: Record<string, string | undefined> = {
      ...process.env,
      HOOK_EVENT: event, // 当前事件名
      HOOK_TOOL_NAME: context.tool_name,
      HOOK_TOOL_INPUT: JSON.stringify(context.tool_input),
    }

    // PostToolUse 时还要传递输出
    if (context.tool_output) {
      env.HOOK_TOOL_OUTPUT = context.tool_output
    }

    try {
      // 执行 shell 命令
      const output = execSync(hook.command, {
        cwd: WORKDIR,
        env: env,
        encoding: 'utf-8',
        timeout: HOOK_TIMEOUT * 1000,
        stdio: ['pipe', 'pipe', 'pipe'], // 捕获 stdout 和 stderr
      })

      // 命令成功执行，退出码为 0
      // 注意：execSync 成功时只返回 stdout，stderr 需要另外获取
      if (output.trim()) {
        console.log(`  [hook] ${output.trim().slice(0, 100)}`)
      }

      return {
        exitCode: HookExitCode.Continue,
        stdout: output,
        stderr: '',
      }
    } catch (error: unknown) {
      // 命令执行失败（退出码非 0）
      const execError = error as {
        status?: number
        stdout?: string
        stderr?: string
        message?: string
      }

      // 获取原始退出码（shell 返回的数字）
      const rawExitCode = execError.status || 1

      // 转换为枚举：只有 2 是注入消息，其他非零值都是阻止
      const exitCode: HookExitCode =
        rawExitCode === 2 ? HookExitCode.InjectMessage : HookExitCode.Block

      // 获取 stdout 和 stderr
      const stdout = execError.stdout || ''
      const stderr = execError.stderr || ''

      // 打印日志
      if (stdout.trim()) {
        console.log(`  [hook stdout] ${stdout.trim().slice(0, 100)}`)
      }
      if (stderr.trim()) {
        console.log(`  [hook stderr] ${stderr.trim().slice(0, 200)}`)
      }

      return {
        exitCode,
        stdout,
        stderr,
      }
    }
  }
}
