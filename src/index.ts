#!/usr/bin/env node

import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import {
  loadGlobalConfig,
  saveGlobalConfig,
  loadIndex,
  saveIndex,
  createEmptyIndex,
  isInitialized,
} from "./storage.js";
import { scanProject, getChangedFiles } from "./scanner.js";
import { summarizeFiles, estimateCost } from "./summarizer.js";
import { queryIndex } from "./query.js";
import {
  generateContextFiles,
  estimateTokensSaved,
} from "./generator.js";
import {
  getTarget,
  parseTargets,
  detectTarget,
  addUserTarget,
  removeUserTarget,
  BUILT_IN_TARGETS,
  loadUserTargets,
} from "./targets.js";

const program = new Command();

// ─── CLI Setup ────────────────────────────────────────────────────────────────

program
  .name("smartctx")
  .description(
    "Smart context manager for AI coding assistants — saves tokens, builds local memory"
  )
  .version("0.3.0");

// ─── INIT ─────────────────────────────────────────────────────────────────────

program
  .command("init")
  .description("Initialize smartctx for this project — scans and summarizes all files")
  .option("--api-key <key>", "Your Anthropic API key (saved globally)")
  .option("--dry-run", "Show what would be scanned without calling the API")
  .action(async (options) => {
    console.log(chalk.cyan.bold("\n🧠 smartctx init\n"));

    const projectPath = process.cwd();
    const config = loadGlobalConfig();

    if (options.apiKey) {
      saveGlobalConfig({ apiKey: options.apiKey });
      config.apiKey = options.apiKey;
      console.log(chalk.green("✓ API key saved globally\n"));
    }

    if (!config.apiKey) {
      console.log(
        chalk.red("✗ No API key found. Run with --api-key sk-ant-xxxxx\n") +
          chalk.gray("  Or set it once: smartctx config --api-key sk-ant-xxxxx\n")
      );
      process.exit(1);
    }

    if (isInitialized(projectPath)) {
      console.log(
        chalk.yellow("⚠ Already initialized. Run ") +
          chalk.white("smartctx sync") +
          chalk.yellow(" to update.\n")
      );
      process.exit(0);
    }

    const scanSpinner = ora("Scanning project files...").start();
    const files = await scanProject(projectPath, config);
    scanSpinner.succeed(`Found ${chalk.bold(files.length)} files to index`);

    const { estimatedCostUSD } = estimateCost(files);
    console.log(
      chalk.gray(
        `  Estimated one-time cost: ~$${estimatedCostUSD.toFixed(4)} (using Claude Haiku)\n`
      )
    );

    if (options.dryRun) {
      console.log(chalk.cyan("\nFiles that would be indexed:"));
      files.forEach((f) => console.log(chalk.gray(`  ${f.path}`)));
      console.log(chalk.cyan("\n[Dry run — no API calls made]"));
      return;
    }

    console.log(chalk.cyan("\nSummarizing files with Claude Haiku (cheapest model)...\n"));
    const index = createEmptyIndex(projectPath);

    const summaries = await summarizeFiles(files, config.apiKey, (current, total, filePath) => {
      process.stdout.write(
        `\r  ${chalk.green(`[${current}/${total}]`)} ${chalk.gray(filePath.slice(0, 50).padEnd(50))}`
      );
    });

    console.log("\n");

    for (const summary of summaries) {
      index.files[summary.path] = summary;
    }
    index.totalFiles = summaries.length;
    index.lastSync = new Date().toISOString();
    saveIndex(index, projectPath);

    console.log(chalk.green.bold("✓ smartctx initialized!\n"));
    console.log(chalk.gray(`  Index saved to .smartctx/index.json`));
    console.log(chalk.gray(`  Run: smartctx query "your task description"\n`));
  });

// ─── SYNC ─────────────────────────────────────────────────────────────────────

