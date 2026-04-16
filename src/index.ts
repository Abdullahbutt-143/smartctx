#!/usr/bin/env node

import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import path from "path";
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
import { generateContextFile, estimateTokensSaved, Target } from "./generator.js";

const program = new Command();

// ─── CLI Setup ────────────────────────────────────────────────────────────────

program
  .name("smartctx")
  .description(
    "Smart context manager for AI coding assistants — saves tokens, builds local memory"
  )
  .version("0.1.0");

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

    // Save API key if provided
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

    // Scan
    const scanSpinner = ora("Scanning project files...").start();
    const files = await scanProject(projectPath, config);
    scanSpinner.succeed(`Found ${chalk.bold(files.length)} files to index`);

    // Estimate cost
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

    // Summarize
    console.log(chalk.cyan("\nSummarizing files with Claude Haiku (cheapest model)...\n"));
    const index = createEmptyIndex(projectPath);

    const summaries = await summarizeFiles(files, config.apiKey, (current, total, filePath) => {
      process.stdout.write(
        `\r  ${chalk.green(`[${current}/${total}]`)} ${chalk.gray(filePath.slice(0, 50).padEnd(50))}`
      );
    });

    console.log("\n");

    // Save to index
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

    // Remove deleted files
    for (const deletedPath of changes.deleted) {
      delete index.files[deletedPath];
    }

    // Re-summarize new/changed files
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
  .option("--for <target>", "Target AI tool: claude, cursor, copilot, codex", "claude")
  .option("--top <n>", "Number of files to include", "10")
  .action(async (task: string, options) => {
    console.log(chalk.cyan.bold("\n🔍 smartctx query\n"));

    const projectPath = process.cwd();

    if (!isInitialized(projectPath)) {
      console.log(chalk.red("✗ Not initialized. Run: smartctx init\n"));
      process.exit(1);
    }

    const index = loadIndex(projectPath)!;
    const topK = parseInt(options.top, 10);
    const target = options.for as Target;

    // Query locally (zero API cost)
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

    // Generate context file
    const outputPath = generateContextFile(index, results, task, target, projectPath);

    // Estimate savings
    const avgSize = Object.values(index.files).reduce((sum, f) => sum + f.size, 0) / index.totalFiles;
    const saved = estimateTokensSaved(index.totalFiles, avgSize, results.length);

    console.log(`\n${chalk.green.bold("✓ Context file generated:")} ${chalk.white(outputPath)}`);
    console.log(chalk.gray(`  ~${saved.toLocaleString()} tokens saved vs reading full project\n`));
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
  .option("--target <target>", "Default target: claude, cursor, copilot, codex")
  .option("--schedule <schedule>", "Sync schedule: daily, weekly, manual")
  .action((options) => {
    const updates: Record<string, string> = {};

    if (options.apiKey) updates.apiKey = options.apiKey;
    if (options.target) updates.defaultTarget = options.target;
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

// ─── Run ──────────────────────────────────────────────────────────────────────

program.parse(process.argv);
