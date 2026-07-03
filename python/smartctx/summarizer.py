from __future__ import annotations

import json
import re
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Callable, List, Optional

import anthropic

from smartctx.scanner import ScannedFile
from smartctx.storage import FileSummary

# ── Summarizer ───────────────────────────────────────────────────────────────

ErrorCallback = Callable[[str, Exception], None]


def summarize_file(
    file: ScannedFile, api_key: str, on_error: Optional[ErrorCallback] = None
) -> FileSummary:
    # max_retries: the SDK retries 429/5xx/connection errors with exponential
    # backoff internally — bump it above the default(2) since init/sync can
    # run over hundreds of files and transient hiccups shouldn't cost quality.
    client = anthropic.Anthropic(api_key=api_key, max_retries=4)

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
    except Exception as err:
        # Fallback: return basic info without AI summary. Surface *why* so
        # callers (e.g. --verbose) can tell a real failure from a normal file.
        if on_error:
            on_error(file.path, err)
        return FileSummary(
            path=file.path,
            summary=f"{file.extension} file at {file.path}",
            exports=[],
            dependencies=[],
            tags=[file.extension.lstrip(".")],
            lastModified=file.lastModified,
            size=file.size,
            extension=file.extension,
            summaryFailed=True,
        )


# ── Batch Summarizer ─────────────────────────────────────────────────────────

ProgressCallback = Callable[[int, int, str], None]

DEFAULT_CONCURRENCY = 5


def summarize_files(
    files: List[ScannedFile],
    api_key: str,
    on_progress: Optional[ProgressCallback] = None,
    on_error: Optional[ErrorCallback] = None,
    concurrency: int = DEFAULT_CONCURRENCY,
) -> List[FileSummary]:
    if not files:
        return []

    summaries: List[Optional[FileSummary]] = [None] * len(files)
    completed = 0

    worker_count = max(1, min(concurrency, len(files)))
    with ThreadPoolExecutor(max_workers=worker_count) as pool:
        futures = {
            pool.submit(summarize_file, file, api_key, on_error): i
            for i, file in enumerate(files)
        }
        for future in as_completed(futures):
            i = futures[future]
            summaries[i] = future.result()
            completed += 1
            if on_progress:
                on_progress(completed, len(files), files[i].path)

    return summaries  # type: ignore[return-value]


# ── Estimate Cost ────────────────────────────────────────────────────────────


def estimate_cost(files: List[ScannedFile]) -> dict:
    estimated_tokens = len(files) * 250
    estimated_cost_usd = len(files) * 0.0004
    return {"estimatedTokens": estimated_tokens, "estimatedCostUSD": estimated_cost_usd}
