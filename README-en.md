# Build Claude Code - Build an AI Coding Agent from Scratch

[中文](./README.md) | [English](./README-en.md)

## Introduction

This is a **progressive learning project** that builds a complete AI coding agent from scratch using TypeScript.

**Core Philosophy**: Intelligence comes from model training. The harness is just the carrier that allows intelligence to express itself. We build the carrier, not the intelligence itself.

## Learning Roadmap

```
Phase 1: Basic Loop
  s01 Agent Loop       - One loop + Bash = Agent
  s02 Tool Use         - Add tool = Add one handler

Phase 2: Planning & Context
  s03 TodoWrite        - Agents without plans lose direction
  s04 Subagent         - Subtasks get clean context
  s05 Skills           - Load knowledge on demand

Phase 3: Safety & Stability
  s06 Context Compact  - Three-layer compression strategy
  s07 Permission System - Security check before tool execution
  s08 Hook System      - Insert behavior at fixed points

Phase 4: Memory & Recovery
  s09 Memory System    - Persist information across sessions
  s10 System Prompt    - Dynamic prompt assembly
  s11 Error Recovery   - Error classification + recovery paths

Phase 5: Tasks & Scheduling
  s12 Task System      - File-persisted task board
  s13 Background Tasks - Background execution
  s14 Cron Scheduler   - Scheduled task execution

Phase 6: Multi-Agent Collaboration
  s15 Agent Teams      - JSONL mailbox communication
  s16 Team Protocols   - Shutdown/approval protocols
  s17 Autonomous Agents - Agents discover tasks automatically
  s18 Worktree Isolation - Directory-level isolation

Phase 7: Plugin Extension
  s19 MCP Plugin       - Model Context Protocol plugin

Phase 8: Full Integration
  s_full Full Agent    - All mechanisms combined
```

## Quick Start

### Requirements

- Node.js >= 20
- pnpm >= 10

### Install & Run

```bash
pnpm install
cp .env.example .env  # Fill in your API Key

pnpm s01  # Run the first session
```

## Core Pattern

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

**The model decides when to call tools and when to stop. Code only executes the model's requests.**

## Tech Stack

| Tool              | Description            |
| ----------------- | ---------------------- |
| TypeScript 6.0    | Main language          |
| tsdown            | Modern build tool      |
| @anthropic-ai/sdk | Anthropic official SDK |

## License

MIT
