import Anthropic from "@anthropic-ai/sdk";
import { ScannedFile } from "./scanner.js";
import { FileSummary, loadGlobalConfig } from "./storage.js";

// ─── Summarizer ───────────────────────────────────────────────────────────────

export async function summarizeFile(
  file: ScannedFile,
  apiKey: string
): Promise<FileSummary> {
  const client = new Anthropic({ apiKey });

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
    // Fallback: return basic info without AI summary
    return {
      path: file.path,
      summary: `${file.extension} file at ${file.path}`,
      exports: [],
      dependencies: [],
      tags: [file.extension.slice(1)],
      lastModified: file.lastModified,
      size: file.size,
      extension: file.extension,
    };
  }
}

// ─── Batch Summarizer ─────────────────────────────────────────────────────────

export async function summarizeFiles(
  files: ScannedFile[],
  apiKey: string,
  onProgress?: (current: number, total: number, filePath: string) => void
): Promise<FileSummary[]> {
  const summaries: FileSummary[] = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    onProgress?.(i + 1, files.length, file.path);

    const summary = await summarizeFile(file, apiKey);
    summaries.push(summary);

    // Small delay to avoid rate limiting
    if (i < files.length - 1) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

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
