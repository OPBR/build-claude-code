# 00 - 项目初始化

## 学习目标

- 理解项目架构和目录结构
- 配置开发环境
- 理解核心模式

## 项目架构概览

```
build-claude-code/
├── src/                    # 源代码
│   ├── core/               # 核心模块 (s01-s02)
│   ├── planning/           # 计划模块 (s03-s05)
│   ├── persistence/        # 持久化模块 (s06-s14)
│   │   ├── compact.ts      # s06: 上下文压缩
│   │   ├── permission.ts   # s07: 权限系统
│   │   ├── hook.ts         # s08: Hook 系统
│   │   ├── memory.ts       # s09: 记忆系统
│   │   ├── prompt.ts       # s10: 系统提示词
│   │   ├── recovery.ts     # s11: 错误恢复
│   │   ├── task-manager.ts # s12: 任务系统
│   │   ├── background.ts   # s13: 后台任务
│   │   └── cron.ts         # s14: 定时调度
│   ├── team/               # 团队模块 (s15-s18)
│   ├── plugin/             # 插件模块 (s19)
│   ├── full/               # 综合实现
│   ├── sessions/           # 各 session 入口
│   └── cli/                # REPL 界面
├── learn/                  # 学习笔记
│   └── output/             # 输出文件
├── skills/                 # 技能文件
├── .memory/                # 记忆存储 (运行时)
└── 运行时目录...
```

## 学习路线概览

| 阶段 | Session | 主题               | 核心概念                           |
| ---- | ------- | ------------------ | ---------------------------------- |
| 1    | s01     | Agent Loop         | 一个循环 + Bash = Agent            |
| 1    | s02     | Tool Use           | 添加工具 = 添加一个 handler        |
| 2    | s03     | TodoWrite          | 没有计划的代理会迷失方向           |
| 2    | s04     | Subagent           | 大任务拆分，子任务获得干净的上下文 |
| 2    | s05     | Skills             | 按需加载知识，不要 upfront         |
| 3    | s06     | Context Compact    | 三层压缩策略实现无限会话           |
| 3    | s07     | Permission System  | 工具执行前的安全检查管道           |
| 3    | s08     | Hook System        | 不改主循环也能在固定时机插入行为   |
| 4    | s09     | Memory System      | 跨会话保存有价值的信息             |
| 4    | s10     | System Prompt      | 动态组装系统提示词                 |
| 4    | s11     | Error Recovery     | 错误分类 + 恢复路径                |
| 5    | s12     | Task System        | 文件持久化任务板 + 依赖图          |
| 5    | s13     | Background Tasks   | 后台执行 + 通知队列                |
| 5    | s14     | Cron Scheduler     | 定时任务调度                       |
| 6    | s15     | Agent Teams        | JSONL 邮箱通信的多代理             |
| 6    | s16     | Team Protocols     | 关闭/审批协议                      |
| 6    | s17     | Autonomous Agents  | 代理自动发现任务                   |
| 6    | s18     | Worktree Isolation | 目录级隔离执行                     |
| 7    | s19     | MCP Plugin         | 模型上下文协议插件                 |
| 8    | s_full  | Full Agent         | 所有机制整合                       |

## 技术栈说明

| 工具              | 用途                     |
| ----------------- | ------------------------ |
| TypeScript        | 主要语言，类型安全       |
| tsdown            | 现代化构建工具，替代 tsc |
| tsx               | 开发时直接运行 TS        |
| pnpm              | 包管理，更快更省空间     |
| @anthropic-ai/sdk | Anthropic 官方 SDK       |

## 核心模式

整个项目的核心就是 **一个循环**：

```
┌─────────┐    ┌───────┐    ┌─────────┐
│  User   │───▶│  LLM  │───▶│  Tool   │
│ prompt  │    │       │    │ execute │
└─────────┘    └───┬───┘    └────┬────┘
                   │             │
                   │ tool_result │
                   ▼             │
               ┌─────────┐       │
               │ append  │◀──────┘
               │ to msg  │
               └─────────┘
                   │
                   │ loop continues
                   ▼
               ┌───────┐
               │  LLM  │
               │ again │
               └───────┘
```

### 核心代码模式

```typescript
async function agentLoop(messages: Message[]): Promise<void> {
  while (true) {
    // 1. 调用 LLM
    const response = await client.messages.create({
      model: MODEL,
      system: SYSTEM,
      messages: messages,
      tools: TOOLS,
    })

    // 2. 记录 assistant 回复
    messages.push({ role: 'assistant', content: response.content })

    // 3. 如果模型决定停止，退出循环
    if (response.stop_reason !== 'tool_use') {
      return
    }

    // 4. 执行所有工具调用
    const results: ToolResult[] = []
    for (const block of response.content) {
      if (block.type === 'tool_use') {
        const output = await executeTool(block.name, block.input)
        results.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: output,
        })
      }
    }

    // 5. 将结果追加回消息
    messages.push({ role: 'user', content: results })

    // 循环继续，回到步骤 1...
  }
}
```

### 关键洞察

> **模型决定何时调用工具、何时停止。代码只执行模型的请求。**

这不是一个决策树或流程图——所有决策都在模型内部。Harness（套件）的工作是：

- 提供工具定义（告诉模型它能做什么）
- 执行工具调用（把模型的意图变成现实）
- 返回结果（让模型知道发生了什么）

## 下一步

接下来我们将在 `01-agent-loop.md` 中实现第一个可运行的 Agent：只有 Bash 工具的基础循环。

---

**Session 0 完成 ✓**
