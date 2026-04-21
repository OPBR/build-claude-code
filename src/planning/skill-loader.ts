/**
 * Skill Loader - 按需知识加载
 * s05: 把可选知识从常驻 prompt 里拆出来，改成按需加载
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { WORKDIR } from '../core/agent-loop'
import type { ToolDefinition, ToolHandler, ToolInputSchema, SkillDocument } from '../core/types'

// ============================================================================
// 配置
// ============================================================================

/** Skills 目录路径 */
const SKILLS_DIR = path.join(WORKDIR, 'skills')

// ============================================================================
// SkillRegistry 类
// ============================================================================

/**
 * Skill 注册表
 * 管理 skill 的发现和加载
 */
export class SkillRegistry {
  private documents: Record<string, SkillDocument> = {}

  constructor(skillsDir: string = SKILLS_DIR) {
    this.loadAll(skillsDir)
  }

  /**
   * 扫描 skills 目录，解析所有 SKILL.md
   */
  private async loadAll(skillsDir: string): Promise<void> {
    try {
      const entries = await fs.readdir(skillsDir, { withFileTypes: true })

      for (const entry of entries) {
        if (!entry.isDirectory()) continue

        const skillPath = path.join(skillsDir, entry.name, 'SKILL.md')
        try {
          const content = await fs.readFile(skillPath, 'utf-8')
          const { meta, body } = this.parseFrontmatter(content)

          const name = meta.name || entry.name
          const description = meta.description || 'No description'

          this.documents[name] = {
            manifest: {
              name,
              description,
              path: skillPath,
            },
            body: body.trim(),
          }
        } catch {
          // SKILL.md 不存在或无法读取，跳过
          continue
        }
      }
    } catch {
      // skills 目录不存在，保持空注册表
    }
  }

  /**
   * 解析 frontmatter（YAML 格式）
   * @param content SKILL.md 文件内容
   * @returns meta（元信息）和 body（正文）
   */
  private parseFrontmatter(content: string): { meta: Record<string, string>; body: string } {
    const match = content.match(/^---\n(.*?)\n---\n(.*)/s)
    if (!match) {
      return { meta: {}, body: content }
    }

    const meta: Record<string, string> = {}
    for (const line of match[1].trim().split('\n')) {
      if (!line.includes(':')) continue
      const colonIndex = line.indexOf(':')
      const key = line.slice(0, colonIndex).trim()
      const value = line.slice(colonIndex + 1).trim()
      meta[key] = value
    }

    return { meta, body: match[2] }
  }

  /**
   * 生成轻量目录（放在 system prompt）
   * @returns skill 目录列表字符串
   */
  describeAvailable(): string {
    if (Object.keys(this.documents).length === 0) {
      return '(no skills available)'
    }

    const lines: string[] = []
    for (const name of Object.keys(this.documents).sort()) {
      const doc = this.documents[name]
      lines.push(`- ${doc.manifest.name}: ${doc.manifest.description}`)
    }
    return lines.join('\n')
  }

  /**
   * 加载完整正文（load_skill 工具返回）
   * @param name skill 名称
   * @returns 格式化的 skill 正文
   */
  loadFullText(name: string): string {
    const doc = this.documents[name]
    if (!doc) {
      const known = Object.keys(this.documents).sort().join(', ') || '(none)'
      return `Error: Unknown skill '${name}'. Available skills: ${known}`
    }

    return `<skill name="${doc.manifest.name}">\n${doc.body}\n</skill>`
  }
}

// ============================================================================
// 工具定义
// ============================================================================

/**
 * load_skill 工具定义
 */
export const LOAD_SKILL_TOOL_DEFINITION: ToolDefinition = {
  name: 'load_skill',
  description:
    'Load the full body of a named skill into the current context. Use this when you need specialized instructions for a task type.',
  input_schema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'The skill name to load',
      },
    },
    required: ['name'],
  } as ToolInputSchema,
}

// ============================================================================
// Handler 创建
// ============================================================================

/**
 * 创建 load_skill handler
 * @param registry SkillRegistry 实例
 */
export function createLoadSkillHandler(registry: SkillRegistry): ToolHandler {
  return (input: Record<string, unknown>): string => {
    const name = input.name as string
    if (!name) {
      return 'Error: skill name is required'
    }

    console.log(`\x1b[33m> load_skill: ${name}\x1b[0m`)
    const content = registry.loadFullText(name)
    console.log(`\x1b[33m  ${content.slice(0, 100)}...\x1b[0m`)
    return content
  }
}
