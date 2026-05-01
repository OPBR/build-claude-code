# 08 - Hook System

## 学习目标

- 理解 Hook 系统的设计思想（扩展点 vs 硬编码）
- 实现三种 Hook 事件：SessionStart、PreToolUse、PostToolUse
- 理解统一退出码约定：0=继续，1=阻止，2=注入消息
- 理解 Matcher 匹配机制
- 理解工作区信任检查

## 核心概念

### 问题背景

到了 s07，权限系统解决了"能不能执行"的问题。但还有很多需求不属于权限这条线：

- 写文件后自动 prettier 格式化
- 每次执行 bash 后记录审计日志
- 会话开始时打印项目状态
- 写完代码后自动运行测试

如果每增加一个需求，都去修改主循环，主循环就会越来越重。

### 解决方案

> **"主循环只暴露时机，真正的附加行为交给 Hook。"**

Hook 系统就像插座：

- 主循环 = 墙上的插座（暴露固定的接入点）
- Hook = 插头（插入插座，获得电力）
- 你 = 可以插任何设备（Hook 可以是任何命令）

## Hook vs Permission 的边界

| 系统       | 解决什么           | 返回什么              |
| ---------- | ------------------ | --------------------- |
| Permission | 能不能执行         | allow/deny/ask        |
| Hook       | 执行前后还能做什么 | continue/block/inject |

一句话区分：

> Permission 决定"能不能"，Hook 决定"执行前后还能不能插入额外逻辑"。

## 三种 Hook 事件

```
SessionStart（会话开始）
    ↓
┌─────────────────────────────┐
│  REPL 循环                  │
│                             │
│  用户输入                   │
│      ↓                      │
│  PreToolUse（工具执行前）   │
│      ↓                      │
│  执行工具                   │
│      ↓                      │
│  PostToolUse（工具执行后）  │
│      ↓                      │
│  返回结果                   │
│      ↓                      │
│  循环继续...                │
└─────────────────────────────┘
```

| 事件           | 触发时机   | 能做什么                 |
| -------------- | ---------- | ------------------------ |
| `SessionStart` | 会话开始时 | 打印欢迎信息、初始化环境 |
| `PreToolUse`   | 工具执行前 | 检查、拦截、修改输入     |
| `PostToolUse`  | 工具执行后 | 日志、通知、追加输出     |

## 统一退出码约定

Hook 通过退出码告诉系统要做什么：

| 退出码 | 含义          | 主循环行为                       |
| ------ | ------------- | -------------------------------- |
| `0`    | Continue      | 正常执行工具                     |
| `1`    | Block         | 不执行工具，返回阻止原因         |
| `2`    | InjectMessage | 继续执行，但先注入一条消息给模型 |

### 用枚举语义化

```typescript
export enum HookExitCode {
  /** 退出码 0：继续执行 */
  Continue = 0,
  /** 退出码 1：阻止执行 */
  Block = 1,
  /** 退出码 2：注入消息 */
  InjectMessage = 2,
}
```

### 为什么注入消息用 stderr？

约定：

- **stdout**：调试日志，给人看的
- **stderr**：注入消息，给模型看的

stdout 可能有很多调试输出，不希望全部塞给模型。stderr 更干净，专门传递重要信息。

## Matcher 匹配机制

Hook 可以只对特定工具生效：

