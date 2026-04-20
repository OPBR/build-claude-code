/**
 * 工具定义和基础实现
 * s02 中扩展此文件
 */

import { execSync } from 'child_process'
import { promises as fs } from 'fs'
import * as path from 'path'
import type { ToolDefinition, ToolHandler } from './types'

// ============================================================================
// 配置
// ============================================================================

export const WORKDIR = process.cwd()

// ============================================================================
// 安全检查
// ============================================================================

const DANGEROUS_COMMANDS = ['rm -rf /', 'sudo', 'shutdown', 'reboot', '> /dev/']

export function safePath(relativePath: string): string {
  const absolutePath = path.resolve(WORKDIR, relativePath)
  if (!absolutePath.startsWith(WORKDIR)) {
    throw new Error(`Path escapes workspace: ${relativePath}`)
  }
  return absolutePath
}

// ============================================================================
// 基础工具实现
// ============================================================================

export const runBash: ToolHandler = (input) => {
  const command = input.command as string

  for (const dangerous of DANGEROUS_COMMANDS) {
    if (command.includes(dangerous)) {
      return 'Error: Dangerous command blocked'
    }
  }

  try {
    // Windows 使用 PowerShell (UTF-8)，其他平台使用默认 shell
    const shell = process.platform === 'win32' ? 'powershell.exe' : undefined

    const result = execSync(command, {
      cwd: WORKDIR,
      encoding: 'utf-8',
      timeout: 120000,
      maxBuffer: 50 * 1024 * 1024,
      shell,
    })
    return result.trim() || '(no output)'
  } catch (error: unknown) {
    if (error instanceof Error && 'stdout' in error) {
      const execErr = error as Error & { stdout?: string; stderr?: string }
      return (execErr.stdout || '') + (execErr.stderr || '') || `Error: ${error.message}`
    }
    return 'Error: Unknown error'
  }
}

export const runRead: ToolHandler = async (input) => {
  const filePath = safePath(input.path as string)
  const limit = input.limit as number | undefined

  try {
    const content = await fs.readFile(filePath, 'utf-8')
    const lines = content.split('\n')

    if (limit && limit < lines.length) {
      lines.length = limit
      lines.push(`... (${lines.length - limit} more lines)`)
    }

    return lines.join('\n').slice(0, 50000)
  } catch (error) {
    return `Error: ${error}`
  }
}

export const runWrite: ToolHandler = async (input) => {
  const filePath = safePath(input.path as string)
  const content = input.content as string

  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, content, 'utf-8')
    return `Wrote ${content.length} bytes to ${input.path}`
  } catch (error) {
    return `Error: ${error}`
  }
}

export const runEdit: ToolHandler = async (input) => {
  const filePath = safePath(input.path as string)
  const oldText = input.old_text as string
  const newText = input.new_text as string

  try {
    const content = await fs.readFile(filePath, 'utf-8')
    if (!content.includes(oldText)) {
      return `Error: Text not found in ${input.path}`
    }
    const newContent = content.replace(oldText, newText)
    await fs.writeFile(filePath, newContent, 'utf-8')
    return `Edited ${input.path}`
  } catch (error) {
    return `Error: ${error}`
  }
}

// ============================================================================
// 工具定义
// ============================================================================

export const BASE_TOOLS: ToolDefinition[] = [
  {
    name: 'bash',
    description: 'Run a shell command.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to execute' },
      },
      required: ['command'],
    },
  },
  {
    name: 'read_file',
    description: 'Read file contents.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path to read' },
        limit: { type: 'integer', description: 'Maximum lines to read' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Write content to file.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path to write' },
        content: { type: 'string', description: 'Content to write' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'edit_file',
    description: 'Replace exact text in file.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path to edit' },
        old_text: { type: 'string', description: 'Text to find and replace' },
        new_text: { type: 'string', description: 'New text to insert' },
      },
      required: ['path', 'old_text', 'new_text'],
    },
  },
]

export const BASE_HANDLERS: Record<string, ToolHandler> = {
  bash: runBash,
  read_file: runRead,
  write_file: runWrite,
  edit_file: runEdit,
}
