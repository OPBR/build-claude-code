# 07 - Permission System

## 学习目标

- 理解权限管道的设计思想
- 实现三种权限模式
- 实现 Bash 安全验证器
- 理解 deny -> mode -> allow -> ask 的顺序

## 核心概念

### 问题背景

到了 s06，agent 已经能读文件、改文件、跑命令。问题也随之出现：

- 模型可能会写错文件
- 模型可能会执行危险命令（如 `rm -rf /`）
- 模型可能会在不该动手的时候动手

### 解决方案

> **"意图"不能直接变成"执行"，中间必须经过权限检查。**

权限系统不是"有没有权限"这样一个布尔值，而是回答：

1. 这次调用要不要直接拒绝？
2. 能不能自动放行？
3. 剩下的要不要问用户？

## 权限管道设计

```
tool_call
  |
  v
1. deny rules     -> 命中了就拒绝（优先挡掉危险）
  |
  v
2. mode check     -> 根据当前模式决定
  |
  v
3. allow rules    -> 命中了就放行
  |
  v
4. ask user       -> 剩下的交给用户确认
```

### 为什么顺序是这样？

**第 1 步先看 deny rules**：有些东西不应该交给"模式"去决定（如明显危险的命令）

**第 2 步看 mode**：模式决定当前会话的大方向（plan 模式天然更保守）

**第 3 步看 allow rules**：有些安全、重复、常见的操作可以直接过

**第 4 步才 ask**：前面都没命中的灰区，才交给用户

## 三种权限模式

| 模式      | 含义                             | 适合什么场景     |
| --------- | -------------------------------- | ---------------- |
| `default` | 未命中规则时问用户               | 日常交互         |
| `plan`    | 只允许读，不允许写               | 计划、审查、分析 |
| `auto`    | 简单安全操作自动过，危险操作再问 | 高流畅度探索     |

## Bash 安全验证器

Bash 是最危险的工具，需要单独的安全检查：

```typescript
class BashSecurityValidator {
  private validators = [
    { name: 'sudo', pattern: /\bsudo\b/ }, // 权限提升
    { name: 'rm_rf', pattern: /\brm\s+(-[a-zA-Z]*)?r/ }, // 递归删除
    { name: 'shell_metachar', pattern: /[;&|`$]/ }, // shell 元字符
    { name: 'cmd_substitution', pattern: /\$\(/ }, // 命令替换
    { name: 'ifs_injection', pattern: /\bIFS\s*=/ }, // IFS 操控
  ]

  validate(command: string): BashValidationFailure[] {
    // 返回触发的验证器列表
  }

  isSevereFailure(failure: BashValidationFailure): boolean {
    // sudo 和 rm_rf 是严重级别，直接 deny
    return failure.name === 'sudo' || failure.name === 'rm_rf'
  }
}
```

## 关键数据结构

### 权限规则

```typescript
interface PermissionRule {
  tool: string // 工具名或 "*"
  behavior: 'allow' | 'deny' | 'ask'
  path?: string // 路径 glob 模式
  content?: string // 内容 glob 模式（用于 bash）
}
```

### 权限模式

```typescript
type PermissionMode = 'default' | 'plan' | 'auto'
```

### 权限决策结果

```typescript
interface PermissionDecision {
  behavior: 'allow' | 'deny' | 'ask'
  reason: string
}
```

## 核心实现

### PermissionManager.check()

```typescript
check(toolName: string, toolInput: Record<string, unknown>): PermissionDecision {
  // Step 0: Bash 安全验证（在 deny rules 之前）
  if (toolName === 'bash') {
    const command = toolInput.command ?? ''
    const failures = this.bashValidator.validate(command)

    if (failures.length > 0) {
      const severeFailures = failures.filter(f => this.bashValidator.isSevereFailure(f))
      if (severeFailures.length > 0) {
        return { behavior: 'deny', reason: `Bash validator: ...` }
      }
      return { behavior: 'ask', reason: `Bash validator flagged: ...` }
    }
  }

  // Step 1: Deny rules
  for (const rule of this.rules) {
    if (rule.behavior !== 'deny') continue
    if (this.matchesRule(rule, toolName, toolInput)) {
      return { behavior: 'deny', reason: `Blocked by deny rule: ...` }
    }
  }

  // Step 2: Mode check
  if (this.mode === 'plan') {
    if (WRITE_TOOLS.includes(toolName)) {
      return { behavior: 'deny', reason: 'Plan mode: write operations blocked' }
    }
    return { behavior: 'allow', reason: 'Plan mode: read-only allowed' }
  }

  if (this.mode === 'auto') {
    if (READ_ONLY_TOOLS.includes(toolName)) {
      return { behavior: 'allow', reason: 'Auto mode: read-only auto-approved' }
    }
  }

  // Step 3: Allow rules
  for (const rule of this.rules) {
    if (rule.behavior !== 'allow') continue
    if (this.matchesRule(rule, toolName, toolInput)) {
      return { behavior: 'allow', reason: `Matched allow rule: ...` }
    }
  }

  // Step 4: Ask user
  return { behavior: 'ask', reason: `No rule matched, asking user` }
}
```

### 主循环集成

```typescript
for (const block of response.content) {
  if (block.type !== 'tool_use') continue

  // --- 权限检查 ---
  const decision = perms.check(block.name, block.input)

  if (decision.behavior === 'deny') {
    output = `Permission denied: ${decision.reason}`
  } else if (decision.behavior === 'ask') {
    const answer = await askUser('Allow? (y/n/always): ')
    if (answer === 'always') {
      perms.rules.push({ tool: block.name, path: '*', behavior: 'allow' })
      output = await executeTool(block)
    } else if (answer === 'y') {
      output = await executeTool(block)
    } else {
      output = `Permission denied by user`
    }
  } else {
    output = await executeTool(block)
  }

  results.push({ type: 'tool_result', tool_use_id: block.id, content: output })
}
```

## REPL 增强功能

```typescript
// /mode 命令切换模式
if (query.startsWith('/mode')) {
  perms.mode = newMode
}

// /rules 命令查看当前规则
if (query === '/rules') {
  console.log(perms.rules)
}

// /validators 命令查看 Bash 验证器
if (query === '/validators') {
  console.log('Bash validators: sudo, rm_rf, shell_metachar, cmd_substitution, ifs_injection')
}
```

## 运行测试

```bash
pnpm s07
```

测试场景：

1. **测试 deny 规则**：尝试执行 `sudo ls`，应该被直接拒绝
2. **测试 plan 模式**：切换到 plan 模式，尝试写文件，应该被拒绝
3. **测试 auto 模式**：切换到 auto 模式，读取文件应该自动通过
4. **测试用户确认**：在 default 模式下执行普通 bash 命令，应该询问用户

## 关键点提醒

1. **Bash 不是普通文本**：它是可执行动作描述，需要单独的安全检查
2. **模式切换要动态**：运行时可以通过 `/mode` 命令切换
3. **连续拒绝计数**：如果 agent 连续多次被拒绝，应该提示用户考虑切到 plan 模式
4. **"always" 支持**：用户可以选择永久允许某个工具，自动添加 allow 规则

## 学完这章后，你应该能回答

- 为什么权限系统不是一个简单开关？
- 为什么 deny 要先于 allow？
- 为什么要先做 3 个模式，而不是一上来做很复杂？
- 为什么 Bash 要被特殊对待？

---

**一句话记住：权限系统不是为了让 agent 更笨，而是为了让 agent 的行动先经过一道可靠的安全判断。**
