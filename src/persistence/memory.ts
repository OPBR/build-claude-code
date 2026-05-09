/**
 * s09 Memory System
 * 记忆系统核心实现
 *
 * 核心思想：
 * - 有些信息应该跨越会话边界保存
 * - 但不是所有东西都适合存到记忆里
 *
 * 适合存记忆的：
 * - 用户偏好（"我喜欢用 tab 缩进"）
 * - 重复的用户反馈（"别这样做"）
 * - 不容易从代码推断的项目事实
 * - 外部资源的指针（"bug 在 Linear 的 INGEST 项目"）
 *
 * 不适合存记忆的：
 * - 可以从代码重新读取的结构
 * - 临时任务状态
 * - 密钥
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { WORKDIR } from '../core/agent-loop'
import type { MemoryEntry, MemoryType, ParsedMemory } from '../core/types'

// ============================================================================
// 常量
// ============================================================================

/** 记忆存储目录 */
const MEMORY_DIR = join(WORKDIR, '.memory')

/** 索引文件 */
const MEMORY_INDEX = join(MEMORY_DIR, 'MEMORY.md')

/** 支持的记忆类型 */
const MEMORY_TYPES: MemoryType[] = ['user', 'feedback', 'project', 'reference']

/** 索引最大行数 */
const MAX_INDEX_LINES = 200

/** 记忆使用指南（注入系统提示词） */
export const MEMORY_GUIDANCE = `When to save memories:
- User states a preference ("I like tabs", "always use pytest") -> type: user
- User corrects you ("don't do X", "that was wrong because...") -> type: feedback
- You learn a project fact that is not easy to infer from current code alone
  (for example: a rule exists because of compliance, or a legacy module must
  stay untouched for business reasons) -> type: project
- You learn where an external resource lives (ticket board, dashboard, docs URL)
  -> type: reference

When NOT to save:
- Anything easily derivable from code (function signatures, file structure, directory layout)
- Temporary task state (current branch, open PR numbers, current TODOs)
- Secrets or credentials (API keys, passwords)`

// ============================================================================
// MemoryManager 类
// ============================================================================

export class MemoryManager {
  /** 记忆存储目录 */
  private memoryDir: string

  /** 内存中的记忆 */
  memories: Map<string, MemoryEntry>

  constructor(memoryDir?: string) {
    this.memoryDir = memoryDir || MEMORY_DIR
    this.memories = new Map()
  }

  // ==========================================================================
  // 公开方法
  // ==========================================================================

  /**
   * 加载所有记忆
   * 扫描 .memory 目录下的所有 .md 文件，解析 frontmatter
   */
  loadAll(): void {
    this.memories = new Map()

    // 目录不存在，跳过
    if (!existsSync(this.memoryDir)) {
      return
    }

    // 扫描所有 .md 文件
    const files = readdirSync(this.memoryDir)

    for (const file of files) {
      // 跳过非 .md 文件
      if (!file.endsWith('.md')) continue

      // 跳过索引文件
      if (file === 'MEMORY.md') continue

      // 读取并解析文件
      const filePath = join(this.memoryDir, file)
      const content = readFileSync(filePath, 'utf-8')
      const parsed = this.parseFrontmatter(content)

      if (parsed && parsed.name) {
        this.memories.set(parsed.name, {
          name: parsed.name,
          description: parsed.description || '',
          type: (parsed.type as MemoryType) || 'project',
          content: parsed.content,
          file: file,
        })
      }
    }

    if (this.memories.size > 0) {
      console.log(`[Memory loaded: ${this.memories.size} memories from ${this.memoryDir}]`)
    }
  }

  /**
   * 构建记忆部分（注入系统提示词）
   * 按类型分组，生成 Markdown 格式
   */
  loadMemoryPrompt(): string {
    if (this.memories.size === 0) return ''

    const sections: string[] = []
    sections.push('# Memories (persistent across sessions)')
    sections.push('')

    // 按类型分组
    for (const type of MEMORY_TYPES) {
      const typed = [...this.memories.values()].filter((m) => m.type === type)
      if (typed.length === 0) continue

      sections.push(`## [${type}]`)
      for (const mem of typed) {
        sections.push(`### ${mem.name}: ${mem.description}`)
        if (mem.content.trim()) {
          sections.push(mem.content.trim())
        }
        sections.push('')
      }
    }

    return sections.join('\n')
  }

  /**
   * 保存记忆
   * 写入文件 + 更新内存 + 重建索引
   */
  saveMemory(name: string, description: string, type: string, content: string): string {
    // 验证类型
    if (!MEMORY_TYPES.includes(type as MemoryType)) {
      return `Error: type must be one of [${MEMORY_TYPES.join(', ')}]`
    }

    // 生成安全的文件名
    const safeName = name.toLowerCase().replace(/[^a-z0-9_-]/g, '_')
    if (!safeName) {
      return 'Error: invalid memory name'
    }

    const fileName = `${safeName}.md`
    const filePath = join(this.memoryDir, fileName)

    // 确保目录存在
    mkdirSync(this.memoryDir, { recursive: true })

    // 构建 frontmatter + 内容
    const frontmatter = [
      '---',
      `name: ${name}`,
      `description: ${description}`,
      `type: ${type}`,
      '---',
      content,
      '',
    ].join('\n')

    // 写入文件
    writeFileSync(filePath, frontmatter, 'utf-8')

    // 更新内存
    this.memories.set(name, {
      name,
      description,
      type: type as MemoryType,
      content,
      file: fileName,
    })

    // 重建索引
    this.rebuildIndex()

    return `Saved memory '${name}' [${type}] to .memory/${fileName}`
  }

  // ==========================================================================
  // 私有方法
  // ==========================================================================

  /**
   * 重建 MEMORY.md 索引
   * 从当前内存状态生成索引文件
   */
  private rebuildIndex(): void {
    const lines: string[] = ['# Memory Index', '']

    for (const [name, mem] of this.memories) {
      lines.push(`- [${name}](${mem.file}) — ${mem.description} [${mem.type}]`)

      // 限制行数
      if (lines.length >= MAX_INDEX_LINES) {
        lines.push(`... (truncated at ${MAX_INDEX_LINES} lines)`)
        break
      }
    }

    // 确保目录存在
    mkdirSync(this.memoryDir, { recursive: true })

    // 写入索引文件
    writeFileSync(MEMORY_INDEX, lines.join('\n') + '\n', 'utf-8')
  }

  /**
   * 解析 frontmatter
   * 提取 --- 分隔的头部和正文
   */
  private parseFrontmatter(text: string): ParsedMemory | null {
    // 匹配 --- 分隔的 frontmatter
    const match = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/)
    if (!match) return null

    const header = match[1]
    const body = match[2]

    const result: ParsedMemory = {
      content: body.trim(),
    }

    // 解析 key: value 行
    for (const line of header.split('\n')) {
      const colonIndex = line.indexOf(':')
      if (colonIndex > 0) {
        const key = line.slice(0, colonIndex).trim()
        const value = line.slice(colonIndex + 1).trim()
        if (key === 'name') result.name = value
        else if (key === 'description') result.description = value
        else if (key === 'type') result.type = value
      }
    }

    return result
  }
}
