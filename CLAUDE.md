# Build Claude Code - 从0到1构建 AI Coding Agent

## 项目简介

这是一个从零开始构建 Claude Code 风格 AI 编程代理的学习项目。我们将用 TypeScript 逐步实现所有核心机制。

## 技术栈

- **语言**: TypeScript 5.x
- **构建**: tsdown (现代化的 TypeScript 构建工具)
- **包管理**: pnpm
- **LLM SDK**: @anthropic-ai/sdk (官方 Node.js SDK)
- **运行时**: Node.js 20+

## 学习路线

| 阶段 | Session | 主题 | 核心概念 |
|------|---------|------|----------|
| 1 | s01 | Agent Loop | 一个循环 + Bash = Agent |
| 1 | s02 | Tool Use | 添加工具 = 添加一个 handler |
| 2 | s03 | TodoWrite | 没有计划的代理会迷失方向 |
| 2 | s04 | Subagent | 大任务拆分，子任务获得干净的上下文 |
| 2 | s05 | Skills | 按需加载知识，不要 upfront |
| 3 | s06 | Context Compact | 三层压缩策略实现无限会话 |
| 3 | s07 | Task System | 文件持久化任务板 + 依赖图 |
| 3 | s08 | Background Tasks | 后台执行 + 通知队列 |
| 4 | s09 | Agent Teams | JSONL 邮箱通信的多代理 |
| 4 | s10 | Team Protocols | 关闭/审批协议 |
| 4 | s11 | Autonomous Agents | 代理自动发现任务 |
| 5 | s12 | Worktree Isolation | 目录级隔离执行 |
| 6 | s_full | Full Agent | 所有机制整合 |

## 目录结构

```
build-claude-code/
├── CLAUDE.md              # 项目说明（本文件）
├── package.json           # 项目配置
├── tsdown.config.ts       # 构建配置
├── tsconfig.json          # TypeScript 配置
├── src/
│   ├── index.ts           # 入口文件
│   ├── core/
│   │   ├── agent-loop.ts  # s01: 核心循环
│   │   ├── tools.ts       # s02: 工具系统
│   │   └── types.ts       # 类型定义
│   ├── planning/
│   │   ├── todo.ts        # s03: TodoWrite
│   │   ├── subagent.ts    # s04: 子代理
│   │   └── skill-loader.ts # s05: 技能加载
│   ├── persistence/
│   │   ├── compact.ts     # s06: 上下文压缩
│   │   ├── task-manager.ts # s07: 任务系统
│   │   └── background.ts  # s08: 后台任务
│   ├── team/
│   │   ├── message-bus.ts # s09: 消息总线
│   │   ├── teammate.ts    # s09/s11: 队友代理
│   │   ├── protocols.ts   # s10: 协议
│   │   └── autonomous.ts  # s11: 自主代理
│   ├── isolation/
│   │   └── worktree.ts    # s12: 工作树隔离
│   └── full/
│   │   └── agent.ts       # s_full: 综合实现
│   └── cli/
│       └── repl.ts        # REPL 交互界面
├── learn/
│   ├── 00-project-setup.md
│   ├── 01-agent-loop.md
│   ├── 02-tool-use.md
│   ├── ... (每个 session 的学习笔记)
├── skills/                 # 技能文件目录
│   └── example/
│       └── SKILL.md
├── .tasks/                 # 任务持久化目录 (运行时)
├── .team/                  # 团队配置目录 (运行时)
├── .transcripts/           # 会话记录目录 (运行时)
└── .env.example            # 环境变量示例
```

## 核心模式

整个项目的核心就是一个简单的循环：

```typescript
async function agentLoop(messages: Message[]): Promise<void> {
  while (true) {
    const response = await client.messages.create({
      model: MODEL,
      system: SYSTEM,
      messages: messages,
      tools: TOOLS,
    });

    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason !== 'tool_use') {
      return; // 模型决定停止
    }

    const results = await executeTools(response.content);
    messages.push({ role: 'user', content: results });
    // 循环继续...
  }
}
```

**模型决定何时调用工具、何时停止。代码只执行模型的请求。**

## 开发命令

```bash
# 安装依赖
pnpm install

# 开发模式运行
pnpm dev

# 构建
pnpm build

# 运行特定 session
pnpm run s01
pnpm run s02
# ...

# 运行完整代理
pnpm run full
```

## 环境配置

复制 `.env.example` 为 `.env` 并填写：

```env
ANTHROPIC_API_KEY=your-api-key-here
# 或使用自定义 endpoint
ANTHROPIC_BASE_URL=https://your-custom-endpoint.com
MODEL_ID=claude-sonnet-4-20250514
```

## 学习方式

每个 session 在 `learn/` 目录下有详细的学习笔记，包含：
- 核心概念解释
- ASCII 架构图
- 实现代码
- 运行测试

我们按顺序逐个实现，每一步都可以独立运行和测试。

---

**Agency comes from the model. The harness makes agency real.**
**Build great harnesses. The model will do the rest.**