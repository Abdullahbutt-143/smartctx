import * as vscode from "vscode";
import { SmartctxSidebarProvider } from "./sidebar";
import { runInit, runSync, runQuery, getStatus, isInitialized, Target } from "./core";

const API_KEY_SECRET = "smartctx.anthropicApiKey";

export function activate(context: vscode.ExtensionContext) {
  const provider = new SmartctxSidebarProvider(context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("smartctx.sidebar", provider)
  );

  // Status bar indicator
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
  statusBar.command = "workbench.view.extension.smartctx";
  statusBar.tooltip = "smartctx — click to open sidebar";
  context.subscriptions.push(statusBar);

  function updateStatusBar() {
    const projectPath = getWorkspace();
    if (!projectPath) {
      statusBar.text = "$(database) smartctx: no folder";
      statusBar.show();
      return;
    }

    if (!isInitialized(projectPath)) {
      statusBar.text = "$(database) smartctx: not indexed";
      statusBar.show();
      return;
    }

    const status = getStatus(projectPath);
    if (!status.initialized) {
      statusBar.text = "$(database) smartctx: not indexed";
      statusBar.show();
      return;
    }

    const ageMs = Date.now() - new Date(status.lastSync).getTime();
    const ageMin = Math.floor(ageMs / 60000);
    const ageStr = ageMin < 1 ? "just now" : ageMin < 60 ? `${ageMin}m ago` : `${Math.floor(ageMin / 60)}h ago`;

    statusBar.text = `$(database) smartctx: ${status.totalFiles} files, ${ageStr}`;
    statusBar.show();
  }

  // Update status bar on window focus and periodically
  context.subscriptions.push(
    vscode.window.onDidChangeWindowState(() => updateStatusBar())
  );
  setInterval(updateStatusBar, 60000);

  // Auto-index on workspace open
  scheduleAutoIndex(context, provider, updateStatusBar);

  // Wrap provider.refresh to also update status bar
  const origRefresh = provider.refresh.bind(provider);
  provider.refresh = () => { origRefresh(); updateStatusBar(); };

  context.subscriptions.push(
    vscode.commands.registerCommand("smartctx.setApiKey", async () => {
      const key = await vscode.window.showInputBox({
        prompt: "Enter your Anthropic API key",
        password: true,
        placeHolder: "sk-ant-...",
        ignoreFocusOut: true,
      });
      if (!key) return;
      await context.secrets.store(API_KEY_SECRET, key);
      vscode.window.showInformationMessage("smartctx: API key saved.");
      provider.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("smartctx.init", async () => {
      const projectPath = requireWorkspace();
      if (!projectPath) return;
      const apiKey = await requireApiKey(context);
      if (!apiKey) return;

      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "smartctx: indexing project" },
        async (progress) => {
          const result = await runInit(projectPath, apiKey, (current, total, filePath) => {
            progress.report({
              message: `[${current}/${total}] ${filePath}`,
              increment: (1 / total) * 100,
            });
          });
          vscode.window.showInformationMessage(
            `smartctx: indexed ${result.filesIndexed} files (~$${result.costUSD.toFixed(4)}).`
          );
        }
      );
      provider.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("smartctx.sync", async () => {
      const projectPath = requireWorkspace();
      if (!projectPath) return;
      const apiKey = await requireApiKey(context);
      if (!apiKey) return;

      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "smartctx: syncing" },
        async (progress) => {
          const result = await runSync(projectPath, apiKey, (current, total, filePath) => {
            progress.report({
              message: `[${current}/${total}] ${filePath}`,
              increment: (1 / total) * 100,
            });
          });
          vscode.window.showInformationMessage(
            `smartctx: +${result.added} new, ~${result.changed} changed, -${result.removed} deleted.`
          );
        }
      );
      provider.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("smartctx.query", async () => {
      const projectPath = requireWorkspace();
      if (!projectPath) return;

      const task = await vscode.window.showInputBox({
        prompt: "Describe your task",
        placeHolder: "e.g. add authentication middleware",
        ignoreFocusOut: true,
      });
      if (!task) return;

      const cfg = vscode.workspace.getConfiguration("smartctx");
      const target = cfg.get<Target>("defaultTarget", "claude");
      const topK = cfg.get<number>("topK", 10);

      try {
        const result = runQuery(projectPath, task, target, topK);
        if (!result) {
          vscode.window.showWarningMessage("smartctx: no matching files found.");
          return;
        }
        const open = "Open file";
        const action = await vscode.window.showInformationMessage(
          `smartctx: ${result.results.length} files → ${result.outputPath} (~${result.tokensSaved.toLocaleString()} tokens saved)`,
          open
        );
        if (action === open) {
          const doc = await vscode.workspace.openTextDocument(result.outputPath);
          await vscode.window.showTextDocument(doc);
        }
      } catch (err: any) {
        vscode.window.showErrorMessage(`smartctx: ${err.message}`);
      }
    })
  );

  // Initial status bar update
  updateStatusBar();
}

export function deactivate() {}

function getWorkspace(): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  return folders && folders.length > 0 ? folders[0].uri.fsPath : undefined;
}

function requireWorkspace(): string | undefined {
  const ws = getWorkspace();
  if (!ws) vscode.window.showErrorMessage("smartctx: open a folder first.");
  return ws;
}

async function requireApiKey(
  context: vscode.ExtensionContext
): Promise<string | undefined> {
  const existing = await context.secrets.get(API_KEY_SECRET);
  if (existing) return existing;

  const key = await vscode.window.showInputBox({
    prompt: "smartctx needs your Anthropic API key (stored in VS Code secret storage)",
    password: true,
    placeHolder: "sk-ant-...",
    ignoreFocusOut: true,
  });
  if (!key) return undefined;
  await context.secrets.store(API_KEY_SECRET, key);
  return key;
}

function scheduleAutoIndex(context: vscode.ExtensionContext, provider: SmartctxSidebarProvider, updateStatusBar: () => void) {
  // Wait for VS Code to settle before auto-indexing
  setTimeout(async () => {
    try {
      const projectPath = requireWorkspace();
      if (!projectPath) return;

      const apiKey = await context.secrets.get(API_KEY_SECRET);
      if (!apiKey) return;

      if (!isInitialized(projectPath)) {
        const action = await vscode.window.showInformationMessage(
          "smartctx: This project isn't indexed. Index it now? (approx. $0.0004/file)",
          "Yes", "Later"
        );
        if (action !== "Yes") return;

        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: "smartctx: indexing project" },
          async (progress) => {
            const result = await runInit(projectPath, apiKey, (current, total, filePath) => {
              progress.report({
                message: `[${current}/${total}] ${filePath}`,
                increment: (1 / total) * 100,
              });
            });
            vscode.window.showInformationMessage(
              `smartctx: indexed ${result.filesIndexed} files (~$${result.costUSD.toFixed(4)}).`
            );
          }
        );
        provider.refresh();
      } else {
        const status = getStatus(projectPath);
        if (status.initialized) {
          const lastSync = new Date(status.lastSync).getTime();
          const ageMin = (Date.now() - lastSync) / 60000;
          if (ageMin > 5) {
            const action = await vscode.window.showInformationMessage(
              `smartctx: Index is stale (${Math.round(ageMin)} min old). Sync now?`,
              "Yes", "Later"
            );
            if (action !== "Yes") return;

            await vscode.window.withProgress(
              { location: vscode.ProgressLocation.Notification, title: "smartctx: syncing" },
              async (progress) => {
                const result = await runSync(projectPath, apiKey, (current, total, filePath) => {
                  progress.report({
                    message: `[${current}/${total}] ${filePath}`,
                    increment: (1 / total) * 100,
                  });
                });
                vscode.window.showInformationMessage(
                  `smartctx: +${result.added} new, ~${result.changed} changed, -${result.removed} deleted.`
                );
              }
            );
            provider.refresh();
          }
        }
      }
    } catch {
      // Silently ignore — don't block VS Code startup
    }
  }, 3000);
}

export { API_KEY_SECRET };
export { getStatus };