program
  .command("sync")
  .description("Re-summarize only changed files (fast & cheap)")
  .action(async () => {
    console.log(chalk.cyan.bold("\n🔄 smartctx sync\n"));

    const projectPath = process.cwd();
    const config = loadGlobalConfig();

    if (!isInitialized(projectPath)) {
      console.log(chalk.red("✗ Not initialized. Run: smartctx init\n"));
      process.exit(1);
    }

    if (!config.apiKey) {
      console.log(chalk.red("✗ No API key. Run: smartctx config --api-key sk-ant-xxxxx\n"));
      process.exit(1);
    }

    const index = loadIndex(projectPath)!;

    const scanSpinner = ora("Scanning for changes...").start();
    const allFiles = await scanProject(projectPath, config);
    const changes = getChangedFiles(allFiles, index.files);
    scanSpinner.succeed(
      `${chalk.green(changes.new.length)} new, ${chalk.yellow(changes.changed.length)} changed, ${chalk.red(changes.deleted.length)} deleted`
    );

    const toProcess = [...changes.new, ...changes.changed];

    if (toProcess.length === 0 && changes.deleted.length === 0) {
      console.log(chalk.green("\n✓ Everything up to date!\n"));
      return;
    }

    for (const deletedPath of changes.deleted) {
      delete index.files[deletedPath];
    }

    if (toProcess.length > 0) {
      console.log(chalk.cyan(`\nSummarizing ${toProcess.length} files...\n`));
      const summaries = await summarizeFiles(toProcess, config.apiKey, (current, total, filePath) => {
        process.stdout.write(
          `\r  ${chalk.green(`[${current}/${total}]`)} ${chalk.gray(filePath.slice(0, 50).padEnd(50))}`
        );
      });
      console.log("\n");
      for (const s of summaries) {
        index.files[s.path] = s;
      }
    }

    index.totalFiles = Object.keys(index.files).length;
    index.lastSync = new Date().toISOString();
    saveIndex(index, projectPath);

    console.log(chalk.green.bold("✓ Sync complete!\n"));
  });

// ─── QUERY ────────────────────────────────────────────────────────────────────

program
  .command("query <task>")
  .description('Find relevant files and generate context — e.g. smartctx query "add auth"')
  .option(
    "--for <targets>",
    "Comma-separated AI tools (claude,cursor,copilot,codex,windsurf,cline,aider,continue,gemini,zed, or custom). Auto-detected if omitted."
  )
  .option("--top <n>", "Number of files to include", "10")
  .action(async (task: string, options) => {
    console.log(chalk.cyan.bold("\n🔍 smartctx query\n"));

    const projectPath = process.cwd();

    if (!isInitialized(projectPath)) {
      console.log(chalk.red("✗ Not initialized. Run: smartctx init\n"));
      process.exit(1);
    }

    const index = loadIndex(projectPath)!;
    const config = loadGlobalConfig();
    const topK = parseInt(options.top, 10);

    let targets: string[];
    if (options.for) {
      targets = parseTargets(options.for);
    } else {
      const detected = detectTarget(projectPath);
      if (detected) {
        targets = [detected];
        console.log(chalk.gray(`  Auto-detected target: ${chalk.white(detected)}\n`));
      } else {
        targets = [config.defaultTarget || "codex"];
        console.log(chalk.gray(`  Using default target: ${chalk.white(targets[0])}\n`));
      }
    }

    for (const t of targets) {
      if (!getTarget(t)) {
        console.log(
          chalk.red(`✗ Unknown target "${t}". Run: smartctx targets list\n`)
        );
        process.exit(1);
      }
    }

    const results = queryIndex(index, task, topK);

    if (results.length === 0) {
      console.log(chalk.yellow("No matching files found. Try different keywords.\n"));
      return;
    }

    console.log(chalk.green(`Found ${results.length} relevant files:\n`));
    results.forEach((r, i) => {
      console.log(
        `  ${chalk.bold(`${i + 1}.`)} ${chalk.cyan(r.file.path)} ${chalk.gray(`(score: ${r.score.toFixed(1)})`)}`
      );
      console.log(chalk.gray(`     ${r.file.summary}`));
    });

    const generated = generateContextFiles(index, results, task, targets, projectPath);

    const avgSize =
      Object.values(index.files).reduce((sum, f) => sum + f.size, 0) / index.totalFiles;
    const saved = estimateTokensSaved(index.totalFiles, avgSize, results.length);

    console.log(`\n${chalk.green.bold("✓ Context files generated:")}`);
    for (const g of generated) {
      console.log(`  ${chalk.white(g.outputPath)} ${chalk.gray(`(${g.target})`)}`);
    }
    console.log(chalk.gray(`\n  ~${saved.toLocaleString()} tokens saved vs reading full project\n`));
  });

