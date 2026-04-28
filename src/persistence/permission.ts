/**
 * s07 Permission System
 * 权限系统 - 工具执行前的安全检查管道
 *
 * 核心管道: deny_rules -> mode_check -> allow_rules -> ask_user
 */

import {
  PermissionMode,
  PermissionRule,
  PermissionDecision,
  BashValidationFailure,
} from '../core/types'

// ============================================================================
// 工具分类
// ============================================================================

/** 只读工具（不会修改状态） */
const READ_ONLY_TOOLS = ['read_file', 'glob', 'grep']

/** 写入工具（会修改状态） */
const WRITE_TOOLS = ['write_file', 'edit_file', 'bash']

// ============================================================================
// Bash 安全验证器
// ============================================================================

/**
 * Bash 命令安全验证器
 *
 * Bash 是最危险的工具，需要单独的安全检查
 * 检查明显危险的模式：sudo, rm -rf, shell 元字符等
 */
export class BashSecurityValidator {
  private validators: Array<{ name: string; pattern: RegExp }> = [
    { name: 'sudo', pattern: /\bsudo\b/ }, // 权限提升
    { name: 'rm_rf', pattern: /\brm\s+(-[a-zA-Z]*)?r/ }, // 递归删除
    { name: 'shell_metachar', pattern: /[;&|`$]/ }, // shell 元字符
    { name: 'cmd_substitution', pattern: /\$\(|`[^`]*`/ }, // 命令替换
    { name: 'ifs_injection', pattern: /\bIFS\s*=/ }, // IFS 操控
  ]

  /**
   * 验证 Bash 命令，返回触发的验证器列表
   */
  validate(command: string): BashValidationFailure[] {
    const failures: BashValidationFailure[] = []
    for (const { name, pattern } of this.validators) {
      if (pattern.test(command)) {
        failures.push({ name, pattern: pattern.source })
      }
    }
    return failures
  }

  /**
   * 是否通过所有验证（无失败）
   */
  isSafe(command: string): boolean {
    return this.validate(command).length === 0
  }

  /**
   * 描述验证失败的原因
   */
  describeFailures(command: string): string {
    const failures = this.validate(command)
    if (failures.length === 0) {
      return 'No issues detected'
    }
    const parts = failures.map((f) => `${f.name} (pattern: ${f.pattern})`)
    return 'Security flags: ' + parts.join(', ')
  }

  /**
   * 判断失败是否为严重级别（需要直接 deny）
   */
  isSevereFailure(failure: BashValidationFailure): boolean {
    return failure.name === 'sudo' || failure.name === 'rm_rf'
  }
}

// ============================================================================
// 默认规则
// ============================================================================

/** 默认权限规则 */
const DEFAULT_RULES: PermissionRule[] = [
  // 永久拒绝危险模式
  { tool: 'bash', content: 'rm -rf /', behavior: 'deny' },
  { tool: 'bash', content: 'sudo *', behavior: 'deny' },
  // 允许读取任何文件
  { tool: 'read_file', path: '*', behavior: 'allow' },
]

// ============================================================================
// 权限管理器
// ============================================================================

/**
 * 权限管理器
 *
 * 核心管道：
 * 1. deny rules  -> 命中了就拒绝（优先挡掉危险）
 * 2. mode check  -> 根据当前模式决定
 * 3. allow rules -> 命中了就放行
 * 4. ask user    -> 剩下的交给用户确认
 */
export class PermissionManager {
  mode: PermissionMode
  rules: PermissionRule[]
  consecutiveDenials: number = 0
  maxConsecutiveDenials: number = 3

  private bashValidator: BashSecurityValidator

  constructor(mode: PermissionMode = 'default', rules?: PermissionRule[]) {
    if (!['default', 'plan', 'auto'].includes(mode)) {
      throw new Error(`Unknown mode: ${mode}. Choose from default, plan, auto`)
    }
    this.mode = mode
    this.rules = rules ?? [...DEFAULT_RULES]
    this.bashValidator = new BashSecurityValidator()
  }

  /**
   * 检查权限
   *
   * 返回决策结果: { behavior, reason }
   */
  check(toolName: string, toolInput: Record<string, unknown>): PermissionDecision {
    // Step 0: Bash 安全验证（在 deny rules 之前）
    if (toolName === 'bash') {
      const command = (toolInput.command as string) ?? ''
      const failures = this.bashValidator.validate(command)

      if (failures.length > 0) {
        // 严重模式直接 deny
        const severeFailures = failures.filter((f) => this.bashValidator.isSevereFailure(f))
        if (severeFailures.length > 0) {
          const desc = this.bashValidator.describeFailures(command)
          return { behavior: 'deny', reason: `Bash validator: ${desc}` }
        }
        // 其他模式 escalate to ask
        const desc = this.bashValidator.describeFailures(command)
        return { behavior: 'ask', reason: `Bash validator flagged: ${desc}` }
      }
    }

    // Step 1: Deny rules（永久阻止，优先级最高）
    for (const rule of this.rules) {
      if (rule.behavior !== 'deny') continue
      if (this.matchesRule(rule, toolName, toolInput)) {
        return { behavior: 'deny', reason: `Blocked by deny rule: ${JSON.stringify(rule)}` }
      }
    }

    // Step 2: Mode check（根据当前模式决定）
    if (this.mode === 'plan') {
      // Plan 模式：拒绝所有写操作，允许读操作
      if (WRITE_TOOLS.includes(toolName)) {
        return { behavior: 'deny', reason: 'Plan mode: write operations are blocked' }
      }
      return { behavior: 'allow', reason: 'Plan mode: read-only allowed' }
    }

    if (this.mode === 'auto') {
      // Auto 模式：自动允许只读工具，写入操作需要 ask
      if (READ_ONLY_TOOLS.includes(toolName)) {
        return { behavior: 'allow', reason: 'Auto mode: read-only tool auto-approved' }
      }
      // 继续到 allow rules
    }

    // Step 3: Allow rules
    for (const rule of this.rules) {
      if (rule.behavior !== 'allow') continue
      if (this.matchesRule(rule, toolName, toolInput)) {
        this.consecutiveDenials = 0
        return { behavior: 'allow', reason: `Matched allow rule: ${JSON.stringify(rule)}` }
      }
    }

    // Step 4: Ask user（未命中规则的灰区）
    return { behavior: 'ask', reason: `No rule matched for ${toolName}, asking user` }
  }

  /**
   * 用户交互确认
   *
   * 支持: y (允许), n (拒绝), always (永久允许)
   */
  async askUser(toolName: string, toolInput: Record<string, unknown>): Promise<boolean> {
    const preview = JSON.stringify(toolInput).slice(0, 200)
    console.log(`\n  [Permission] ${toolName}: ${preview}`)

    // 在 REPL 中需要用户提供输入
    // 这里返回一个 Promise，由外部 REPL 处理用户输入
    return new Promise((resolve) => {
      // 标记需要用户输入，由 REPL 层处理
      this.pendingAsk = { toolName, toolInput, resolve }
    })
  }

  /** 待处理的用户确认请求 */
  pendingAsk?: {
    toolName: string
    toolInput: Record<string, unknown>
    resolve: (approved: boolean) => void
  }

  /**
   * 处理用户对权限请求的响应
   */
  handleUserResponse(response: string): void {
    if (!this.pendingAsk) return

    const { resolve } = this.pendingAsk

    if (response === 'always') {
      // 添加永久允许规则
      this.rules.push({
        tool: this.pendingAsk.toolName,
        path: '*',
        behavior: 'allow',
      })
      this.consecutiveDenials = 0
      resolve(true)
    } else if (response === 'y' || response === 'yes') {
      this.consecutiveDenials = 0
      resolve(true)
    } else {
      // 拒绝
      this.consecutiveDenials++
      if (this.consecutiveDenials >= this.maxConsecutiveDenials) {
        console.log(
          `  [${this.consecutiveDenials} consecutive denials -- consider switching to plan mode]`,
        )
      }
      resolve(false)
    }

    this.pendingAsk = undefined
  }

  /**
   * 规则匹配检查
   */
  private matchesRule(
    rule: PermissionRule,
    toolName: string,
    toolInput: Record<string, unknown>,
  ): boolean {
    // 工具名匹配
    if (rule.tool && rule.tool !== '*') {
      if (rule.tool !== toolName) return false
    }

    // 路径模式匹配（使用简单的 glob 匹配）
    if (rule.path && rule.path !== '*') {
      const path = (toolInput.path as string) ?? ''
      if (!this.globMatch(path, rule.path)) return false
    }

    // 内容模式匹配（用于 bash 命令）
    if (rule.content) {
      const command = (toolInput.command as string) ?? ''
      if (!this.globMatch(command, rule.content)) return false
    }

    return true
  }

  /**
   * 简单的 glob 模式匹配
   *
   * 支持: * (任意字符), ? (单个字符)
   */
  private globMatch(str: string, pattern: string): boolean {
    // 将 glob 模式转换为正则表达式
    const regexPattern = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&') // 转义特殊字符
      .replace(/\*/g, '.*') // * -> .*
      .replace(/\?/g, '.') // ? -> .

    return new RegExp(`^${regexPattern}$`).test(str)
  }
}
