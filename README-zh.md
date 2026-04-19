# Build Claude Code - 从0到1构建 AI Coding Agent

[English](./README.md) | [中文](./README-zh.md)

> **Agency comes from the model. The harness makes agency real.**

## 简介

这是一个**渐进式学习项目**，用 TypeScript 从零开始构建一个完整的 AI 编程代理。

**核心理念**：智能来自模型训练，Harness（套件）只是让智能得以表达的载体。我们构建的是载体，不是智能本身。

## 学习路线

```
阶段 1: 基础循环
  s01 Agent Loop    - 一个循环 + Bash = Agent
  s02 Tool Use      - 添加工具 = 添加一个 handler

阶段 2: 计划与上下文
  s03 TodoWrite     - 没有计划的代理会迷失方向
  s04 Subagent      - 子任务获得干净的上下文
  s05 Skills        - 按需加载知识

阶段 3: 持久化与后台
  s06 Context Compact  - 三层压缩策略
  s07 Task System      - 文件持久化任务板
  s08 Background Tasks - 后台执行

阶段 4: 多代理协作
  s09 Agent Teams      - JSONL 邮箱通信
  s10 Team Protocols   - 关闭/审批协议
  s11 Autonomous Agents - 代理自动发现任务

阶段 5: 隔离执行
  s12 Worktree Isolation - 目录级隔离

阶段 6: 综合集成
  s_full Full Agent     - 所有机制整合
```

## 快速开始

### 环境要求

- Node.js >= 20
- pnpm >= 10

### 安装与运行

```bash
pnpm install
cp .env.example .env  # 填入 API Key

pnpm s01  # 运行第一个 session
```

## 核心模式

```typescript
async function agentLoop(messages) {
  while (true) {
    const response = await LLM(messages, tools)
    if (response.stop_reason !== 'tool_use') return
    executeTools(response)
    appendResults(messages)
  }
}
```

**模型决定何时调用工具、何时停止。代码只执行模型的请求。**

## 技术栈

| 工具              | 说明               |
| ----------------- | ------------------ |
| TypeScript 6.0    | 主要语言           |
| tsdown            | 现代化构建工具     |
| @anthropic-ai/sdk | Anthropic 官方 SDK |

## License

MIT