| matcher 值     | 匹配规则             |
| -------------- | -------------------- |
| `"*"` 或省略   | 所有工具都触发       |
| `"bash"`       | 只对 bash 工具触发   |
| `"write_file"` | 只对 write_file 触发 |

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "bash",
        "command": "echo 'Bash will execute' && exit 0"
      }
    ]
  }
}
```

## Hook 上下文传递

Hook 通过环境变量获取当前信息：

| 环境变量           | 内容                    | 示例                  |
| ------------------ | ----------------------- | --------------------- |
| `HOOK_EVENT`       | 事件名                  | `PreToolUse`          |
| `HOOK_TOOL_NAME`   | 工具名                  | `write_file`          |
| `HOOK_TOOL_INPUT`  | 工具输入（JSON）        | `{"path": "test.ts"}` |
| `HOOK_TOOL_OUTPUT` | 工具输出（PostToolUse） | `"Wrote 100 bytes"`   |

## 关键数据结构

### HookDefinition - 单个 Hook 定义

```typescript
interface HookDefinition {
  matcher?: string // 工具名匹配，"*" 或省略表示所有
  command: string // 要执行的 shell 命令
}
```

### HookContext - Hook 执行时的上下文

```typescript
interface HookContext {
  tool_name: string // 工具名
  tool_input: Record<string, unknown> // 工具输入参数
  tool_output?: string // 工具输出（PostToolUse 才有）
}
```

注意：`tool_output` 是可选的，只有 PostToolUse 才有。因为 PreToolUse 在执行前，还没有输出。

### HookResult - Hook 执行后的结果

```typescript
interface HookResult {
  blocked: boolean // 是否阻止工具执行
  blockReason?: string // 阻止的原因
  messages: string[] // 要注入给模型的消息
}
```

## 核心实现

### HookManager.runHooks()

```typescript
runHooks(event: HookEvent, context: HookContext): HookResult {
  const result: HookResult = {
    blocked: false,
    messages: [],
  }

  // 信任检查
  if (!this.checkWorkspaceTrust()) {
    return result
  }

  const hooks = this.hooks[event] || []

  for (const hook of hooks) {
    // 1. 检查 matcher
    if (!this.matches(hook.matcher, context.tool_name)) {
      continue
    }

    // 2. 执行 Hook 命令
    const execResult = this.executeHook(hook, context, event)

    // 3. 根据退出码处理
    if (execResult.exitCode === HookExitCode.Continue) {
      continue
    } else if (execResult.exitCode === HookExitCode.Block) {
      result.blocked = true
      result.blockReason = execResult.stderr.trim() || 'Blocked by hook'
      break
    } else if (execResult.exitCode === HookExitCode.InjectMessage) {
      const message = execResult.stderr.trim()
      if (message) {
        result.messages.push(message)
      }
    }
  }

  return result
}
```

### executeHook() - 环境变量传递

```typescript
private executeHook(hook: HookDefinition, context: HookContext, event: HookEvent) {
  const env = {
    ...process.env,
    HOOK_EVENT: event,
    HOOK_TOOL_NAME: context.tool_name,
    HOOK_TOOL_INPUT: JSON.stringify(context.tool_input),
  }

  if (context.tool_output) {
    env.HOOK_TOOL_OUTPUT = context.tool_output
  }

  // 执行 shell 命令
  const output = execSync(hook.command, {
    cwd: WORKDIR,
    env: env,
    stdio: ['pipe', 'pipe', 'pipe'],  // 捕获 stdout 和 stderr
  })

  // ...
}
```

### stdio: ['pipe', 'pipe', 'pipe'] 解释

```text
stdio[0] = 'pipe'  → stdin（标准输入）
stdio[1] = 'pipe'  → stdout（标准输出）
stdio[2] = 'pipe'  → stderr（标准错误）
```

三个都 pipe 才能捕获 stdout（调试日志）和 stderr（注入消息）。

## 主循环集成

### SessionStart Hook

```typescript
async function main() {
  const hooks = new HookManager()

  // SessionStart 在 REPL 循环之前，只执行一次
  hooks.runHooks('SessionStart', { tool_name: '', tool_input: {} })

  // ... REPL 循环 ...
}
```

### PreToolUse + PostToolUse Hook

```typescript
for (const block of response.content) {
  if (block.type !== 'tool_use') continue

  const hookContext = {
    tool_name: block.name,
    tool_input: block.input,
  }

  // PreToolUse Hook
  const preResult = hooks.runHooks('PreToolUse', hookContext)

  // 处理注入的消息
  for (const msg of preResult.messages) {
    results.push({ type: 'tool_result', content: `[Hook message]: ${msg}` })
  }

  // 检查是否被阻止
  if (preResult.blocked) {
    results.push({ type: 'tool_result', content: `Blocked: ${preResult.blockReason}` })
    continue // 不执行工具
  }

  // 执行工具
  let output = await executeTool(block.name, block.input)

  // PostToolUse Hook
  hookContext.tool_output = output
  const postResult = hooks.runHooks('PostToolUse', hookContext)

  // 追加 Hook 消息到输出
  for (const msg of postResult.messages) {
    output += `\n[Hook note]: ${msg}`
  }

  results.push({ type: 'tool_result', content: output })
}
```

## 配置文件示例

`.hooks.json`：

```json
{
  "hooks": {
    "SessionStart": [
      {
        "command": "echo 'Welcome!' >&2 && exit 2"
      }
    ],
    "PreToolUse": [
      {
        "matcher": "bash",
        "command": "echo 'Bash will execute...' && exit 0"
      }
    ],
    "PostToolUse": [
      {
        "matcher": "write_file",
        "command": "path=$(echo \"$HOOK_TOOL_INPUT\" | jq -r '.path') && prettier --write \"$path\""
      }
    ]
  }
}
```

## 工作区信任检查

Hook 可以执行任何 shell 命令，存在安全风险。信任检查确保只有主动标记为信任的项目才会执行 Hook：

```typescript
const TRUST_MARKER = '.claude/.claude_trusted'

