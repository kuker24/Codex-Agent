#!/usr/bin/env python3
from __future__ import annotations

import re

BRANCH_TYPES = (
    "feat",
    "fix",
    "chore",
    "docs",
    "refactor",
    "test",
    "perf",
    "ci",
    "build",
    "release",
    "hotfix",
)


def slugify(value: str) -> str:
    text = value.strip().lower()
    text = re.sub(r"[^a-z0-9]+", "-", text)
    text = re.sub(r"-+", "-", text).strip("-./")
    if not text:
        raise ValueError("branch slug kosong setelah dinormalisasi")
    return text


def build_branch_name(
    branch_type: str,
    *,
    slug: str,
    scope: str | None = None,
    ticket: str | None = None,
) -> str:
    normalized_type = slugify(branch_type)
    if normalized_type not in BRANCH_TYPES:
        raise ValueError(f"branch type tidak valid: {branch_type}")

    parts = [normalized_type]
    if scope:
        parts.append(slugify(scope))

    leaf_parts: list[str] = []
    if ticket:
        leaf_parts.append(slugify(ticket))
    leaf_parts.append(slugify(slug))
    parts.append("-".join(leaf_parts))
    return "/".join(parts)
