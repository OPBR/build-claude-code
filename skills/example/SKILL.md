---
name: example-skill
description: An example skill for demonstration
tags: demo, example
---

# Example Skill

This is an example skill file to demonstrate the skill loading mechanism.

## What This Skill Does

- Shows the structure of a SKILL.md file
- Demonstrates YAML frontmatter parsing
- Provides a template for creating new skills

## How to Use

1. Create a directory in `skills/` with your skill name
2. Add a `SKILL.md` file with frontmatter
3. The agent can load it via `load_skill` tool

## Frontmatter Format

```yaml
---
name: skill-name
description: Short description shown in system prompt
tags: comma, separated, tags
---
```

## Body Content

The body is the full skill content loaded on demand via tool_result.
This allows the system prompt to stay small while giving access to
detailed knowledge when needed.
