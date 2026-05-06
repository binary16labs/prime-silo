# Benny Skills

This directory contains agent capabilities (skills) that can be discovered and used by agents.

## Structure

```
skills/
├── TOOLS.md                 # Master tool registry
├── knowledge_search/
│   └── SKILL.md            # Semantic search capability
├── file_operations/
│   └── SKILL.md            # Read/write files
└── data_processing/
    └── SKILL.md            # CSV, PDF extraction
```

## Creating a Skill

Each skill folder must contain a `SKILL.md` with this format:

```markdown
---
name: skill_name
description: Brief description of what this skill does
---

## Usage

Explain when and how to use this skill.

## Tools

List the tools this skill provides:

- `tool_function(arg1, arg2)` - Description

## Examples

Provide example Actions and Observations.
```

## Available Skills

| Skill              | Description                  | Status     |
| ------------------ | ---------------------------- | ---------- |
| `knowledge_search` | Semantic search in workspace | 🔜 Planned |
| `file_operations`  | Read/write workspace files   | 🔜 Planned |
| `data_processing`  | Extract data from PDF/CSV    | 🔜 Planned |
| `code_execution`   | Sandboxed Python REPL        | 🔜 Planned |
