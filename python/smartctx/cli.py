from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone

import click

from smartctx.storage import (
    load_global_config,
    save_global_config,
    load_index,
    save_index,
    create_empty_index,
    is_initialized,
)
from smartctx.scanner import scan_project, get_changed_files
from smartctx.summarizer import summarize_files, estimate_cost
from smartctx.query import query_index
from smartctx.generator import (
    generate_context_files,
    estimate_tokens_saved,
)
from smartctx.targets import (
    BUILT_IN_TARGETS,
    add_user_target,
    detect_target,
    get_target,
    load_user_targets,
    parse_targets,
    remove_user_target,
    TargetDef,
)


# -- Helpers --------------------------------------------------------------

def _green(text: str) -> str:
    return click.style(text, fg="green")


def _red(text: str) -> str:
    return click.style(text, fg="red")


def _cyan(text: str) -> str:
    return click.style(text, fg="cyan")


def _yellow(text: str) -> str:
    return click.style(text, fg="yellow")


def _magenta(text: str) -> str:
    return click.style(text, fg="magenta")


def _dim(text: str) -> str:
    return click.style(text, dim=True)


def _bold(text: str) -> str:
    return click.style(text, bold=True)


# -- CLI ------------------------------------------------------------------

@click.group()
@click.version_option(package_name="smartctx")
def main():
    """Smart context manager for AI coding assistants -- saves tokens, builds local memory."""


# -- INIT -----------------------------------------------------------------

@main.command()
@click.option("--api-key", default=None, help="Your Anthropic API key (saved globally)")
@click.option("--dry-run", is_flag=True, help="Show what would be scanned without calling the API")
def init(api_key: str | None, dry_run: bool):
    """Initialize smartctx for this project -- scans and summarizes all files."""
    click.echo(_cyan(_bold("\n\U0001f9e0 smartctx init\n")))

    project_path = os.getcwd()
    config = load_global_config()

    if api_key:
        save_global_config({"apiKey": api_key})
        config.apiKey = api_key
        click.echo(_green("\u2713 API key saved globally\n"))

    if not config.apiKey:
        click.echo(
            _red("\u2717 No API key found. Run with --api-key sk-ant-xxxxx\n")
            + _dim("  Or set it once: smartctx config --api-key sk-ant-xxxxx\n")
        )
        sys.exit(1)

    if is_initialized(project_path):
        click.echo(
            _yellow("\u26a0 Already initialized. Run ")
            + "smartctx sync"
            + _yellow(" to update.\n")
        )
        sys.exit(0)

    click.echo("Scanning project files...")
    files = scan_project(project_path, config)
    click.echo(_green(f"\u2713 Found {_bold(str(len(files)))} files to index"))

    cost_info = estimate_cost(files)
    click.echo(
        _dim(f"  Estimated one-time cost: ~${cost_info['estimatedCostUSD']:.4f} (using Claude Haiku)\n")
    )

    if dry_run:
        click.echo(_cyan("\nFiles that would be indexed:"))
        for f in files:
            click.echo(_dim(f"  {f.path}"))
        click.echo(_cyan("\n[Dry run -- no API calls made]"))
        return

    click.echo(_cyan("\nSummarizing files with Claude Haiku (cheapest model)...\n"))
    index = create_empty_index(project_path)

    def on_progress(current: int, total: int, file_path: str):
        label = file_path[:50].ljust(50)
        click.echo(f"\r  {_green(f'[{current}/{total}]')} {_dim(label)}", nl=False)

    summaries = summarize_files(files, config.apiKey, on_progress)
    click.echo("\n")

    for s in summaries:
        index.files[s.path] = s
    index.totalFiles = len(summaries)
    index.lastSync = datetime.now(timezone.utc).isoformat()
    save_index(index, project_path)

    click.echo(_green(_bold("\u2713 smartctx initialized!\n")))
    click.echo(_dim("  Index saved to .smartctx/index.json"))
    click.echo(_dim('  Run: smartctx query "your task description"\n'))


# -- SYNC -----------------------------------------------------------------

