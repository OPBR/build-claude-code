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
│   ├── persistence/        # 持久化模块 (s06-s08)
│   ├── team/               # 团队模块 (s09-s11)
│   ├── isolation/          # 隔离模块 (s12)
│   ├── full/               # 综合实现
│   ├── sessions/           # 各 session 入口
│   └── cli/                # REPL 界面
├── learn/                  # 学习笔记
├── skills/                 # 技能文件
└── 运行时目录...
```

## 技术栈说明

| 工具 | 用途 |
|------|------|
| TypeScript | 主要语言，类型安全 |
| tsdown | 现代化构建工具，替代 tsc |
| tsx | 开发时直接运行 TS |
| pnpm | 包管理，更快更省空间 |
| @anthropic-ai/sdk | Anthropic 官方 SDK |

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
    });

    // 2. 记录 assistant 回复
    messages.push({ role: 'assistant', content: response.content });

    // 3. 如果模型决定停止，退出循环
    if (response.stop_reason !== 'tool_use') {
      return;
    }

    // 4. 执行所有工具调用
    const results: ToolResult[] = [];
    for (const block of response.content) {
      if (block.type === 'tool_use') {
        const output = await executeTool(block.name, block.input);
        results.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: output,
        });
      }
    }

    // 5. 将结果追加回消息
    messages.push({ role: 'user', content: results });

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