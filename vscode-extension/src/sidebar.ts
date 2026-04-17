import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { getStatus, runInit, runSync, runQuery, Target } from "./core";
import { API_KEY_SECRET } from "./extension";

interface WebviewMessage {
  type: string;
  [key: string]: unknown;
}

export class SmartctxSidebarProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;

  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")],
    };
    webviewView.webview.html = this.renderHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((msg: WebviewMessage) =>
      this.handleMessage(msg)
    );

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) this.postStatus();
    });

    this.postStatus();
  }

  refresh() {
    this.postStatus();
  }

  private async handleMessage(msg: WebviewMessage) {
    switch (msg.type) {
      case "ready":
        this.postStatus();
        return;
      case "setApiKey": {
        const key = String(msg.key ?? "");
        if (!key) return;
        await this.context.secrets.store(API_KEY_SECRET, key);
        this.post({ type: "toast", level: "info", text: "API key saved." });
        this.postStatus();
        return;
      }
      case "init": {
        const projectPath = this.workspace();
        if (!projectPath) return;
        const apiKey = await this.context.secrets.get(API_KEY_SECRET);
        if (!apiKey) {
          this.post({ type: "toast", level: "error", text: "Set your API key first." });
          return;
        }
        this.post({ type: "busy", value: true, label: "Indexing…" });
        try {
          const res = await runInit(projectPath, apiKey, (c, t, f) =>
            this.post({ type: "progress", current: c, total: t, file: f })
          );
          this.post({
            type: "toast",
            level: "info",
            text: `Indexed ${res.filesIndexed} files (~$${res.costUSD.toFixed(4)}).`,
          });
        } catch (e: any) {
          this.post({ type: "toast", level: "error", text: e.message });
        } finally {
          this.post({ type: "busy", value: false });
          this.postStatus();
        }
        return;
      }
      case "sync": {
        const projectPath = this.workspace();
        if (!projectPath) return;
        const apiKey = await this.context.secrets.get(API_KEY_SECRET);
        if (!apiKey) {
          this.post({ type: "toast", level: "error", text: "Set your API key first." });
          return;
        }
        this.post({ type: "busy", value: true, label: "Syncing…" });
        try {
          const res = await runSync(projectPath, apiKey, (c, t, f) =>
            this.post({ type: "progress", current: c, total: t, file: f })
          );
          this.post({
            type: "toast",
            level: "info",
            text: `+${res.added} new, ~${res.changed} changed, -${res.removed} removed.`,
          });
        } catch (e: any) {
          this.post({ type: "toast", level: "error", text: e.message });
        } finally {
          this.post({ type: "busy", value: false });
          this.postStatus();
        }
        return;
      }
      case "query": {
        const projectPath = this.workspace();
        if (!projectPath) return;
        const task = String(msg.task ?? "").trim();
        if (!task) return;
        const target = (msg.target as Target) ?? "claude";
        const topK = Number(msg.topK ?? 10);

        try {
          const result = runQuery(projectPath, task, target, topK);
          if (!result) {
            this.post({ type: "toast", level: "warn", text: "No matching files found." });
            this.post({ type: "queryResult", results: [], outputPath: null });
            return;
          }
          this.post({
            type: "queryResult",
            outputPath: result.outputPath,
            tokensSaved: result.tokensSaved,
            target: result.target,
            results: result.results.map((r) => ({
              path: r.file.path,
              summary: r.file.summary,
              score: r.score,
            })),
          });
        } catch (e: any) {
          this.post({ type: "toast", level: "error", text: e.message });
        }
        return;
      }
      case "openFile": {
        const p = String(msg.path ?? "");
        if (!p) return;
        const abs = path.isAbsolute(p) ? p : path.join(this.workspace() ?? "", p);
        if (!fs.existsSync(abs)) {
          this.post({ type: "toast", level: "warn", text: "File not found." });
          return;
        }
        const doc = await vscode.workspace.openTextDocument(abs);
        await vscode.window.showTextDocument(doc, { preview: true });
        return;
      }
    }
  }

  private async postStatus() {
    const projectPath = this.workspace();
    const hasKey = Boolean(await this.context.secrets.get(API_KEY_SECRET));
    const cfg = vscode.workspace.getConfiguration("smartctx");
    this.post({
      type: "status",
      hasWorkspace: Boolean(projectPath),
      hasKey,
      status: projectPath ? getStatus(projectPath) : { initialized: false },
      target: cfg.get<Target>("defaultTarget", "claude"),
      topK: cfg.get<number>("topK", 10),
    });
  }

  private workspace(): string | undefined {
    const folders = vscode.workspace.workspaceFolders;
    return folders && folders.length > 0 ? folders[0].uri.fsPath : undefined;
  }

  private post(msg: Record<string, unknown>) {
    this.view?.webview.postMessage(msg);
  }

  private renderHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "main.js")
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "main.css")
    );
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} https: data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
    ].join("; ");

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>smartctx</title>
</head>
<body>
  <header>
    <h2>smartctx</h2>
    <p class="muted">Smart context for AI coding assistants</p>
  </header>

  <section id="apikey-section" hidden>
    <label>Anthropic API key</label>
    <div class="row">
      <input id="apiKey" type="password" placeholder="sk-ant-..." />
      <button id="saveKey" class="primary">Save</button>
    </div>
  </section>

  <section id="status-section">
    <div class="card">
      <div class="card-row"><span class="muted">Project</span><span id="projectName">—</span></div>
      <div class="card-row"><span class="muted">Files indexed</span><span id="fileCount">—</span></div>
      <div class="card-row"><span class="muted">Last sync</span><span id="lastSync">—</span></div>
      <div class="card-row"><span class="muted">API key</span><span id="keyState">—</span></div>
    </div>
  </section>

  <section class="actions">
    <button id="btnInit">Initialize</button>
    <button id="btnSync">Sync changes</button>
  </section>

  <section id="query-section">
    <label>Task</label>
    <textarea id="task" placeholder="e.g. add authentication middleware" rows="3"></textarea>
    <div class="row">
      <select id="target">
        <option value="claude">Claude</option>
        <option value="cursor">Cursor</option>
        <option value="copilot">Copilot</option>
        <option value="codex">Codex</option>
      </select>
      <input id="topK" type="number" min="1" max="50" value="10" />
      <button id="btnQuery" class="primary">Query</button>
    </div>
  </section>

  <section id="results" hidden>
    <div class="muted" id="results-meta"></div>
    <ul id="results-list"></ul>
    <button id="openOutput" hidden>Open context file</button>
  </section>

  <div id="busy" hidden>
    <div class="spinner"></div>
    <div id="busy-label">Working…</div>
    <div id="busy-progress" class="muted"></div>
  </div>

  <div id="toast" hidden></div>

  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 32; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
  return out;
}
