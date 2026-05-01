# 05 - Skills (s05)

## 核心概念

把可选知识从常驻 system prompt 里拆出来。轻量目录放在 system prompt，完整正文按需加载。

s05 的核心是**按需知识加载**，不是"多一个工具"。

**关键洞察：skill 的价值，是"把可选知识从常驻 prompt 里拆出来"，不是"多一个知识库"。**

## ASCII 架构图

```
System Prompt                      Tool Result
+------------------+               +------------------+
| 身份定义         |               | <skill>          |
| 工具说明         |               | 完整正文         |
| 规则约束         |               | ...              |
|                  |               | </skill>         |
| <skills_available>              +------------------+
| - code-review    |                      ^
|   Checklist...   |                      |
| - git-workflow   |     load_skill       |
|   Branch...      | <-------------------+
| </skills_available>             SkillRegistry
+------------------+               .loadFullText()
        |                                  |
        | 只放目录，不放正文                |
        v                                  v
  模型知道"有哪些可用"              只有需要时才加载完整内容
```

轻量目录永远可见，完整正文按需注入。

## Skill 文件结构

每个 skill 是一个目录，里面放 `SKILL.md`：

```text
skills/
  code-review/
    SKILL.md
  git-workflow/
    SKILL.md
  example/
    SKILL.md
```

## SKILL.md 格式（frontmatter + body）

```markdown
---
name: code-review
description: Checklist for reviewing code changes
---

## Code Review Checklist

When reviewing code changes, follow these steps:

1. **Check for null pointer access**
   - Verify all pointers are initialized before use

2. **Verify error handling**
   - Every error should be handled or propagated

3. **Check for security issues**
   - No hardcoded credentials
   - Input validation for external data
```

**frontmatter**（`---` 包裹的部分）：轻量元信息，会出现在 system prompt 的目录里。

**body**（后面的内容）：完整正文，只有调用 `load_skill` 时才注入上下文。

## 数据结构

```typescript
// src/core/types.ts

/** Skill 元信息（轻量，用于目录展示） */
interface SkillManifest {
  name: string // skill 名称
  description: string // 一句话描述
  path: string // 文件路径
}

/** Skill 完整内容（按需加载） */
interface SkillDocument {
  manifest: SkillManifest // 元信息
  body: string // 完整正文
}
```

两层设计：**轻量的 manifest 永远可见，完整的 body 按需加载**。

## SkillRegistry 类

```typescript
// src/planning/skill-loader.ts
export class SkillRegistry {
  private documents: Record<string, SkillDocument> = {}

  constructor(skillsDir: string = SKILLS_DIR) {
    this.loadAll(skillsDir)
  }

  // 1. 扫描 skills 目录，解析所有 SKILL.md
  private async loadAll(skillsDir: string): Promise<void> {
    const entries = await fs.readdir(skillsDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const skillPath = path.join(skillsDir, entry.name, 'SKILL.md')
      const content = await fs.readFile(skillPath, 'utf-8')
      const { meta, body } = this.parseFrontmatter(content)
      // 存入 documents...
    }
  }

  // 2. 解析 frontmatter（YAML 格式）
  private parseFrontmatter(content: string): { meta: Record<string, string>; body: string }

  // 3. 生成轻量目录（放在 system prompt）
  describeAvailable(): string {
    // - code-review: Checklist for reviewing code changes
    // - git-workflow: Branch and commit guidance
    // - example: Example skill for demonstration
  }

  // 4. 加载完整正文（load_skill 工具返回）
  loadFullText(name: string): string {
    // <skill name="code-review">
    // 完整审查说明
    // </skill>
  }
}
```

四个核心方法：

| 方法                  | 做什么                  |
| --------------------- | ----------------------- |
| `loadAll()`           | 启动时扫描所有 SKILL.md |
| `parseFrontmatter()`  | 解析 YAML 元信息        |
| `describeAvailable()` | 生成轻量目录字符串      |
| `loadFullText()`      | 返回格式化的完整正文    |

## load_skill 工具定义

```typescript
// src/planning/skill-loader.ts
export const LOAD_SKILL_TOOL_DEFINITION: ToolDefinition = {
  name: 'load_skill',
  description:
    'Load the full body of a named skill into the current context. Use this when you need specialized instructions for a task type.',
  input_schema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'The skill name to load' },
    },
    required: ['name'],
  },
}
```

关键是 `description`：告诉模型"这是加载完整说明的工具"，不是"查询技能列表"。

## System Prompt 改动

