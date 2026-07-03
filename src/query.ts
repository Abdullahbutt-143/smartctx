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

// Below this length, substring matching produces too many false positives
// (e.g. "log" matching "login", "catalog", "dialog", "logger") — short
// tokens must match a whole word instead.
const MIN_LENGTH_FOR_SUBSTRING_MATCH = 5;

// Returns 1 for an exact match, a fraction for a substring match, or 0 for
// no match — so partial matches never outscore an exact one.
function matchStrength(queryToken: string, candidate: string): number {
  if (queryToken === candidate) return 1;
  if (queryToken.length < MIN_LENGTH_FOR_SUBSTRING_MATCH) return 0;
  if (candidate.includes(queryToken) || queryToken.includes(candidate)) return 0.6;
  return 0;
}

function bestMatch(queryToken: string, candidates: string[]): number {
  let best = 0;
  for (const c of candidates) {
    const strength = matchStrength(queryToken, c);
    if (strength > best) best = strength;
  }
  return best;
}

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

  const weights: Array<[string, string[], number]> = [
    ["path", pathTokens, 3],       // file path match — high weight
    ["tag", tagTokens, 2.5],       // tag match — high weight (curated keywords)
    ["summary", summaryTokens, 2], // summary match — medium weight
    ["export", exportTokens, 1.5], // export match — medium weight
    ["dep", depTokens, 1],         // dependency match — lower weight
  ];

  for (const qt of queryTokens) {
    for (const [label, candidates, weight] of weights) {
      const strength = bestMatch(qt, candidates);
      if (strength > 0) {
        score += weight * strength;
        matchedOn.push(`${label}:${qt}`);
      }
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
