import fs from "fs";
import path from "path";
import os from "os";
import dotenv from "dotenv";

// Auto-load .env from current working directory
dotenv.config({ path: path.join(process.cwd(), ".env") });
// Also try parent directories (in case you're in a subfolder)
dotenv.config({ path: path.join(process.cwd(), "..", ".env") });

// ─── Types ───────────────────────────────────────────────────────────────────

export interface FileSummary {
  path: string;
  summary: string;
  exports: string[];
  dependencies: string[];
  tags: string[];
  lastModified: number;
  size: number;
  extension: string;
}

export interface ProjectIndex {
  version: string;
  projectName: string;
  projectPath: string;
  createdAt: string;
  lastSync: string;
  totalFiles: number;
  totalTokensSaved: number;
  files: Record<string, FileSummary>;
}

export interface GlobalConfig {
  apiKey?: string;
  defaultTarget: string;
  syncSchedule: "daily" | "weekly" | "manual";
  maxFileSizeKB: number;
  excludePatterns: string[];
}

// ─── Paths ───────────────────────────────────────────────────────────────────

export const LOCAL_CTX_DIR = ".smartctx";
export const GLOBAL_CONFIG_DIR = path.join(os.homedir(), ".smartctx");
export const GLOBAL_CONFIG_FILE = path.join(GLOBAL_CONFIG_DIR, "config.json");

export function getLocalCtxDir(projectPath: string = process.cwd()): string {
  return path.join(projectPath, LOCAL_CTX_DIR);
}

export function getIndexPath(projectPath: string = process.cwd()): string {
  return path.join(getLocalCtxDir(projectPath), "index.json");
}

// ─── Global Config ───────────────────────────────────────────────────────────

export function loadGlobalConfig(): GlobalConfig {
  const defaults: GlobalConfig = {
    defaultTarget: "claude",
    syncSchedule: "daily",
    maxFileSizeKB: 100,
    excludePatterns: [
      "node_modules",
      ".git",
      "dist",
      "build",
      ".next",
      "__pycache__",
      "*.lock",
      "*.log",
      ".env*",
    ],
  };

  let saved: Partial<GlobalConfig> = {};
  if (fs.existsSync(GLOBAL_CONFIG_FILE)) {
    try {
      const raw = fs.readFileSync(GLOBAL_CONFIG_FILE, "utf-8");
      saved = JSON.parse(raw);
    } catch {}
  }

  // Auto-read API key from environment variables
  // Checks: .env file, Claude Code env, system env
  // Priority: env variable > saved config
  const envKey =
    process.env.ANTHROPIC_API_KEY ||
    process.env.CLAUDE_API_KEY ||
    process.env.CLAUDE_CODE_API_KEY;

  return {
    ...defaults,
    ...saved,
    ...(envKey ? { apiKey: envKey } : {}), // env always wins
  };
}

export function saveGlobalConfig(config: Partial<GlobalConfig>): void {
  if (!fs.existsSync(GLOBAL_CONFIG_DIR)) {
    fs.mkdirSync(GLOBAL_CONFIG_DIR, { recursive: true });
  }
  const existing = loadGlobalConfig();
  const merged = { ...existing, ...config };
  fs.writeFileSync(GLOBAL_CONFIG_FILE, JSON.stringify(merged, null, 2));
}

// ─── Project Index ────────────────────────────────────────────────────────────

export function loadIndex(projectPath: string = process.cwd()): ProjectIndex | null {
  const indexPath = getIndexPath(projectPath);
  if (!fs.existsSync(indexPath)) return null;

  try {
    const raw = fs.readFileSync(indexPath, "utf-8");
    return JSON.parse(raw) as ProjectIndex;
  } catch {
    return null;
  }
}

export function saveIndex(index: ProjectIndex, projectPath: string = process.cwd()): void {
  const ctxDir = getLocalCtxDir(projectPath);
  if (!fs.existsSync(ctxDir)) {
    fs.mkdirSync(ctxDir, { recursive: true });
  }
  fs.writeFileSync(getIndexPath(projectPath), JSON.stringify(index, null, 2));
}

export function createEmptyIndex(projectPath: string = process.cwd()): ProjectIndex {
  return {
    version: "0.1.0",
    projectName: path.basename(projectPath),
    projectPath,
    createdAt: new Date().toISOString(),
    lastSync: new Date().toISOString(),
    totalFiles: 0,
    totalTokensSaved: 0,
    files: {},
  };
}

export function isInitialized(projectPath: string = process.cwd()): boolean {
  return fs.existsSync(getIndexPath(projectPath));
}