// ─── STATUS ───────────────────────────────────────────────────────────────────

program
  .command("status")
  .description("Show index stats for this project")
  .action(() => {
    const projectPath = process.cwd();

    if (!isInitialized(projectPath)) {
      console.log(chalk.red("\n✗ Not initialized. Run: smartctx init\n"));
      process.exit(1);
    }

    const index = loadIndex(projectPath)!;
    const config = loadGlobalConfig();

    console.log(chalk.cyan.bold("\n📊 smartctx status\n"));
    console.log(`  Project:    ${chalk.white(index.projectName)}`);
    console.log(`  Files:      ${chalk.white(index.totalFiles)}`);
    console.log(`  Last sync:  ${chalk.white(new Date(index.lastSync).toLocaleString())}`);
    console.log(`  API key:    ${config.apiKey ? chalk.green("✓ set") : chalk.red("✗ not set")}`);
    console.log(`  Target:     ${chalk.white(config.defaultTarget)}`);
    console.log(`  Schedule:   ${chalk.white(config.syncSchedule)}\n`);
  });

// ─── CONFIG ───────────────────────────────────────────────────────────────────

program
  .command("config")
  .description("Set global configuration")
  .option("--api-key <key>", "Set your Anthropic API key")
  .option("--target <target>", "Default target (any registered target name)")
  .option("--schedule <schedule>", "Sync schedule: daily, weekly, manual")
  .action((options) => {
    const updates: Record<string, string> = {};

    if (options.apiKey) updates.apiKey = options.apiKey;
    if (options.target) {
      if (!getTarget(options.target)) {
        console.log(
          chalk.red(`\n✗ Unknown target "${options.target}". Run: smartctx targets list\n`)
        );
        process.exit(1);
      }
      updates.defaultTarget = options.target;
    }
    if (options.schedule) updates.syncSchedule = options.schedule;

    if (Object.keys(updates).length === 0) {
      const config = loadGlobalConfig();
      console.log(chalk.cyan.bold("\n⚙ smartctx config\n"));
      console.log(JSON.stringify(config, null, 2));
      console.log();
      return;
    }

    saveGlobalConfig(updates as any);
    console.log(chalk.green("\n✓ Config updated!\n"));
    Object.entries(updates).forEach(([k, v]) => {
      const display = k === "apiKey" ? v.slice(0, 10) + "..." : v;
      console.log(chalk.gray(`  ${k}: ${display}`));
    });
    console.log();
  });

// ─── TARGETS ──────────────────────────────────────────────────────────────────

const targetsCmd = program
  .command("targets")
  .description("Manage AI tool targets (list, add, remove custom targets)");

targetsCmd
  .command("list")
  .description("List all available targets (built-in + user-defined)")
  .action(() => {
    console.log(chalk.cyan.bold("\n🎯 smartctx targets\n"));

    const builtIn = Object.values(BUILT_IN_TARGETS);
    const user = Object.values(loadUserTargets());

    console.log(chalk.white.bold("Built-in:"));
    for (const t of builtIn) {
      console.log(
        `  ${chalk.green(t.name.padEnd(12))} → ${chalk.gray(t.outputFile)}`
      );
    }

    if (user.length > 0) {
      console.log(chalk.white.bold("\nUser-defined:"));
      for (const t of user) {
        console.log(
          `  ${chalk.magenta(t.name.padEnd(12))} → ${chalk.gray(t.outputFile)}`
        );
      }
    }
    console.log();
  });