@main.command()
def sync():
    """Re-summarize only changed files (fast & cheap)."""
    click.echo(_cyan(_bold("\n\U0001f504 smartctx sync\n")))

    project_path = os.getcwd()
    config = load_global_config()

    if not is_initialized(project_path):
        click.echo(_red("\u2717 Not initialized. Run: smartctx init\n"))
        sys.exit(1)

    if not config.apiKey:
        click.echo(_red("\u2717 No API key. Run: smartctx config --api-key sk-ant-xxxxx\n"))
        sys.exit(1)

    index = load_index(project_path)

    click.echo("Scanning for changes...")
    all_files = scan_project(project_path, config)
    changes = get_changed_files(all_files, index.files)
    click.echo(
        f"{_green(str(len(changes['new'])))} new, "
        f"{_yellow(str(len(changes['changed'])))} changed, "
        f"{_red(str(len(changes['deleted'])))} deleted"
    )

    to_process = changes["new"] + changes["changed"]

    if not to_process and not changes["deleted"]:
        click.echo(_green("\n\u2713 Everything up to date!\n"))
        return

    for deleted_path in changes["deleted"]:
        index.files.pop(deleted_path, None)

    if to_process:
        click.echo(_cyan(f"\nSummarizing {len(to_process)} files...\n"))

        def on_progress(current: int, total: int, file_path: str):
            label = file_path[:50].ljust(50)
            click.echo(f"\r  {_green(f'[{current}/{total}]')} {_dim(label)}", nl=False)

        summaries = summarize_files(to_process, config.apiKey, on_progress)
        click.echo("\n")
        for s in summaries:
            index.files[s.path] = s

    index.totalFiles = len(index.files)
    index.lastSync = datetime.now(timezone.utc).isoformat()
    save_index(index, project_path)

    click.echo(_green(_bold("\u2713 Sync complete!\n")))


# -- QUERY ----------------------------------------------------------------

@main.command()
@click.argument("task")
@click.option(
    "--for", "target",
    default=None,
    help="Comma-separated AI tools (claude,cursor,copilot,codex,windsurf,cline,aider,continue,gemini,zed, or custom). Auto-detected if omitted.",
)
@click.option("--top", default=10, type=int, help="Number of files to include")
def query(task: str, target: str | None, top: int):
    """Find relevant files and generate context -- e.g. smartctx query "add auth"."""
    click.echo(_cyan(_bold("\n\U0001f50d smartctx query\n")))

    project_path = os.getcwd()

    if not is_initialized(project_path):
        click.echo(_red("\u2717 Not initialized. Run: smartctx init\n"))
        sys.exit(1)

    config = load_global_config()

    if target:
        targets = parse_targets(target)
    else:
        detected = detect_target(project_path)
        if detected:
            targets = [detected]
            click.echo(_dim(f"  Auto-detected target: {detected}\n"))
        else:
            targets = [config.defaultTarget or "codex"]
            click.echo(_dim(f"  Using default target: {targets[0]}\n"))

    for t in targets:
        if get_target(t) is None:
            click.echo(_red(f'\u2717 Unknown target "{t}". Run: smartctx targets list\n'))
            sys.exit(1)

    index = load_index(project_path)
    results = query_index(index, task, top)

    if not results:
        click.echo(_yellow("No matching files found. Try different keywords.\n"))
        return

    click.echo(_green(f"Found {len(results)} relevant files:\n"))
    for i, r in enumerate(results):
        click.echo(f"  {_bold(f'{i + 1}.')} {_cyan(r.file.path)} {_dim(f'(score: {r.score:.1f})')}")
        click.echo(_dim(f"     {r.file.summary}"))

    generated = generate_context_files(index, results, task, targets, project_path)

    total_size = sum(f.size for f in index.files.values())
    avg_size = total_size / index.totalFiles if index.totalFiles else 0
    saved = estimate_tokens_saved(index.totalFiles, avg_size, len(results))

    header_line = _green(_bold("\u2713 Context files generated:"))
    click.echo("\n" + header_line)
    for g in generated:
        click.echo(f"  {g.outputPath} {_dim(f'({g.target})')}")
    click.echo(_dim(f"\n  ~{saved:,} tokens saved vs reading full project\n"))


# -- STATUS ---------------------------------------------------------------

@main.command()
def status():
    """Show index stats for this project."""
    project_path = os.getcwd()

    if not is_initialized(project_path):
        click.echo(_red("\n\u2717 Not initialized. Run: smartctx init\n"))
        sys.exit(1)

    index = load_index(project_path)
    config = load_global_config()

    click.echo(_cyan(_bold("\n\U0001f4ca smartctx status\n")))
    click.echo(f"  Project:    {index.projectName}")
    click.echo(f"  Files:      {index.totalFiles}")
    click.echo(f"  Last sync:  {index.lastSync}")
    api_status = _green("\u2713 set") if config.apiKey else _red("\u2717 not set")
    click.echo(f"  API key:    {api_status}")
    click.echo(f"  Target:     {config.defaultTarget}")
    click.echo(f"  Schedule:   {config.syncSchedule}\n")


