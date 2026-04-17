// Thin wrappers around the smartctx core modules so the extension doesn't
// need to know anything about the CLI. We import directly from ../../src/
// and esbuild bundles everything into dist/extension.js.

import {
  loadGlobalConfig,
  saveGlobalConfig,
  loadIndex,
  saveIndex,
  createEmptyIndex,
  isInitialized,
  ProjectIndex,
} from "../../src/storage.js";
import { scanProject, getChangedFiles, ScannedFile } from "../../src/scanner.js";
import { summarizeFiles, estimateCost } from "../../src/summarizer.js";
import { queryIndex, QueryResult } from "../../src/query.js";
import {
  generateContextFile,
  estimateTokensSaved,
  Target,
} from "../../src/generator.js";

export type { ProjectIndex, QueryResult, Target, ScannedFile };
export {
  loadGlobalConfig,
  saveGlobalConfig,
  loadIndex,
  saveIndex,
  createEmptyIndex,
  isInitialized,
  scanProject,
  getChangedFiles,
  summarizeFiles,
  estimateCost,
  queryIndex,
  generateContextFile,
  estimateTokensSaved,
};

export interface ProgressReporter {
  (current: number, total: number, filePath: string): void;
}

export async function runInit(
  projectPath: string,
  apiKey: string,
  onProgress?: ProgressReporter
): Promise<{ filesIndexed: number; costUSD: number }> {
  const config = { ...loadGlobalConfig(), apiKey };
  const files = await scanProject(projectPath, config);
  const { estimatedCostUSD } = estimateCost(files);

  const summaries = await summarizeFiles(files, apiKey, onProgress);

  const index = createEmptyIndex(projectPath);
  for (const summary of summaries) {
    index.files[summary.path] = summary;
  }
  index.totalFiles = summaries.length;
  index.lastSync = new Date().toISOString();
  saveIndex(index, projectPath);

  return { filesIndexed: summaries.length, costUSD: estimatedCostUSD };
}

export async function runSync(
  projectPath: string,
  apiKey: string,
  onProgress?: ProgressReporter
): Promise<{ added: number; changed: number; removed: number }> {
  const index = loadIndex(projectPath);
  if (!index) throw new Error("Project not initialized");

  const config = { ...loadGlobalConfig(), apiKey };
  const allFiles = await scanProject(projectPath, config);
  const changes = getChangedFiles(allFiles, index.files);

  for (const deletedPath of changes.deleted) {
    delete index.files[deletedPath];
  }

  const toProcess = [...changes.new, ...changes.changed];
  if (toProcess.length > 0) {
    const summaries = await summarizeFiles(toProcess, apiKey, onProgress);
    for (const s of summaries) {
      index.files[s.path] = s;
    }
  }

  index.totalFiles = Object.keys(index.files).length;
  index.lastSync = new Date().toISOString();
  saveIndex(index, projectPath);

  return {
    added: changes.new.length,
    changed: changes.changed.length,
    removed: changes.deleted.length,
  };
}

export interface QueryRunResult {
  outputPath: string;
  target: Target;
  results: QueryResult[];
  tokensSaved: number;
}

export function runQuery(
  projectPath: string,
  task: string,
  target: Target,
  topK: number
): QueryRunResult | null {
  const index = loadIndex(projectPath);
  if (!index) throw new Error("Project not initialized");

  const results = queryIndex(index, task, topK);
  if (results.length === 0) return null;

  const outputPath = generateContextFile(index, results, task, target, projectPath);

  const avgSize =
    index.totalFiles === 0
      ? 0
      : Object.values(index.files).reduce((sum, f) => sum + f.size, 0) /
        index.totalFiles;
  const tokensSaved = estimateTokensSaved(index.totalFiles, avgSize, results.length);

  return { outputPath, target, results, tokensSaved };
}

export function getStatus(projectPath: string) {
  if (!isInitialized(projectPath)) {
    return { initialized: false as const };
  }
  const index = loadIndex(projectPath)!;
  return {
    initialized: true as const,
    projectName: index.projectName,
    totalFiles: index.totalFiles,
    lastSync: index.lastSync,
  };
}
