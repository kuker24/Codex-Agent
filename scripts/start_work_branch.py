#!/usr/bin/env python3
from __future__ import annotations

import argparse
import subprocess
from pathlib import Path

from git_flow_common import BRANCH_TYPES, build_branch_name


def run(command: list[str], *, cwd: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(command, cwd=cwd, text=True, capture_output=True)
    if check and result.returncode != 0:
        raise SystemExit(
            f"Command failed ({result.returncode}): {' '.join(command)}\nSTDOUT:\n{result.stdout}\nSTDERR:\n{result.stderr}"
        )
    return result


def git(args: list[str], *, cwd: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    return run(["git", *args], cwd=cwd, check=check)


def repo_root(start: str) -> str:
    return run(["git", "rev-parse", "--show-toplevel"], cwd=start).stdout.strip()


def working_tree_dirty(cwd: str) -> bool:
    return bool(git(["status", "--porcelain"], cwd=cwd).stdout.strip())


def local_branch_exists(branch: str, cwd: str) -> bool:
    return git(["show-ref", "--verify", f"refs/heads/{branch}"], cwd=cwd, check=False).returncode == 0


def remote_branch_exists(branch: str, cwd: str) -> bool:
    return git(["show-ref", "--verify", f"refs/remotes/origin/{branch}"], cwd=cwd, check=False).returncode == 0


def ensure_base_branch(base: str, cwd: str, *, fetch: bool) -> None:
    if fetch:
        git(["fetch", "origin", base], cwd=cwd, check=False)

    if local_branch_exists(base, cwd):
        git(["switch", base], cwd=cwd)
        if remote_branch_exists(base, cwd):
            git(["pull", "--ff-only", "origin", base], cwd=cwd)
        return

    if remote_branch_exists(base, cwd):
        git(["switch", "-c", base, "--track", f"origin/{base}"], cwd=cwd)
        return

    git(["switch", "-c", base], cwd=cwd)


def switch_to_branch(branch: str, cwd: str) -> None:
    if local_branch_exists(branch, cwd):
        git(["switch", branch], cwd=cwd)
        return

    if remote_branch_exists(branch, cwd):
        git(["switch", "-c", branch, "--track", f"origin/{branch}"], cwd=cwd)
        return

    git(["switch", "-c", branch], cwd=cwd)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Create or switch to a standardized work branch.")
    parser.add_argument("--branch", help="Explicit branch name. If omitted, build one from type/slug.")
    parser.add_argument("--type", dest="branch_type", choices=BRANCH_TYPES, default="feat", help="Standard branch prefix. Default: feat")
    parser.add_argument("--slug", help="Human-readable branch slug, for example ui-polish.")
    parser.add_argument("--scope", help="Optional middle scope, for example swarm or ci.")
    parser.add_argument("--ticket", help="Optional issue or ticket id, for example ABC-123.")
    parser.add_argument("--base", default="main", help="Base branch to sync from. Default: main")
    parser.add_argument("--cwd", default=".", help="Repository path. Default: current directory")
    parser.add_argument("--from-current", action="store_true", help="Start from the current HEAD instead of syncing the base branch first.")
    parser.add_argument("--no-fetch", action="store_true", help="Skip git fetch/pull for the base branch.")
    parser.add_argument("--allow-dirty", action="store_true", help="Allow running with a dirty working tree.")
    parser.add_argument("--print-only", action="store_true", help="Only print the resolved branch name.")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    cwd = repo_root(str(Path(args.cwd).resolve()))

    if args.branch:
        if any([args.slug, args.scope, args.ticket]):
            raise SystemExit("Gunakan --branch atau kombinasi --type/--slug/--scope/--ticket, jangan keduanya sekaligus.")
        branch = args.branch.strip()
        if not branch:
            raise SystemExit("Nilai --branch kosong.")
    else:
        if not args.slug:
            raise SystemExit("--slug wajib jika --branch tidak diberikan.")
        branch = build_branch_name(args.branch_type, slug=args.slug, scope=args.scope, ticket=args.ticket)

    if args.print_only:
        print(branch)
        return 0

    if working_tree_dirty(cwd) and not args.allow_dirty:
        raise SystemExit("Working tree kotor. Commit atau stash dulu, atau gunakan --allow-dirty bila memang sengaja.")

    if not args.from_current:
        ensure_base_branch(args.base, cwd, fetch=not args.no_fetch)

    switch_to_branch(branch, cwd)
    print(f"Active branch: {branch}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