# -- CONFIG ---------------------------------------------------------------

@main.command()
@click.option("--api-key", default=None, help="Set your Anthropic API key")
@click.option("--target", default=None, help="Default target (any registered target name)")
@click.option("--schedule", default=None, type=click.Choice(["daily", "weekly", "manual"]),
              help="Sync schedule")
def config(api_key: str | None, target: str | None, schedule: str | None):
    """View or set global configuration."""
    updates: dict = {}

    if api_key:
        updates["apiKey"] = api_key
    if target:
        if get_target(target) is None:
            click.echo(_red(f'\n\u2717 Unknown target "{target}". Run: smartctx targets list\n'))
            sys.exit(1)
        updates["defaultTarget"] = target
    if schedule:
        updates["syncSchedule"] = schedule

    if not updates:
        cfg = load_global_config()
        click.echo(_cyan(_bold("\n\u2699 smartctx config\n")))
        display = {
            "apiKey": (cfg.apiKey[:10] + "...") if cfg.apiKey else None,
            "defaultTarget": cfg.defaultTarget,
            "syncSchedule": cfg.syncSchedule,
            "maxFileSizeKB": cfg.maxFileSizeKB,
        }
        click.echo(json.dumps(display, indent=2))
        click.echo()
        return

    save_global_config(updates)
    click.echo(_green("\n\u2713 Config updated!\n"))
    for k, v in updates.items():
        display_val = v[:10] + "..." if k == "apiKey" else v
        click.echo(_dim(f"  {k}: {display_val}"))
    click.echo()


# -- TARGETS --------------------------------------------------------------

@main.group()
def targets():
    """Manage AI tool targets (list, add, remove custom targets)."""


@targets.command("list")
def targets_list():
    """List all available targets (built-in + user-defined)."""
    click.echo(_cyan(_bold("\n\U0001f3af smartctx targets\n")))

    click.echo(_bold("Built-in:"))
    for t in BUILT_IN_TARGETS.values():
        click.echo(f"  {_green(t.name.ljust(12))} -> {_dim(t.outputFile)}")

    user = list(load_user_targets().values())
    if user:
        click.echo(_bold("\nUser-defined:"))
        for t in user:
            click.echo(f"  {_magenta(t.name.ljust(12))} -> {_dim(t.outputFile)}")
    click.echo()


@targets.command("add")
@click.option("--name", required=True, help="Target name (e.g. myagent)")
@click.option("--file", "file_", required=True, help="Output file path (e.g. MYAGENT.md)")
@click.option("--header", default=None, help="Header comment for the output file")
@click.option("--detect", default=None, help="Comma-separated marker files for auto-detection")
def targets_add(name: str, file_: str, header: str | None, detect: str | None):
    """Register a custom target."""
    key = name.lower()
    if key in BUILT_IN_TARGETS:
        click.echo(_yellow(f'\n\u26a0 "{key}" is a built-in target -- your definition will override it.\n'))
    detect_list = (
        [s.strip() for s in detect.split(",") if s.strip()] if detect else []
    )
    add_user_target(
        TargetDef(
            name=key,
            outputFile=file_,
            header=header or f"# {key} -- auto-generated by smartctx",
            detectFiles=detect_list,
        )
    )
    click.echo(_green(f'\n\u2713 Target "{key}" added.\n'))
    click.echo(_dim(f'  Use: smartctx query "..." --for {key}\n'))


@targets.command("remove")
@click.argument("name")
def targets_remove(name: str):
    """Remove a user-defined target."""
    if remove_user_target(name):
        click.echo(_green(f'\n\u2713 Target "{name}" removed.\n'))
    else:
        click.echo(_yellow(f'\n\u26a0 "{name}" is not a user-defined target (built-ins cannot be removed).\n'))


@targets.command("detect")
def targets_detect():
    """Show which target would be auto-detected for this project."""
    detected = detect_target(os.getcwd())
    if detected:
        definition = get_target(detected)
        click.echo(_green(f"\n\u2713 Detected: {detected} -> {_dim(definition.outputFile)}\n"))
    else:
        click.echo(_dim("\nNo marker files found. Would fall back to default target.\n"))