```typescript
// src/sessions/s05-skill-loading.ts
const S05_SYSTEM = `You are a coding agent at ${WORKDIR}.

<skills_available>
${skillRegistry.describeAvailable()}
</skills_available>

Use load_skill when a task needs specialized instructions before you act.`
```

**只放目录信息，不放完整正文。**

模型看到的 system prompt：

```text
<skills_available>
- code-review: Checklist for reviewing code changes
- git-workflow: Branch and commit guidance
- example: Example skill for demonstration
</skills_available>
```

只有名字和描述，没有完整步骤。轻量。

## 调用流程

```
用户请求: "帮我审查 src/core/agent-loop.ts 的代码质量"

模型看到 system prompt 里有：
  - code-review: Checklist for reviewing code changes

模型判断需要 code-review 知识：
  ↓
调用 load_skill 工具
  ↓
SkillRegistry.loadFullText("code-review")
  ↓
返回：
  <skill name="code-review">
  ## Code Review Checklist
  1. Check for null pointer access
  2. Verify error handling
  3. Check for security issues
  ...
  </skill>
  ↓
模型看到完整 skill 正文，开始执行审查
```

## 相对 s04 的变更

| 组件     | s04                          | s05                        |
| -------- | ---------------------------- | -------------------------- |
| Tools    | 5 (base + task)              | 5 (base + load_skill)      |
| Handlers | BASE_HANDLERS + task handler | BASE_HANDLERS + load_skill |
| 核心机制 | 上下文隔离                   | 按需知识加载               |
| 解决问题 | 上下文污染                   | Prompt 臃肿                |
| 新增目录 | skills/\*/SKILL.md           | skills/\*/SKILL.md         |

**s04 管理"做过的事"，s05 管理"知道的事"。两者互补。**

## 运行测试

```bash
pnpm run s05

# 测试对话示例
s05 >> 你有哪些 skill 可用？
我看到 system prompt 里列出了：
- example-skill: An example skill for demonstration

s05 >> 加载 example-skill
> load_skill: example-skill
<skill name="example-skill">
## Example Skill
This is an example skill file...
</skill>

s05 >> q
```

**验证目录生成**：

启动时 system prompt 包含 `<skills_available>` 标签，里面列出所有 skill 的名字和描述。

**验证按需加载**：

调用 `load_skill` 后，返回 `<skill>` 标签包裹的完整正文。

## skill vs memory vs CLAUDE.md 的边界

这三个概念很容易混淆：

| 类型          | 作用                               | 加载时机 | 持久性     |
| ------------- | ---------------------------------- | -------- | ---------- |
| **skill**     | 可选知识包（"怎么做一类事"）       | 按需加载 | 文件存储   |
| **memory**    | 跨会话有价值的信息（"记住的事实"） | 每轮都有 | 文件持久化 |
| **CLAUDE.md** | 稳定的全局规则                     | 每轮都有 | 项目根目录 |

判断方法：

- 某类任务才需要的做法/知识 → `skill`
- 需要长期记住的事实/偏好 → `memory`
- 更稳定的全局规则 → `CLAUDE.md`

## 教学边界

s05 是**两层 skill 系统**，不是完整的知识管理系统：

| 特性     | s05 Skills | 12+ Knowledge System       |
| -------- | ---------- | -------------------------- |
| 来源     | 单一目录   | 多来源（项目、用户、插件） |
| 参数化   | 无         | 支持参数传入 skill         |
| 条件激活 | 手动判断   | 自动根据任务类型           |
| 动态更新 | 重启生效   | 热更新                     |

先做简单两层设计，再做高级功能。

## 常见误区

### ❌ 把所有 skill 正文都放进 system prompt

浪费 token。当前任务可能只需要一个 skill，但其他 skill 的正文也在 prompt 里占空间。

### ❌ skill 目录信息写得太弱

如果只有名字没有描述，模型不知道什么时候该加载它。

### ❌ 把 skill 当成"绝对规则"

skill 更像"可选工作手册"，不是所有轮次都必须用。

### ❌ 把 skill 和 memory 混成一类

skill 解决"怎么做一类事"，memory 解决"记住长期事实"。

## 下一步

s06 将展示：**上下文压缩。三层压缩策略实现无限会话。**

---

**Session 05 完成 ✓**

- 理解了 Prompt 臃肿的根本原因
- 实现了两层 skill 结构（manifest + document）
- 实现了 SkillRegistry 的目录生成和正文加载
- 理解了 frontmatter + body 的文件格式
- 运行了 s05 REPL 测试
