import fs from "fs";
import path from "path";
import { glob } from "glob";
import ignore from "ignore";
import { GlobalConfig } from "./storage.js";

export interface ScannedFile {
  path: string;
  absolutePath: string;
  extension: string;
  size: number;
  lastModified: number;
  content: string;
}

const SUPPORTED_EXTENSIONS = new Set([
  ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs",
  ".py", ".pyw",
  ".html", ".css", ".scss", ".sass",
  ".json", ".yaml", ".yml", ".toml",
  ".md", ".mdx",
  ".go", ".rs", ".java", ".c", ".cpp", ".h", ".cs", ".rb", ".php",
  ".sh", ".bash", ".zsh",
]);

// Excluded AT GLOB LEVEL — never even walked into
const ALWAYS_EXCLUDE_GLOB = [
  "env/**",
  "env/*/**",
  "Lib/**",
  "site-packages/**",
  "node_modules/**",
  ".git/**",
  "dist/**",
  "build/**",
  ".next/**",
  "out/**",
  "coverage/**",
  "__pycache__/**",
  ".pytest_cache/**",
  ".smartctx/**",
  ".venv/**",
  "venv/**",
  ".cache/**",
  "vendor/**",
  ".yarn/**",
  "bower_components/**",
  "target/**",
  ".idea/**",
  ".vscode/**",
  "**/*.lock",
  "**/*.log",
  "**/*.pyc",
  "**/*.min.js",
  "**/*.min.css",
  "**/.DS_Store",
  "**/Thumbs.db",
];

export async function scanProject(
  projectPath: string,
  config: GlobalConfig
): Promise<ScannedFile[]> {
  const ig = ignore();

  const gitignorePath = path.join(projectPath, ".gitignore");
  if (fs.existsSync(gitignorePath)) {
    ig.add(fs.readFileSync(gitignorePath, "utf-8"));
  }

  const smartctxIgnorePath = path.join(projectPath, ".smartctxignore");
  if (fs.existsSync(smartctxIgnorePath)) {
    ig.add(fs.readFileSync(smartctxIgnorePath, "utf-8"));
  }

  ig.add(config.excludePatterns);

  // KEY FIX: pass ignore to glob directly so heavy dirs are never walked
  const allFiles = await glob("**/*", {
    cwd: projectPath,
    nodir: true,
    dot: false,
    ignore: ALWAYS_EXCLUDE_GLOB,
  });

  const scanned: ScannedFile[] = [];

  for (const relPath of allFiles) {
    if (ig.ignores(relPath)) continue;

    const ext = path.extname(relPath).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(ext)) continue;

    const absolutePath = path.join(projectPath, relPath);
    const stat = fs.statSync(absolutePath);

    const sizeKB = stat.size / 1024;
    if (sizeKB > config.maxFileSizeKB) continue;

    let content: string;
    try {
      content = fs.readFileSync(absolutePath, "utf-8");
    } catch {
      continue;
    }

    scanned.push({
      path: relPath,
      absolutePath,
      extension: ext,
      size: stat.size,
      lastModified: stat.mtimeMs,
      content,
    });
  }

  return scanned;
}

export function getChangedFiles(
  scanned: ScannedFile[],
  existingIndex: Record<string, { lastModified: number }>
): { new: ScannedFile[]; changed: ScannedFile[]; deleted: string[] } {
  const newFiles: ScannedFile[] = [];
  const changedFiles: ScannedFile[] = [];
  const scannedPaths = new Set(scanned.map((f) => f.path));

  for (const file of scanned) {
    const existing = existingIndex[file.path];
    if (!existing) {
      newFiles.push(file);
    } else if (file.lastModified > existing.lastModified) {
      changedFiles.push(file);
    }
  }

  const deletedFiles = Object.keys(existingIndex).filter(
    (p) => !scannedPaths.has(p)
  );

  return { new: newFiles, changed: changedFiles, deleted: deletedFiles };
}