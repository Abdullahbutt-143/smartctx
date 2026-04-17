from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List

import pathspec

from smartctx.storage import GlobalConfig

# ── Types ────────────────────────────────────────────────────────────────────


@dataclass
class ScannedFile:
    path: str
    absolutePath: str
    extension: str
    size: int
    lastModified: float
    content: str


# ── Constants ────────────────────────────────────────────────────────────────

SUPPORTED_EXTENSIONS = {
    ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs",
    ".py", ".pyw",
    ".html", ".css", ".scss", ".sass",
    ".json", ".yaml", ".yml", ".toml",
    ".md", ".mdx",
    ".go", ".rs", ".java", ".c", ".cpp", ".h", ".cs", ".rb", ".php",
    ".sh", ".bash", ".zsh",
}

ALWAYS_EXCLUDE = [
    "env/", "Lib/", "site-packages/",
    "node_modules/", ".git/", "dist/", "build/",
    ".next/", "out/", "coverage/",
    "__pycache__/", ".pytest_cache/", ".smartctx/",
    ".venv/", "venv/", ".cache/", "vendor/",
    ".yarn/", "bower_components/", "target/",
    ".idea/", ".vscode/",
    "*.lock", "*.log", "*.pyc", "*.min.js", "*.min.css",
    ".DS_Store", "Thumbs.db",
]


# ── Scanner ──────────────────────────────────────────────────────────────────


def scan_project(project_path: str, config: GlobalConfig) -> List[ScannedFile]:
    root = Path(project_path)

    # Build ignore spec from .gitignore + .smartctxignore + config
    ignore_patterns: List[str] = list(ALWAYS_EXCLUDE)

    gitignore = root / ".gitignore"
    if gitignore.exists():
        ignore_patterns.extend(gitignore.read_text("utf-8").splitlines())

    smartctxignore = root / ".smartctxignore"
    if smartctxignore.exists():
        ignore_patterns.extend(smartctxignore.read_text("utf-8").splitlines())

    ignore_patterns.extend(config.excludePatterns)

    spec = pathspec.PathSpec.from_lines("gitwildmatch", ignore_patterns)

    scanned: List[ScannedFile] = []

    for dirpath, dirnames, filenames in os.walk(root):
        # Prune ignored directories in-place so os.walk skips them
        rel_dir = os.path.relpath(dirpath, root).replace("\\", "/")
        if rel_dir == ".":
            rel_dir = ""

        dirnames[:] = [
            d for d in dirnames
            if not spec.match_file(f"{rel_dir}/{d}/" if rel_dir else f"{d}/")
        ]

        for fname in filenames:
            rel_path = os.path.join(rel_dir, fname).replace("\\", "/") if rel_dir else fname
            if spec.match_file(rel_path):
                continue

            ext = os.path.splitext(fname)[1].lower()
            if ext not in SUPPORTED_EXTENSIONS:
                continue

            abs_path = os.path.join(dirpath, fname)
            try:
                stat = os.stat(abs_path)
            except OSError:
                continue

            size_kb = stat.st_size / 1024
            if size_kb > config.maxFileSizeKB:
                continue

            try:
                content = open(abs_path, "r", encoding="utf-8").read()
            except (OSError, UnicodeDecodeError):
                continue

            scanned.append(ScannedFile(
                path=rel_path,
                absolutePath=abs_path,
                extension=ext,
                size=stat.st_size,
                lastModified=stat.st_mtime * 1000,  # ms to match JS
                content=content,
            ))

    return scanned


def get_changed_files(
    scanned: List[ScannedFile],
    existing_index: Dict[str, object],
) -> dict:
    new_files: List[ScannedFile] = []
    changed_files: List[ScannedFile] = []
    scanned_paths = {f.path for f in scanned}

    for f in scanned:
        existing = existing_index.get(f.path)
        if existing is None:
            new_files.append(f)
        elif f.lastModified > getattr(existing, "lastModified", 0):
            changed_files.append(f)

    deleted = [p for p in existing_index if p not in scanned_paths]

    return {"new": new_files, "changed": changed_files, "deleted": deleted}