targetsCmd
  .command("add")
  .description("Register a custom target")
  .requiredOption("--name <name>", "Target name (e.g. myagent)")
  .requiredOption("--file <path>", "Output file path (e.g. MYAGENT.md)")
  .option("--header <text>", "Header comment for the output file")
  .option(
    "--detect <files>",
    "Comma-separated marker files for auto-detection"
  )
  .action((options) => {
    const name = String(options.name).toLowerCase();
    if (name in BUILT_IN_TARGETS) {
      console.log(
        chalk.yellow(`\n⚠ "${name}" is a built-in target — your definition will override it.\n`)
      );
    }
    addUserTarget({
      name,
      outputFile: options.file,
      header: options.header || `# ${name} — auto-generated by smartctx`,
      detectFiles: options.detect
        ? String(options.detect).split(",").map((s) => s.trim()).filter(Boolean)
        : undefined,
    });
    console.log(chalk.green(`\n✓ Target "${name}" added.\n`));
    console.log(chalk.gray(`  Use: smartctx query "..." --for ${name}\n`));
  });

targetsCmd
  .command("remove <name>")
  .description("Remove a user-defined target")
  .action((name: string) => {
    const ok = removeUserTarget(name);
    if (ok) {
      console.log(chalk.green(`\n✓ Target "${name}" removed.\n`));
    } else {
      console.log(
        chalk.yellow(`\n⚠ "${name}" is not a user-defined target (built-ins can't be removed).\n`)
      );
    }
  });

targetsCmd
  .command("detect")
  .description("Show which target would be auto-detected for this project")
  .action(() => {
    const detected = detectTarget(process.cwd());
    if (detected) {
      const def = getTarget(detected)!;
      console.log(chalk.green(`\n✓ Detected: ${chalk.white(detected)} → ${chalk.gray(def.outputFile)}\n`));
    } else {
      console.log(
        chalk.gray("\nNo marker files found. Would fall back to default target.\n")
      );
    }
  });

// ─── AUTO (silent init + sync + query for AI tool hooks) ─────────────────────

program
  .command("auto [task]")
  .description(
    "Silent mode for AI tool hooks — auto-inits, auto-syncs, and rewrites context. Reads task from arg or JSON stdin."
  )
  .option("--verbose", "Print progress (default: silent)")
  .option("--top <n>", "Number of files to include", "10")
  .option(
    "--for <targets>",
    "Comma-separated AI tools. Auto-detected if omitted."
  )
  .option("--max-stale <seconds>", "Skip sync if last sync was within N seconds", "300")
  .action(async (taskArg: string | undefined, options) => {
    const log = options.verbose
      ? (...args: unknown[]) => console.error(...args)
      : () => {};

    try {
      const task = taskArg || (await readStdinPrompt());
      if (!task || !task.trim()) {
        log(chalk.gray("smartctx auto: no task provided, skipping"));
        process.exit(0);
      }

      const projectPath = process.cwd();
      const config = loadGlobalConfig();

      if (!config.apiKey) {
        log(chalk.gray("smartctx auto: no API key, skipping silently"));
        process.exit(0);
      }

      if (!isInitialized(projectPath)) {
        log(chalk.cyan("smartctx auto: first run, initializing..."));
        const files = await scanProject(projectPath, config);
        const index = createEmptyIndex(projectPath);
        const summaries = await summarizeFiles(files, config.apiKey);
        for (const s of summaries) index.files[s.path] = s;
        index.totalFiles = summaries.length;
        index.lastSync = new Date().toISOString();
        saveIndex(index, projectPath);
        log(chalk.green(`smartctx auto: indexed ${summaries.length} files`));
      } else {
        const index = loadIndex(projectPath)!;
        const maxStale = parseInt(options.maxStale, 10) * 1000;
        const age = Date.now() - new Date(index.lastSync).getTime();
        if (age > maxStale) {
          log(chalk.cyan("smartctx auto: syncing changed files..."));
          const allFiles = await scanProject(projectPath, config);
          const changes = getChangedFiles(allFiles, index.files);
          const toProcess = [...changes.new, ...changes.changed];
          for (const d of changes.deleted) delete index.files[d];
          if (toProcess.length > 0) {
            const summaries = await summarizeFiles(toProcess, config.apiKey);
            for (const s of summaries) index.files[s.path] = s;
          }
          index.totalFiles = Object.keys(index.files).length;
          index.lastSync = new Date().toISOString();
          saveIndex(index, projectPath);
          log(chalk.green(`smartctx auto: synced (${toProcess.length} updated, ${changes.deleted.length} removed)`));
        }
      }

      const index = loadIndex(projectPath)!;
      const topK = parseInt(options.top, 10);

      let targets: string[];
      if (options.for) {
        targets = parseTargets(options.for);
      } else {
        const detected = detectTarget(projectPath);
        targets = detected ? [detected] : [config.defaultTarget || "claude"];
      }

      const results = queryIndex(index, task, topK);
      if (results.length === 0) {
        log(chalk.gray("smartctx auto: no relevant files found"));
        process.exit(0);
      }

      const generated = generateContextFiles(index, results, task, targets, projectPath);
      log(
        chalk.green(
          `smartctx auto: wrote ${generated.map((g) => g.outputPath).join(", ")}`
        )
      );
      process.exit(0);
    } catch (err) {
      // Never block the host AI tool — fail silently (log to stderr if verbose)
      log(chalk.red(`smartctx auto: ${(err as Error).message}`));
      process.exit(0);
    }
  });

