from __future__ import annotations

import json
import re
import time
from typing import Callable, List, Optional

import anthropic

from smartctx.scanner import ScannedFile
from smartctx.storage import FileSummary

# ── Summarizer ───────────────────────────────────────────────────────────────


def summarize_file(file: ScannedFile, api_key: str) -> FileSummary:
    client = anthropic.Anthropic(api_key=api_key)

    prompt = f"""You are analyzing a source code file for a developer tool.
Analyze this file and respond ONLY with a JSON object (no markdown, no explanation).

File path: {file.path}
File content:
```{file.extension.lstrip(".")}
{file.content[:3000]}
```

Respond with this exact JSON structure:
{{
  "summary": "1-2 sentence description of what this file does",
  "exports": ["list", "of", "exported", "functions/classes/variables"],
  "dependencies": ["list", "of", "key", "imports/dependencies"],
  "tags": ["relevant", "keywords", "for", "search", "e.g.", "auth", "database", "api", "ui"]
}}"""

    try:
        response = client.messages.create(
            model="claude-haiku-4-5",
            max_tokens=400,
            messages=[{"role": "user", "content": prompt}],
        )

        text = response.content[0].text if response.content else ""
        clean = re.sub(r"```json|```", "", text).strip()
        parsed = json.loads(clean)

        return FileSummary(
            path=file.path,
            summary=parsed.get("summary", "No summary available"),
            exports=parsed.get("exports", []),
            dependencies=parsed.get("dependencies", []),
            tags=parsed.get("tags", []),
            lastModified=file.lastModified,
            size=file.size,
            extension=file.extension,
        )
    except Exception:
        return FileSummary(
            path=file.path,
            summary=f"{file.extension} file at {file.path}",
            exports=[],
            dependencies=[],
            tags=[file.extension.lstrip(".")],
            lastModified=file.lastModified,
            size=file.size,
            extension=file.extension,
        )


# ── Batch Summarizer ─────────────────────────────────────────────────────────

ProgressCallback = Callable[[int, int, str], None]


def summarize_files(
    files: List[ScannedFile],
    api_key: str,
    on_progress: Optional[ProgressCallback] = None,
) -> List[FileSummary]:
    summaries: List[FileSummary] = []

    for i, file in enumerate(files):
        if on_progress:
            on_progress(i + 1, len(files), file.path)

        summary = summarize_file(file, api_key)
        summaries.append(summary)

        # Small delay to avoid rate limiting
        if i < len(files) - 1:
            time.sleep(0.2)

    return summaries


# ── Estimate Cost ────────────────────────────────────────────────────────────


def estimate_cost(files: List[ScannedFile]) -> dict:
    estimated_tokens = len(files) * 250
    estimated_cost_usd = len(files) * 0.0004
    return {"estimatedTokens": estimated_tokens, "estimatedCostUSD": estimated_cost_usd}