private checkWorkspaceTrust(): boolean {
  if (this.sdkMode) return true
  return existsSync(TRUST_MARKER)
}
```

如果 `.claude/.claude_trusted` 文件不存在，Hook 不会执行（安全默认）。

## REPL 增强功能

```typescript
// /hooks 命令查看当前配置
if (query === '/hooks') {
  console.log('SessionStart:', hooks.hooks.SessionStart.length, 'hooks')
  console.log('PreToolUse:', hooks.hooks.PreToolUse.length, 'hooks')
  console.log('PostToolUse:', hooks.hooks.PostToolUse.length, 'hooks')
}

// /help 命令
if (query === '/help') {
  console.log('/hooks - Show hook configuration')
  console.log('/help - Show help')
  console.log('q/exit - Exit')
}
```

## 运行测试

```bash
pnpm s08
```

测试场景：

1. **测试 SessionStart**：启动后应该看到欢迎消息
2. **测试 /hooks 命令**：输入 `/hooks` 查看配置详情
3. **测试 PreToolUse**：让模型执行 bash，应该看到前置提示
4. **测试 PostToolUse**：让模型写文件，应该看到后置提示

## 实战示例

### 自动格式化

写文件后自动 prettier：

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "write_file",
        "command": "path=$(echo \"$HOOK_TOOL_INPUT\" | jq -r '.path') && prettier --write \"$path\""
      }
    ]
  }
}
```

### 阻止写 .env 文件

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "write_file",
        "command": "path=$(echo \"$HOOK_TOOL_INPUT\" | jq -r '.path') && if [[ \"$path\" =~ \\.env$ ]]; then echo 'Cannot write .env' >&2 && exit 1; fi"
      }
    ]
  }
}
```

## 关键点提醒

1. **Hook 不是权限**：它解决的是"执行前后还能做什么"，不是"能不能执行"
2. **退出码是约定**：0/1/2 三种值，简单清晰，任何 shell 脚本都能遵循
3. **stderr 用于注入**：stdout 是日志，stderr 是消息，区分清楚
4. **matcher 精准控制**：Hook 可以只对特定工具生效，不干扰其他工具
5. **信任检查保安全**：陌生项目的 Hook 不会执行，防止恶意利用

## 学完这章后，你应该能回答

- Hook 和 Permission 有什么区别？
- 为什么需要统一退出码约定？
- PreToolUse 和 PostToolUse 分别能做什么？
- Matcher 是什么，有什么用？
- 为什么注入消息用 stderr 而不是 stdout？
- 为什么需要工作区信任检查？

---

**一句话记住：扩展的核心是"找时机"，不是"改代码"。主循环只暴露时机，真正的附加行为交给 Hook。**