async function readStdinPrompt(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf-8").trim();
  if (!raw) return "";
  try {
    const j = JSON.parse(raw);
    return j.prompt || j.user_prompt || j.task || j.query || "";
  } catch {
    return raw;
  }
}

// ─── INSTALL (wire smartctx auto into AI tool hooks) ──────────────────────────

program
  .command("install")
  .description(
    "Install smartctx into an AI tool so context auto-updates on every prompt"
  )
  .option(
    "--tool <tool>",
    "AI tool to integrate with: claude (default)",
    "claude"
  )
  .option("--scope <scope>", "Install scope: project or user", "project")
  .option("--uninstall", "Remove the hook instead of adding it")
  .action(async (options) => {
    console.log(chalk.cyan.bold("\n🔌 smartctx install\n"));
    const tool = String(options.tool).toLowerCase();
    if (tool !== "claude") {
      console.log(
        chalk.red(`✗ Tool "${tool}" not supported yet. Only --tool claude works.\n`) +
          chalk.gray("  For Cursor/Codex, run `smartctx query \"...\"` manually (see README).\n")
      );
      process.exit(1);
    }

    const fs = await import("fs");
    const os = await import("os");
    const path = await import("path");

    const settingsPath =
      options.scope === "user"
        ? path.join(os.homedir(), ".claude", "settings.json")
        : path.join(process.cwd(), ".claude", "settings.json");

    const dir = path.dirname(settingsPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    let settings: Record<string, any> = {};
    if (fs.existsSync(settingsPath)) {
      try {
        settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
      } catch {
        console.log(chalk.red(`✗ Could not parse ${settingsPath} — fix it first.\n`));
        process.exit(1);
      }
    }

    settings.hooks = settings.hooks || {};
    const existing: any[] = settings.hooks.UserPromptSubmit || [];
    const withoutOurs = existing.filter(
      (h: any) =>
        !(h?.hooks || []).some((x: any) =>
          typeof x?.command === "string" && x.command.includes("smartctx auto")
        )
    );

    if (options.uninstall) {
      settings.hooks.UserPromptSubmit = withoutOurs;
      if (settings.hooks.UserPromptSubmit.length === 0) delete settings.hooks.UserPromptSubmit;
      if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
      console.log(chalk.green(`✓ Removed smartctx hook from ${settingsPath}\n`));
      return;
    }

    settings.hooks.UserPromptSubmit = [
      ...withoutOurs,
      {
        hooks: [{ type: "command", command: "smartctx auto" }],
      },
    ];

    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    console.log(chalk.green(`✓ Installed smartctx UserPromptSubmit hook`));
    console.log(chalk.gray(`  ${settingsPath}\n`));
    console.log(chalk.white("What happens now:"));
    console.log(chalk.gray("  • Every prompt you send in Claude Code triggers `smartctx auto`"));
    console.log(chalk.gray("  • It silently (re)builds context and rewrites CLAUDE.md"));
    console.log(chalk.gray("  • Claude Code reads the fresh CLAUDE.md on the next turn"));
    console.log(chalk.gray("  • To remove: smartctx install --uninstall\n"));
  });

// ─── Run ──────────────────────────────────────────────────────────────────────

program.parse(process.argv);
