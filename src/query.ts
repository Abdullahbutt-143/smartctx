import { FileSummary, ProjectIndex } from "./storage.js";

// ─── Query Engine (100% local, zero API cost) ─────────────────────────────────

export interface QueryResult {
  file: FileSummary;
  score: number;
  matchedOn: string[];
}

export function queryIndex(
  index: ProjectIndex,
  userQuery: string,
  topK: number = 10
): QueryResult[] {
  const queryTokens = tokenize(userQuery);
  const results: QueryResult[] = [];

  for (const [, file] of Object.entries(index.files)) {
    const { score, matchedOn } = scoreFile(file, queryTokens);
    if (score > 0) {
      results.push({ file, score, matchedOn });
    }
  }

  // Sort by score descending, return top K
  return results
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

// ─── Scoring ──────────────────────────────────────────────────────────────────

function scoreFile(
  file: FileSummary,
  queryTokens: string[]
): { score: number; matchedOn: string[] } {
  let score = 0;
  const matchedOn: string[] = [];

  const summaryTokens = tokenize(file.summary);
  const tagTokens = file.tags.map((t) => t.toLowerCase());
  const exportTokens = file.exports.map((e) => e.toLowerCase());
  const depTokens = file.dependencies.map((d) => d.toLowerCase());
  const pathTokens = tokenize(file.path);

  for (const qt of queryTokens) {
    // File path match — high weight (file name is very relevant)
    if (pathTokens.some((pt) => pt.includes(qt) || qt.includes(pt))) {
      score += 3;
      matchedOn.push(`path:${qt}`);
    }

    // Tag match — high weight (tags are curated keywords)
    if (tagTokens.some((tag) => tag.includes(qt) || qt.includes(tag))) {
      score += 2.5;
      matchedOn.push(`tag:${qt}`);
    }

    // Summary match — medium weight
    if (summaryTokens.some((st) => st.includes(qt) || qt.includes(st))) {
      score += 2;
      matchedOn.push(`summary:${qt}`);
    }

    // Export match — medium weight
    if (exportTokens.some((et) => et.includes(qt) || qt.includes(et))) {
      score += 1.5;
      matchedOn.push(`export:${qt}`);
    }

    // Dependency match — lower weight
    if (depTokens.some((dt) => dt.includes(qt) || qt.includes(dt))) {
      score += 1;
      matchedOn.push(`dep:${qt}`);
    }
  }

  // Deduplicate matchedOn
  const unique = [...new Set(matchedOn)];

  return { score, matchedOn: unique };
}

// ─── Tokenizer ────────────────────────────────────────────────────────────────

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s\-_\/\.]/g, " ")
    .split(/[\s\-_\/\.]+/)
    .filter((t) => t.length > 2)
    .filter((t) => !STOP_WORDS.has(t));
}

const STOP_WORDS = new Set([
  "the", "and", "for", "with", "this", "that", "from", "into",
  "are", "was", "were", "has", "have", "had", "not", "but",
  "its", "it", "is", "in", "of", "to", "a", "an", "or",
  "can", "will", "should", "would", "could", "may", "might",
]);
