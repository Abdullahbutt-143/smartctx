from __future__ import annotations

import re
from dataclasses import dataclass
from typing import List

from smartctx.storage import FileSummary, ProjectIndex

# ── Query Engine (100% local, zero API cost) ─────────────────────────────────


@dataclass
class QueryResult:
    file: FileSummary
    score: float
    matchedOn: List[str]


def query_index(index: ProjectIndex, user_query: str, top_k: int = 10) -> List[QueryResult]:
    query_tokens = _tokenize(user_query)
    results: List[QueryResult] = []

    for file in index.files.values():
        score, matched_on = _score_file(file, query_tokens)
        if score > 0:
            results.append(QueryResult(file=file, score=score, matchedOn=matched_on))

    results.sort(key=lambda r: r.score, reverse=True)
    return results[:top_k]


# ── Scoring ──────────────────────────────────────────────────────────────────

STOP_WORDS = {
    "the", "and", "for", "with", "this", "that", "from", "into",
    "are", "was", "were", "has", "have", "had", "not", "but",
    "its", "it", "is", "in", "of", "to", "a", "an", "or",
    "can", "will", "should", "would", "could", "may", "might",
}


def _tokenize(text: str) -> List[str]:
    lowered = text.lower()
    cleaned = re.sub(r"[^a-z0-9\s\-_/.]", " ", lowered)
    tokens = re.split(r"[\s\-_/.]+", cleaned)
    return [t for t in tokens if len(t) > 2 and t not in STOP_WORDS]


def _score_file(file: FileSummary, query_tokens: List[str]) -> tuple:
    score = 0.0
    matched_on: List[str] = []

    summary_tokens = _tokenize(file.summary)
    tag_tokens = [t.lower() for t in file.tags]
    export_tokens = [e.lower() for e in file.exports]
    dep_tokens = [d.lower() for d in file.dependencies]
    path_tokens = _tokenize(file.path)

    for qt in query_tokens:
        # File path match — high weight
        if any(qt in pt or pt in qt for pt in path_tokens):
            score += 3
            matched_on.append(f"path:{qt}")

        # Tag match — high weight
        if any(qt in tag or tag in qt for tag in tag_tokens):
            score += 2.5
            matched_on.append(f"tag:{qt}")

        # Summary match — medium weight
        if any(qt in st or st in qt for st in summary_tokens):
            score += 2
            matched_on.append(f"summary:{qt}")

        # Export match — medium weight
        if any(qt in et or et in qt for et in export_tokens):
            score += 1.5
            matched_on.append(f"export:{qt}")

        # Dependency match — lower weight
        if any(qt in dt or dt in qt for dt in dep_tokens):
            score += 1
            matched_on.append(f"dep:{qt}")

    return score, list(set(matched_on))
