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


# Below this length, substring matching produces too many false positives
# (e.g. "log" matching "login", "catalog", "dialog", "logger") — short
# tokens must match a whole word instead.
MIN_LENGTH_FOR_SUBSTRING_MATCH = 5


def _match_strength(query_token: str, candidate: str) -> float:
    """1 for an exact match, a fraction for a substring match, 0 for no match."""
    if query_token == candidate:
        return 1.0
    if len(query_token) < MIN_LENGTH_FOR_SUBSTRING_MATCH:
        return 0.0
    if query_token in candidate or candidate in query_token:
        return 0.6
    return 0.0


def _best_match(query_token: str, candidates: List[str]) -> float:
    return max((_match_strength(query_token, c) for c in candidates), default=0.0)


def _score_file(file: FileSummary, query_tokens: List[str]) -> tuple:
    score = 0.0
    matched_on: List[str] = []

    summary_tokens = _tokenize(file.summary)
    tag_tokens = [t.lower() for t in file.tags]
    export_tokens = [e.lower() for e in file.exports]
    dep_tokens = [d.lower() for d in file.dependencies]
    path_tokens = _tokenize(file.path)

    weighted_fields = [
        ("path", path_tokens, 3),        # file path match — high weight
        ("tag", tag_tokens, 2.5),        # tag match — high weight (curated keywords)
        ("summary", summary_tokens, 2),  # summary match — medium weight
        ("export", export_tokens, 1.5),  # export match — medium weight
        ("dep", dep_tokens, 1),          # dependency match — lower weight
    ]

    for qt in query_tokens:
        for label, candidates, weight in weighted_fields:
            strength = _best_match(qt, candidates)
            if strength > 0:
                score += weight * strength
                matched_on.append(f"{label}:{qt}")

    return score, list(set(matched_on))
