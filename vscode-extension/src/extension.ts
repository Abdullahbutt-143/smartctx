import * as vscode from "vscode";
import { SmartctxSidebarProvider } from "./sidebar";
import { runInit, runSync, runQuery, getStatus, Target } from "./core";

const API_KEY_SECRET = "smartctx.anthropicApiKey";

export function activate(context: vscode.ExtensionContext) {
  const provider = new SmartctxSidebarProvider(context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("smartctx.sidebar", provider)
  );

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
}

export function deactivate() {}

function requireWorkspace(): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    vscode.window.showErrorMessage("smartctx: open a folder first.");
    return undefined;
  }
  return folders[0].uri.fsPath;
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

export { API_KEY_SECRET };
export { getStatus };
