# context-slim

[![context-slim MCP server](https://glama.ai/mcp/servers/@deusbr/context-slim/badges/score.svg)](https://glama.ai/mcp/servers/@deusbr/context-slim)

[![CI](https://github.com/deusbr/context-slim/actions/workflows/ci.yml/badge.svg)](https://github.com/deusbr/context-slim/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js >= 18](https://img.shields.io/badge/node-%3E%3D18.0.0-339933?logo=node.js&logoColor=white)](package.json)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](package.json)

Universal, zero-dependency token-saving compressor (**CLI + Ultra-Lean `stdio` MCP Server + Portable `SKILL.md`**) designed for **Codex**, **Gemini CLI**, **Claude Code / Desktop**, **Cursor**, **OpenBot**, and web AI chats (`--copy`).

Compresses files, project directories, JSON payloads, logs, CSVs, and Markdown **before** sending them to an LLM — cutting context bloat while preserving structural fidelity and enforcing `maxTokens` budgets.

---

## Why `context-slim`?

- **Built-in Zero-Dependency Engine (`standalone`):** Compresses code, JSON/JSONL, terminal logs, CSVs, Markdown, and directories anywhere Node.js `>= 18` runs.
- **Hybrid Acceleration (`auto` / `hybrid`):** Automatically leverages [`repomix`](https://github.com/yamadashy/repomix) (Tree-sitter AST compression for directories) and [`rtk`](https://github.com/rtk-ai/rtk) (`rtk json --keys-only`) when installed locally, with deterministic built-in fallbacks.
- **Zero MCP Schema Bloat:** Exposes only **3 compact MCP tools** (`slim_audit`, `slim_file`, `slim_text`) under ~300 schema tokens so the server saves tokens instead of adding overhead.
- **Ready for Web & Terminal Workflows:** Pipe from stdin (`--stdin`), copy straight to the system clipboard (`--copy`), or inspect savings first (`inspect`) before sending a single line to an AI model.

---

## Compression Strategies by Format

| Format | `balanced` (Default) | `aggressive` / Budgeted |
| :--- | :--- | :--- |
| **Code** (`.js`, `.ts`, `.py`, `.go`, `.rs`, etc.) | Strips comments while preserving string literals; collapses redundant blank lines | Extracts structural exports, classes, functions & imports skeleton |
| **JSON / JSONL** | Compacts whitespace, replaces huge base64/data blobs, caps long arrays (`<= 3` items + count) | Tighter depth/array caps or delegates to `rtk json --keys-only` when available |
| **Logs & Stacktraces** | Strips ANSI codes, collapses consecutive repeats (`[repeated Nx]`), keeps errors/warnings ±2 context lines | Tighter head/tail + ±1 context around errors/warnings |
| **CSV / TSV** | Keeps header + sample head/tail rows with omitted row count | Compact head/tail preview |
| **Directories** | Uses `repomix --compress` (if available) or built-in recursive walker skipping `node_modules`/`.git`/binaries | Enforces `--max-tokens N` budget cleanly across the pack |

---

## Quick Start

### 1. Audit & Compress via CLI

```bash
# Dry-run token audit before sending anything to an AI
node bin/context-slim.cjs inspect ./src

# Compress a file or directory and copy straight to clipboard for any AI chat
node bin/context-slim.cjs pack ./src --level balanced --max-tokens 2500 --copy

# Compress piped terminal logs or JSON from stdin
cat app.log | node bin/context-slim.cjs text --format log --copy

# Check detected hybrid engines (built-in + rtk / repomix)
node bin/context-slim.cjs engines
```

### 2. Install Across AI Clients (Codex, Gemini CLI, Claude, Cursor)

```bash
node bin/context-slim.cjs install --client all
node bin/context-slim.cjs status
```

This atomically registers the ultra-lean `context-slim` MCP server and copies `skill/SKILL.md` into your local AI clients.

---

## Ultra-Lean MCP Tools (`bin/mcp-server.cjs`)

| Tool | Purpose | Required Input |
| :--- | :--- | :--- |
| `slim_audit` | Estimate token count & potential savings before reading | `path` |
| `slim_file` | Compress a file or directory (`light` / `balanced` / `aggressive`, `maxTokens`) | `path` |
| `slim_text` | Compress raw text, logs, JSON, or code snippets | `content` |

---

## Verification

```bash
npm run check
npm test
```

## License

[MIT](LICENSE) — Built by [Emerson Almeida (@deusbr)](https://github.com/deusbr).
