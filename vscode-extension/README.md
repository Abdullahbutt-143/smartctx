# smartctx — VS Code extension

A VS Code extension wrapper around the [smartctx](https://www.npmjs.com/package/smartctx) CLI. Same core (scan → summarize → query → generate) with a native sidebar UI.

## Layout

```
vscode-extension/
├── package.json          extension manifest (commands, views, config)
├── esbuild.js            bundles src/ + ../src/ into dist/extension.js
├── tsconfig.json         type-check only (esbuild does the build)
├── src/
│   ├── extension.ts      activate() — registers commands + sidebar
│   ├── sidebar.ts        WebviewViewProvider — message bridge to webview
│   └── core.ts           thin wrapper around ../src/ (scanner, summarizer, …)
└── media/
    ├── main.js           webview UI logic
    ├── main.css          styles (uses VS Code theme vars)
    └── icon.svg          activity-bar icon
```

The extension imports the core from `../src/` directly; esbuild bundles it into `dist/extension.js` at build time. No duplication, no separate publish step.

## Develop

```bash
cd vscode-extension
npm install
npm run build     # one-off build
npm run watch     # rebuild on change
```

Then press **F5** in VS Code with `vscode-extension/` open as the workspace root. A new Extension Development Host window launches with the extension loaded.

## UI

Open the **smartctx** icon in the activity bar. The sidebar shows:

- **API key** input (stored in VS Code SecretStorage — never in a config file)
- **Status card** — project name, files indexed, last sync
- **Initialize / Sync** buttons
- **Query** section — task input, target dropdown (claude/cursor/copilot/codex), top-K
- **Results list** — click a file to open it; "Open context file" opens the generated `CLAUDE.md` / `.cursorrules` / etc.

All commands are also available in the command palette (`Cmd/Ctrl+Shift+P`):

- `smartctx: Initialize project`
- `smartctx: Sync changed files`
- `smartctx: Query for task`
- `smartctx: Set Anthropic API key`

## Settings

- `smartctx.defaultTarget` — which AI tool to target by default
- `smartctx.topK` — number of relevant files to include

## Package for install

```bash
npm install -g @vscode/vsce
vsce package
```

Produces `smartctx-vscode-0.1.0.vsix`. Install it locally with:

```bash
code --install-extension smartctx-vscode-0.1.0.vsix
```

## How the core is reused

`src/core.ts` re-exports the functions from `../src/storage.ts`, `../src/scanner.ts`, etc. These are the *same* modules used by the CLI in [../src/index.ts](../src/index.ts). If you change core behavior, both the CLI and the extension pick it up — there's no fork.

If you want to customize the UI further, the message protocol between [src/sidebar.ts](src/sidebar.ts) and [media/main.js](media/main.js) is the only boundary you touch — add a new message type on both sides and wire it through.
