# smartctx 🧠

> Save millions of tokens per day by giving AI coding assistants smart, curated context instead of your whole codebase.

## The Problem

Every time you start a Claude Code / Cursor / Copilot session, it reads your **entire project** — hundreds of files, thousands of lines. That's hundreds of thousands of tokens, every single session.

## The Solution

**smartctx** builds a local memory of your project once, then gives AI tools only the files relevant to your current task.

```
Without smartctx:  Claude reads 500 files = ~800,000 tokens per session 😬
With smartctx:     Claude reads 8 files   = ~12,000 tokens per session  ✅

Savings: ~98% token reduction
```

## Install

```bash
# npm
npm install -g smartctx

# pip
pip install smartctx

# Homebrew (macOS/Linux)
brew tap Abdullahbutt-143/smartctx
brew install smartctx

# Scoop (Windows)
scoop bucket add smartctx https://github.com/Abdullahbutt-143/scoop-smartctx
scoop install smartctx
```

## Quick Start

### Option A — Fully automatic (Claude Code)

```bash
# 1. Set your API key (one time, saved globally)
smartctx config --api-key sk-ant-xxxxx

# 2. Wire smartctx into Claude Code (one time)
cd your-project
smartctx install

# That's it. Every prompt you send in Claude Code now auto-updates CLAUDE.md
# behind the scenes — no manual commands ever again.
claude
```

### Option B — Manual (Cursor / Codex / other tools)

```bash
# 1. Set your API key (one time, saved globally)
smartctx config --api-key sk-ant-xxxxx

# 2. Initialize your project (one-time scan)
cd your-project
smartctx init

# 3. Before each AI session, query for your task
smartctx query "add authentication middleware"
# → generates CLAUDE.md / .cursorrules / AGENTS.md with only the relevant files

# 4. Start your AI tool — it reads the lean context file
cursor .   # or: claude, codex, etc.
```

## Commands

| Command | Description |
|---------|-------------|
| `smartctx install` | Wire smartctx into Claude Code so context auto-updates on every prompt |
| `smartctx auto "task"` | Silent one-shot: init (if needed) + sync (if stale) + query. Used by the Claude Code hook. |
| `smartctx init` | First-time setup — scans and summarizes all files |
| `smartctx sync` | Refresh changed files only (run daily/weekly) |
| `smartctx query "task"` | Generate lean context file for your task |
| `smartctx status` | Show index stats |
| `smartctx config` | View/set configuration |

## Auto-integration with Claude Code

`smartctx install` writes a `UserPromptSubmit` hook into `.claude/settings.json`. On every prompt you send, Claude Code runs `smartctx auto` with your prompt:

- If the project isn't indexed yet → it runs `init` silently
- If the index is stale (>5 min old) → it runs `sync` silently
- It runs `query` against your prompt and rewrites `CLAUDE.md`
- Claude Code reads the fresh `CLAUDE.md` on the next turn

Fails silently if anything goes wrong — your prompts are never blocked.

```bash
smartctx install                  # project-local hook (.claude/settings.json)
smartctx install --scope user     # global hook (~/.claude/settings.json)
smartctx install --uninstall      # remove it
```

> **Cursor / Codex / other tools** don't have a hook API yet — you'll still run `smartctx query "..."` manually. `smartctx install` only wires up Claude Code for now.

## Multi-AI Support

```bash
smartctx query "add auth" --for claude    # → CLAUDE.md
smartctx query "add auth" --for cursor    # → .cursorrules
smartctx query "add auth" --for copilot  # → .github/copilot-instructions.md
smartctx query "add auth" --for codex    # → AGENTS.md
```

## How It Works

1. **`init`** — Scans your project, calls Claude Haiku (cheapest model) once per file to generate a summary. Saves everything to `.smartctx/index.json` locally.

2. **`sync`** — Detects changed files (by modification time) and only re-summarizes those. Free for unchanged files.

3. **`query`** — Runs a **local** keyword search (zero API cost) over your summaries. Finds the top 10 most relevant files. Generates a lean context file.

4. **`auto`** — The silent flavor of all three, used by the Claude Code hook. Handles first-run init, stale-sync detection, and query in a single invisible step. Exits 0 even on failure so it never blocks your prompts.

5. **AI Session** — Your AI tool reads a 5-15k token context file instead of your 500k+ codebase.

## Cost

- **Init**: ~$0.0004 per file (Claude Haiku pricing) — a 100-file project costs ~$0.04 total
- **Sync**: Only pays for changed files — usually free
- **Query**: $0.00 — runs locally
- **Daily use**: $0.00

## Works With

- ✅ Node.js / TypeScript projects
- ✅ Python projects
- ✅ Go, Rust, Java, any language
- ✅ Any file-based project

## Configuration

```bash
smartctx config --api-key sk-ant-xxxxx    # Set API key
smartctx config --target cursor           # Default output format
smartctx config --schedule weekly         # Reminder schedule
```

## .gitignore

Add `.smartctx/` to your `.gitignore` (it's project-specific local data):

```
.smartctx/
CLAUDE.md
```

## License

MIT
