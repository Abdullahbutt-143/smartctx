import Anthropic from "@anthropic-ai/sdk";
import { ScannedFile } from "./scanner.js";
import { FileSummary, loadGlobalConfig } from "./storage.js";

// ─── Summarizer ───────────────────────────────────────────────────────────────

export async function summarizeFile(
  file: ScannedFile,
  apiKey: string,
  onError?: (filePath: string, error: Error) => void
): Promise<FileSummary> {
  // maxRetries: the SDK retries 429/5xx/connection errors with exponential
  // backoff internally — bump it above the default(2) since init/sync can
  // run over hundreds of files and transient hiccups shouldn't cost quality.
  const client = new Anthropic({ apiKey, maxRetries: 4 });

  const prompt = `You are analyzing a source code file for a developer tool. 
Analyze this file and respond ONLY with a JSON object (no markdown, no explanation).

File path: ${file.path}
File content:
\`\`\`${file.extension.slice(1)}
${file.content.slice(0, 3000)}
\`\`\`

Respond with this exact JSON structure:
{
  "summary": "1-2 sentence description of what this file does",
  "exports": ["list", "of", "exported", "functions/classes/variables"],
  "dependencies": ["list", "of", "key", "imports/dependencies"],
  "tags": ["relevant", "keywords", "for", "search", "e.g.", "auth", "database", "api", "ui"]
}`;

  try {
    const response = await client.messages.create({
      model: "claude-haiku-4-5",  // cheapest model — saves user money
      max_tokens: 400,
      messages: [{ role: "user", content: prompt }],
    });

    const text = response.content[0].type === "text" ? response.content[0].text : "";
    
    // Clean and parse JSON
    const clean = text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);

    return {
      path: file.path,
      summary: parsed.summary || "No summary available",
      exports: parsed.exports || [],
      dependencies: parsed.dependencies || [],
      tags: parsed.tags || [],
      lastModified: file.lastModified,
      size: file.size,
      extension: file.extension,
    };
  } catch (err) {
    // Fallback: return basic info without AI summary. Surface *why* so
    // callers (e.g. --verbose) can tell a real failure from a normal file.
    onError?.(file.path, err as Error);
    return {
      path: file.path,
      summary: `${file.extension} file at ${file.path}`,
      exports: [],
      dependencies: [],
      tags: [file.extension.slice(1)],
      lastModified: file.lastModified,
      size: file.size,
      extension: file.extension,
      summaryFailed: true,
    };
  }
}

// ─── Batch Summarizer ─────────────────────────────────────────────────────────

const DEFAULT_CONCURRENCY = 5;

export async function summarizeFiles(
  files: ScannedFile[],
  apiKey: string,
  onProgress?: (current: number, total: number, filePath: string) => void,
  onError?: (filePath: string, error: Error) => void,
  concurrency: number = DEFAULT_CONCURRENCY
): Promise<FileSummary[]> {
  const summaries: FileSummary[] = new Array(files.length);
  let completed = 0;
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const i = nextIndex++;
      if (i >= files.length) return;
      const file = files[i];
      summaries[i] = await summarizeFile(file, apiKey, onError);
      completed++;
      onProgress?.(completed, files.length, file.path);
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, files.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return summaries;
}

// ─── Estimate Cost ────────────────────────────────────────────────────────────

export function estimateCost(files: ScannedFile[]): {
  estimatedTokens: number;
  estimatedCostUSD: number;
} {
  // ~250 tokens per file (prompt + response) using Haiku
  const estimatedTokens = files.length * 250;
  // Haiku: $0.25 per 1M input tokens + $1.25 per 1M output tokens
  // Roughly $0.0004 per file on average
  const estimatedCostUSD = files.length * 0.0004;

  return { estimatedTokens, estimatedCostUSD };
}
