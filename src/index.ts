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
  .version("0.2.0");

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

// ─── Run ──────────────────────────────────────────────────────────────────────

program.parse(process.argv);
