from __future__ import annotations

import json
import os
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Dict, List, Optional

from dotenv import load_dotenv

# Auto-load .env from current working directory (and parent)
load_dotenv(Path.cwd() / ".env")
load_dotenv(Path.cwd().parent / ".env")

# ── Types ────────────────────────────────────────────────────────────────────


@dataclass
class FileSummary:
    path: str
    summary: str
    exports: List[str]
    dependencies: List[str]
    tags: List[str]
    lastModified: float
    size: int
    extension: str


@dataclass
class ProjectIndex:
    version: str
    projectName: str
    projectPath: str
    createdAt: str
    lastSync: str
    totalFiles: int
    totalTokensSaved: int
    files: Dict[str, FileSummary]


@dataclass
class GlobalConfig:
    apiKey: Optional[str] = None
    defaultTarget: str = "claude"
    syncSchedule: str = "daily"
    maxFileSizeKB: int = 100
    excludePatterns: List[str] = field(default_factory=lambda: [
        "node_modules", ".git", "dist", "build", ".next",
        "__pycache__", "*.lock", "*.log", ".env*",
    ])


# ── Paths ────────────────────────────────────────────────────────────────────

LOCAL_CTX_DIR = ".smartctx"
GLOBAL_CONFIG_DIR = Path.home() / ".smartctx"
GLOBAL_CONFIG_FILE = GLOBAL_CONFIG_DIR / "config.json"


def get_local_ctx_dir(project_path: str | None = None) -> Path:
    return Path(project_path or os.getcwd()) / LOCAL_CTX_DIR


def get_index_path(project_path: str | None = None) -> Path:
    return get_local_ctx_dir(project_path) / "index.json"


# ── Global Config ────────────────────────────────────────────────────────────


def load_global_config() -> GlobalConfig:
    config = GlobalConfig()

    if GLOBAL_CONFIG_FILE.exists():
        try:
            saved = json.loads(GLOBAL_CONFIG_FILE.read_text("utf-8"))
            for k, v in saved.items():
                if hasattr(config, k):
                    setattr(config, k, v)
        except (json.JSONDecodeError, OSError):
            pass

    # Env variable always wins
    env_key = (
        os.environ.get("ANTHROPIC_API_KEY")
        or os.environ.get("CLAUDE_API_KEY")
        or os.environ.get("CLAUDE_CODE_API_KEY")
    )
    if env_key:
        config.apiKey = env_key

    return config


def save_global_config(updates: dict) -> None:
    GLOBAL_CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    existing = load_global_config()
    for k, v in updates.items():
        if hasattr(existing, k):
            setattr(existing, k, v)
    GLOBAL_CONFIG_FILE.write_text(json.dumps(asdict(existing), indent=2), "utf-8")


# ── Project Index ────────────────────────────────────────────────────────────


def _file_summary_from_dict(d: dict) -> FileSummary:
    return FileSummary(
        path=d["path"],
        summary=d["summary"],
        exports=d.get("exports", []),
        dependencies=d.get("dependencies", []),
        tags=d.get("tags", []),
        lastModified=d["lastModified"],
        size=d["size"],
        extension=d["extension"],
    )


def load_index(project_path: str | None = None) -> Optional[ProjectIndex]:
    index_path = get_index_path(project_path)
    if not index_path.exists():
        return None
    try:
        raw = json.loads(index_path.read_text("utf-8"))
        files = {k: _file_summary_from_dict(v) for k, v in raw.get("files", {}).items()}
        return ProjectIndex(
            version=raw["version"],
            projectName=raw["projectName"],
            projectPath=raw["projectPath"],
            createdAt=raw["createdAt"],
            lastSync=raw["lastSync"],
            totalFiles=raw["totalFiles"],
            totalTokensSaved=raw.get("totalTokensSaved", 0),
            files=files,
        )
    except (json.JSONDecodeError, KeyError, OSError):
        return None


def save_index(index: ProjectIndex, project_path: str | None = None) -> None:
    ctx_dir = get_local_ctx_dir(project_path)
    ctx_dir.mkdir(parents=True, exist_ok=True)
    data = {
        "version": index.version,
        "projectName": index.projectName,
        "projectPath": index.projectPath,
        "createdAt": index.createdAt,
        "lastSync": index.lastSync,
        "totalFiles": index.totalFiles,
        "totalTokensSaved": index.totalTokensSaved,
        "files": {k: asdict(v) for k, v in index.files.items()},
    }
    get_index_path(project_path).write_text(json.dumps(data, indent=2), "utf-8")


def create_empty_index(project_path: str | None = None) -> ProjectIndex:
    from datetime import datetime, timezone

    p = project_path or os.getcwd()
    return ProjectIndex(
        version="0.1.0",
        projectName=Path(p).name,
        projectPath=p,
        createdAt=datetime.now(timezone.utc).isoformat(),
        lastSync=datetime.now(timezone.utc).isoformat(),
        totalFiles=0,
        totalTokensSaved=0,
        files={},
    )


def is_initialized(project_path: str | None = None) -> bool:
    return get_index_path(project_path).exists()
