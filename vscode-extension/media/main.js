(function () {
  const vscode = acquireVsCodeApi();

  const $ = (id) => document.getElementById(id);

  const el = {
    apikeySection: $("apikey-section"),
    apiKey: $("apiKey"),
    saveKey: $("saveKey"),
    projectName: $("projectName"),
    fileCount: $("fileCount"),
    lastSync: $("lastSync"),
    keyState: $("keyState"),
    btnInit: $("btnInit"),
    btnSync: $("btnSync"),
    task: $("task"),
    target: $("target"),
    topK: $("topK"),
    btnQuery: $("btnQuery"),
    results: $("results"),
    resultsMeta: $("results-meta"),
    resultsList: $("results-list"),
    openOutput: $("openOutput"),
    busy: $("busy"),
    busyLabel: $("busy-label"),
    busyProgress: $("busy-progress"),
    toast: $("toast"),
  };

  let lastOutputPath = null;
  let toastTimer = null;

  el.saveKey.addEventListener("click", () => {
    const key = el.apiKey.value.trim();
    if (!key) return;
    vscode.postMessage({ type: "setApiKey", key });
    el.apiKey.value = "";
  });

  el.btnInit.addEventListener("click", () => vscode.postMessage({ type: "init" }));
  el.btnSync.addEventListener("click", () => vscode.postMessage({ type: "sync" }));

  el.btnQuery.addEventListener("click", () => {
    const task = el.task.value.trim();
    if (!task) {
      showToast("Enter a task description first.", "warn");
      return;
    }
    vscode.postMessage({
      type: "query",
      task,
      target: el.target.value,
      topK: Number(el.topK.value) || 10,
    });
  });

  el.openOutput.addEventListener("click", () => {
    if (lastOutputPath) vscode.postMessage({ type: "openFile", path: lastOutputPath });
  });

  window.addEventListener("message", (event) => {
    const msg = event.data;
    switch (msg.type) {
      case "status":
        renderStatus(msg);
        break;
      case "busy":
        setBusy(msg.value, msg.label);
        break;
      case "progress":
        el.busyProgress.textContent = `[${msg.current}/${msg.total}] ${msg.file}`;
        break;
      case "queryResult":
        renderResults(msg);
        break;
      case "toast":
        showToast(msg.text, msg.level);
        break;
    }
  });

  function renderStatus(msg) {
    const hasKey = Boolean(msg.hasKey);
    el.apikeySection.hidden = hasKey;
    el.keyState.textContent = hasKey ? "✓ set" : "not set";

    if (!msg.hasWorkspace) {
      el.projectName.textContent = "(open a folder)";
      el.fileCount.textContent = "—";
      el.lastSync.textContent = "—";
      disable(true);
      return;
    }

    const s = msg.status;
    if (!s.initialized) {
      el.projectName.textContent = "(not initialized)";
      el.fileCount.textContent = "0";
      el.lastSync.textContent = "—";
      el.btnSync.disabled = true;
      el.btnQuery.disabled = true;
      el.btnInit.disabled = !hasKey;
    } else {
      el.projectName.textContent = s.projectName;
      el.fileCount.textContent = String(s.totalFiles);
      el.lastSync.textContent = new Date(s.lastSync).toLocaleString();
      el.btnInit.disabled = false;
      el.btnSync.disabled = !hasKey;
      el.btnQuery.disabled = false;
    }

    if (msg.target) el.target.value = msg.target;
    if (msg.topK) el.topK.value = String(msg.topK);
  }

  function renderResults(msg) {
    if (!msg.results || msg.results.length === 0) {
      el.results.hidden = true;
      return;
    }
    el.results.hidden = false;
    el.resultsList.innerHTML = "";
    for (const r of msg.results) {
      const li = document.createElement("li");
      li.innerHTML = `<div class="path"></div><div class="summary"></div>`;
      li.querySelector(".path").textContent = r.path;
      li.querySelector(".summary").textContent = r.summary;
      li.addEventListener("click", () =>
        vscode.postMessage({ type: "openFile", path: r.path })
      );
      el.resultsList.appendChild(li);
    }
    lastOutputPath = msg.outputPath;
    el.openOutput.hidden = !lastOutputPath;
    const saved = typeof msg.tokensSaved === "number" ? msg.tokensSaved.toLocaleString() : "—";
    el.resultsMeta.textContent = `${msg.results.length} files • ${msg.target} • ~${saved} tokens saved`;
  }

  function setBusy(on, label) {
    el.busy.hidden = !on;
    if (label) el.busyLabel.textContent = label;
    if (!on) el.busyProgress.textContent = "";
    [el.btnInit, el.btnSync, el.btnQuery].forEach((b) => (b.disabled = on));
  }

  function disable(on) {
    [el.btnInit, el.btnSync, el.btnQuery].forEach((b) => (b.disabled = on));
  }

  function showToast(text, level) {
    el.toast.textContent = text;
    el.toast.className = level || "";
    el.toast.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.toast.hidden = true;
    }, 4000);
  }

  vscode.postMessage({ type: "ready" });
})();
