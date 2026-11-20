---
name: context-slim
description: Compress large files, codebases, JSON payloads, CSVs, and logs before sending or reading them in AI sessions to cut token consumption.
---

# Context Slim Skill

Use `context-slim` before reading or pasting large files, repositories, JSON payloads, or verbose logs into an AI conversation.

## Workflow

1. **Audit first (`slim_audit` or `context-slim inspect <path>`):** check estimated token size and potential savings before loading raw content.
2. **Compress (`slim_file` or `context-slim pack <path> --level balanced`):**
   - Use `balanced` by default (strips comments/blank lines, deduplicates repeated log lines, compacts JSON arrays, strips base64 blobs).
   - Use `aggressive` or `maxTokens` for large directories or strict context budgets (extracts code skeletons / AST signatures via `repomix` when available).
   - Use `slim_text` (or `context-slim text --stdin --copy`) to shrink raw logs, stack traces, or prompt drafts before sending to web/desktop AI apps.
3. **Inspect raw lines selectively:** only open exact line ranges when you need implementation details after locating the right file/symbol.
