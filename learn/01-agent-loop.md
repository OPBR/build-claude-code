# 01 - Agent Loop (s01)

## 核心概念

> **"One loop & Bash is all you need"**

一个 AI Agent 的本质就是一个简单的循环：调用 LLM → 执行工具 → 返回结果 → 循环继续。

模型决定何时调用工具、何时停止。代码只是执行器的角色。

## ASCII 架构图

```
┌─────────────┐    ┌───────────┐    ┌─────────────┐
│    User     │───▶│    LLM    │───▶│    Tool     │
│   prompt    │    │           │    │   execute   │
└─────────────┘    └─────┬─────┘    └──────┬──────┘
                         │                  │
                         │   tool_result    │
                         │                  │
                         ▼                  │
                   ┌───────────┐            │
                   │   append  │◀───────────┘
                   │  to msgs  │
                   └─────┬─────┘
                         │
                         │  loop continues
                         ▼
                   ┌───────────┐
                   │    LLM    │
                   │   again   │
                   └───────────┘
```

## 核心代码

```typescript
async function agentLoop(messages: Message[]): Promise<void> {
  while (true) {
    // 1. 调用 LLM
    const response = await client.messages.create({
      model: MODEL,
      system: SYSTEM,
      messages: messages,
      tools: TOOLS,
      max_tokens: 8000,
    });

    // 2. 记录 assistant 回复
    messages.push({
      role: 'assistant',
      content: response.content as ContentBlock[],
    });

    // 3. 如果模型决定停止，退出循环
    if (response.stop_reason !== 'tool_use') {
      return;  // <-- 关键：模型决定何时停止
    }

    // 4. 执行所有工具调用
    const results: ToolResultBlock[] = [];
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
    messages.push({
      role: 'user',
      content: results,
    });

    // 循环继续...
  }
}
```

## 关键洞察

### stop_reason 的作用

- `stop_reason === 'tool_use'`：模型想要调用工具，循环继续
- `stop_reason === 'end_turn'`：模型决定结束，退出循环

**这不是代码决定的——是模型决定的。**

### 为什么这么简单？

因为所有"智能"都在模型内部：
- 模型决定调用什么工具
- 模型决定工具参数
- 模型决定何时停止
- 模型决定下一步做什么

代码只是：
- 定义工具（告诉模型它能做什么）
- 执行工具（把模型意图变成现实）
- 返回结果（让模型知道发生了什么）

## 工具定义示例

只有一个 Bash 工具：

```typescript
const TOOLS = [{
  name: 'bash',
  description: 'Run a shell command.',
  input_schema: {
    type: 'object',
    properties: {
      command: { type: 'string' }
    },
    required: ['command'],
  },
}];
```

## 安全考虑

阻止危险命令：

```typescript
const DANGEROUS_COMMANDS = [
  'rm -rf /',
  'sudo',
  'shutdown',
  'reboot',
];

function runBash(command: string): string {
  for (const dangerous of DANGEROUS_COMMANDS) {
    if (command.includes(dangerous)) {
      return `Error: Dangerous command blocked`;
    }
  }
  // ... 执行命令
}
```

## 运行测试

```bash
pnpm run s01

# 测试对话示例
s01 >> 列出当前目录的文件
s01 >> 创建一个 test.txt 文件，内容是 "Hello World"
s01 >> 读取 test.txt 的内容
s01 >> q
```

## 下一步

s02 将展示：**添加工具不需要改变循环，只需要添加 handler。**

---

**Session 01 完成 ✓**
- 理解了核心循环模式
- 实现了只有 Bash 的最小 Agent
- 运行了 REPL 测试