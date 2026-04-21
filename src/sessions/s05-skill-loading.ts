/**
 * s05 Session 入口 - Skill Loading
 * 按需知识加载，把可选知识从常驻 prompt 里拆出来
 */

import readline from 'node:readline'
import { agentLoop, extractTextReply, WORKDIR } from '../core/agent-loop'
import { BASE_TOOLS, BASE_HANDLERS } from '../core/tools'
import {
  SkillRegistry,
  LOAD_SKILL_TOOL_DEFINITION,
  createLoadSkillHandler,
} from '../planning/skill-loader'
import type { Message, ToolDefinition, ToolHandler } from '../core/types'

async function main() {
  console.log('\x1b[36m╔════════════════════════════════════╗\x1b[0m')
  console.log('\x1b[36m║  s05 - Skills                      ║\x1b[0m')
  console.log('\x1b[36m║  "Discover cheap, load when needed" ║\x1b[0m')
  console.log('\x1b[36m╚════════════════════════════════════╝\x1b[0m')
  console.log()

  // 检查 API Key
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    console.error('\x1b[31mError: API key not set\x1b[0m')
    console.error('Please copy .env.example to .env and add your API key')
    process.exit(1)
  }

  // 初始化 SkillRegistry
  const skillRegistry = new SkillRegistry()

  // s05 系统提示词（包含 skill 目录）
  const S05_SYSTEM = `You are a coding agent at ${WORKDIR}.

<skills_available>
${skillRegistry.describeAvailable()}
</skills_available>

Use load_skill when a task needs specialized instructions before you act.`

  // s05 工具：基础 4 个 + load_skill
  const S05_TOOLS: ToolDefinition[] = [...BASE_TOOLS, LOAD_SKILL_TOOL_DEFINITION]
  const S05_HANDLERS: Record<string, ToolHandler> = {
    ...BASE_HANDLERS,
    load_skill: createLoadSkillHandler(skillRegistry),
  }

  console.log(`Working directory: ${WORKDIR}`)
  console.log('Tools: bash, read_file, write_file, edit_file, load_skill')
  console.log('Type "q" or "exit" to quit.\n')

  const history: Message[] = []
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  const prompt = (): void => {
    rl.question('\x1b[36ms05 >> \x1b[0m', async (query: string) => {
      const trimmed = query.trim().toLowerCase()

      if (trimmed === 'q' || trimmed === 'exit' || trimmed === '') {
        rl.close()
        console.log('Goodbye!')
        return
      }

      history.push({ role: 'user', content: query })

      try {
        await agentLoop(history, {
          tools: S05_TOOLS,
          handlers: S05_HANDLERS,
          system: S05_SYSTEM,
        })
        const reply = extractTextReply(history)
        if (reply) console.log(reply)
      } catch (error) {
        console.error('\x1b[31mError:\x1b[0m', error)
      }

      console.log()
      prompt()
    })
  }

  prompt()
}

main()
