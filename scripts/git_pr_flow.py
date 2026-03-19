#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


def run(command: list[str], *, cwd: str | None = None, check: bool = True) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(command, cwd=cwd, text=True, capture_output=True)
    if check and result.returncode != 0:
        raise SystemExit(
            f"Command failed ({result.returncode}): {' '.join(command)}\nSTDOUT:\n{result.stdout}\nSTDERR:\n{result.stderr}"
        )
    return result


def git(args: list[str], *, cwd: str | None = None, check: bool = True) -> subprocess.CompletedProcess[str]:
    return run(["git", *args], cwd=cwd, check=check)


def repo_root() -> str:
    return git(["rev-parse", "--show-toplevel"]).stdout.strip()


def current_branch(cwd: str) -> str:
    return git(["branch", "--show-current"], cwd=cwd).stdout.strip()


def working_tree_dirty(cwd: str) -> bool:
    return bool(git(["status", "--porcelain"], cwd=cwd).stdout.strip())


def upstream_exists(branch: str, cwd: str) -> bool:
    return git(["rev-parse", "--abbrev-ref", f"{branch}@{{upstream}}"], cwd=cwd, check=False).returncode == 0


def latest_commit_subject(cwd: str) -> str:
    return git(["log", "-1", "--pretty=%s"], cwd=cwd).stdout.strip()


def latest_commit_body(cwd: str) -> str:
    return git(["log", "-1", "--pretty=%b"], cwd=cwd).stdout.strip()


def remote_url(cwd: str) -> str:
    return git(["config", "--get", "remote.origin.url"], cwd=cwd).stdout.strip()


def parse_github_remote(url: str) -> tuple[str, str]:
    ssh_match = re.match(r"git@github\.com:(?P<owner>[^/]+)/(?P<repo>.+?)(?:\.git)?$", url)
    if ssh_match:
        return ssh_match.group("owner"), ssh_match.group("repo")

    https_match = re.match(r"https://github\.com/(?P<owner>[^/]+)/(?P<repo>.+?)(?:\.git)?$", url)
    if https_match:
        return https_match.group("owner"), https_match.group("repo")

    raise SystemExit(f"Unsupported GitHub remote URL: {url}")


def compare_url(owner: str, repo: str, branch: str, base: str) -> str:
    return f"https://github.com/{owner}/{repo}/compare/{base}...{branch}?expand=1"


def open_in_browser(url: str) -> bool:
    opener = None
    if shutil_which("xdg-open"):
        opener = ["xdg-open", url]
    elif shutil_which("open"):
        opener = ["open", url]
    if not opener:
        return False
    subprocess.Popen(opener, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return True


def shutil_which(binary: str) -> str | None:
    return run(["bash", "-lc", f"command -v {binary}"], check=False).stdout.strip() or None


def maybe_create_pr_with_gh(title: str, body: str, base: str, branch: str, draft: bool, cwd: str) -> str | None:
    if not shutil_which("gh"):
        return None
    if run(["gh", "auth", "status"], cwd=cwd, check=False).returncode != 0:
        return None

    command = ["gh", "pr", "create", "--base", base, "--head", branch, "--title", title, "--body", body]
    if draft:
        command.append("--draft")
    result = run(command, cwd=cwd)
    return result.stdout.strip().splitlines()[-1].strip()


def github_token() -> str | None:
    for key in ("GH_TOKEN", "GITHUB_TOKEN"):
        value = os.environ.get(key, "").strip()
        if value:
            return value
    return None


def github_api_request(method: str, url: str, token: str, payload: dict | None = None) -> dict:
    data = None
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "User-Agent": "codex-agent-git-pr-flow",
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.loads(response.read().decode("utf-8"))


def maybe_create_pr_with_token(owner: str, repo: str, title: str, body: str, base: str, branch: str, draft: bool) -> str | None:
    token = github_token()
    if not token:
        return None

    pulls_url = f"https://api.github.com/repos/{owner}/{repo}/pulls"
    payload = {
        "title": title,
        "body": body,
        "head": branch,
        "base": base,
        "draft": draft,
    }
    try:
        response = github_api_request("POST", pulls_url, token, payload)
        return response.get("html_url")
    except urllib.error.HTTPError as error:
        body_text = error.read().decode("utf-8", errors="replace")
        if error.code == 422 and "A pull request already exists" in body_text:
            query = urllib.parse.urlencode({"head": f"{owner}:{branch}", "base": base, "state": "open"})
            search_url = f"{pulls_url}?{query}"
            response = github_api_request("GET", search_url, token)
            if isinstance(response, list) and response:
                return response[0].get("html_url")
        raise SystemExit(f"GitHub API error ({error.code}): {body_text}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Create/switch branch, commit, push, and optionally open or create a GitHub PR.")
    parser.add_argument("--branch", help="Target feature branch. If omitted, use current branch.")
    parser.add_argument("--base", default="main", help="Base branch for PRs. Default: main")
    parser.add_argument("--message", help="Commit message for staged changes.")
    parser.add_argument("--title", help="PR title. Default: latest commit subject.")
    parser.add_argument("--body", help="PR body text.")
    parser.add_argument("--body-file", help="Read PR body from file.")
    parser.add_argument("--draft", action="store_true", help="Create draft PR.")
    parser.add_argument("--push-only", action="store_true", help="Only push the branch. Skip PR creation.")
    parser.add_argument("--allow-main", action="store_true", help="Allow operations to stay on the base branch without refusing.")
    parser.add_argument("--open-compare", action="store_true", help="Open compare URL in browser when PR cannot be created automatically.")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    cwd = repo_root()

    branch = current_branch(cwd)
    if args.branch and args.branch != branch:
        git(["switch", "-C", args.branch], cwd=cwd)
        branch = args.branch

    if branch == args.base and not args.allow_main and not args.push_only:
        raise SystemExit("Current branch sama dengan base branch. Gunakan --branch untuk branch fitur atau --allow-main jika memang sengaja.")

    dirty = working_tree_dirty(cwd)
    if dirty:
        git(["add", "-A"], cwd=cwd)
        commit_message = (args.message or "").strip()
        if not commit_message:
            raise SystemExit("Working tree punya perubahan, tapi --message belum diberikan untuk commit.")
        git(["commit", "-m", commit_message], cwd=cwd)
    else:
        print("Working tree bersih. Tidak ada commit baru.")

    if upstream_exists(branch, cwd):
        git(["push", "origin", branch], cwd=cwd)
    else:
        git(["push", "-u", "origin", branch], cwd=cwd)

    if args.push_only or branch == args.base:
        print(f"Push selesai untuk branch {branch}.")
        return 0

    title = (args.title or latest_commit_subject(cwd) or f"Update {branch}").strip()
    if args.body_file:
        body = Path(args.body_file).read_text().strip()
    else:
        body = (args.body or latest_commit_body(cwd) or f"Automated PR for branch `{branch}`.").strip()

    owner, repo = parse_github_remote(remote_url(cwd))

    pr_url = maybe_create_pr_with_gh(title, body, args.base, branch, args.draft, cwd)
    if not pr_url:
        pr_url = maybe_create_pr_with_token(owner, repo, title, body, args.base, branch, args.draft)

    if pr_url:
        print(f"PR created: {pr_url}")
        return 0

    url = compare_url(owner, repo, branch, args.base)
    print(f"PR automation butuh gh auth atau GH_TOKEN/GITHUB_TOKEN. Compare URL: {url}")
    if args.open_compare:
        opened = open_in_browser(url)
        print("Opened compare URL in browser." if opened else "Tidak bisa membuka browser otomatis.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
