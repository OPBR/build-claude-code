# Build Claude Code

[English](./README.md) | [中文](./README-zh.md)

> 从0到1构建 Claude Code 风格的 AI Coding Agent
> **Agency comes from the model. The harness makes agency real.**

## 简介

这是一个**渐进式学习项目**，用 TypeScript 从零开始构建一个完整的 AI 编程代理。我们将逐步实现 Claude Code 的所有核心机制：

- 核心循环
- 工具系统
- 任务规划
- 上下文压缩
- 多代理协作
- 工作树隔离

**核心理念**：智能来自模型训练，Harness（套件）只是让智能得以表达的载体。我们构建的是载体，不是智能本身。

## 学习路线

| 阶段 | Session | 主题               | 核心概念                           |
| ---- | ------- | ------------------ | ---------------------------------- |
| 1    | s01     | Agent Loop         | 一个循环 + Bash = Agent            |
| 1    | s02     | Tool Use           | 添加工具 = 添加一个 handler        |
| 2    | s03     | TodoWrite          | 没有计划的代理会迷失方向           |
| 2    | s04     | Subagent           | 大任务拆分，子任务获得干净的上下文 |
| 2    | s05     | Skills             | 按需加载知识，不要 upfront         |
| 3    | s06     | Context Compact    | 三层压缩策略实现无限会话           |
| 3    | s07     | Task System        | 文件持久化任务板 + 依赖图          |
| 3    | s08     | Background Tasks   | 后台执行 + 通知队列                |
| 4    | s09     | Agent Teams        | JSONL 邮箱通信的多代理             |
| 4    | s10     | Team Protocols     | 关闭/审批协议                      |
| 4    | s11     | Autonomous Agents  | 代理自动发现任务                   |
| 5    | s12     | Worktree Isolation | 目录级隔离执行                     |
| 6    | s_full  | Full Agent         | 所有机制整合                       |

## 快速开始

### 环境要求

- Node.js >= 20
- pnpm >= 10

### 安装

```bash
pnpm install
```

### 配置

复制 `.env.example` 为 `.env`，填入你的 API 配置：

```env
ANTHROPIC_API_KEY=your-api-key-here
MODEL_ID=claude-sonnet-4-20250514
```

### 运行

```bash
# 运行 s01 - 基础 Agent Loop
pnpm s01

# 运行其他 session
pnpm s02
pnpm s03
# ...

# 运行完整代理
pnpm full
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
    })

    messages.push({ role: 'assistant', content: response.content })

    if (response.stop_reason !== 'tool_use') {
      return // 模型决定停止
    }

    const results = await executeTools(response.content)
    messages.push({ role: 'user', content: results })
    // 循环继续...
  }
}
```

**模型决定何时调用工具、何时停止。代码只执行模型的请求。**

## 项目结构

```
build-claude-code/
├── src/
│   ├── index.ts              # 入口文件
│   ├── core/                 # 核心模块 (s01-s02)
│   │   ├── agent-loop.ts     # 核心循环
│   │   ├── tools.ts          # 工具系统
│   │   └── types.ts          # 类型定义
│   ├── planning/             # 计划模块 (s03-s05)
│   ├── persistence/          # 持久化模块 (s06-s08)
│   ├── team/                 # 团队模块 (s09-s11)
│   ├── isolation/            # 隔离模块 (s12)
│   ├── full/                 # 综合实现
│   └── sessions/             # 各 session 入口
├── learn/
│   ├── 00-project-setup.md   # 项目初始化笔记
│   ├── 01-agent-loop.md      # s01 学习笔记
│   ├── ...                   # 每个 session 的学习笔记
│   └── output/               # 公众号文章输出
├── skills/                   # 技能文件目录
├── package.json
├── tsconfig.json
├── eslint.config.mjs
├── .prettierrc
└── .env.example
```

## 技术栈

| 工具              | 版本 | 说明               |
| ----------------- | ---- | ------------------ |
| TypeScript        | 6.0  | 主要语言           |
| tsdown            | 0.21 | 现代化构建工具     |
| tsx               | 4.21 | 开发时直接运行 TS  |
| pnpm              | 10   | 包管理             |
| @anthropic-ai/sdk | 0.90 | Anthropic 官方 SDK |
| ESLint            | 10   | 代码检查           |
| Prettier          | 3.8  | 代码格式化         |

## 开发命令

```bash
pnpm dev          # 开发模式
pnpm build        # 构建
pnpm typecheck    # 类型检查
pnpm lint         # ESLint 检查
pnpm lint:fix     # ESLint 自动修复
pnpm format       # Prettier 格式化
pnpm format:check # Prettier 检查
```

## 学习资源

- [learn-claude-code](https://github.com/shareAI-lab/learn-claude-code) - Python 参考实现
- [Claude Code 官方文档](https://docs.anthropic.com/claude-code)
- [Kode CLI](https://github.com/shareAI-lab/Kode-cli) - 开源实现

## 代码风格

- 无分号
- 单引号
- 尾逗号

## License

MIT

---

**Agency comes from the model. The harness makes agency real.**
**Build great harnesses. The model will do the rest.**
