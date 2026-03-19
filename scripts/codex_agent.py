#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import shlex
import shutil
import sqlite3
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

APP_TITLE = "Codex Agent"
ROOT_DIR = Path(__file__).resolve().parent.parent
STATE_DIR = Path.home() / ".local" / "state" / "ai-agent-hub"
STATE_PATH = STATE_DIR / "workspace-state.json"
CODEX_STATE_DB = Path.home() / ".codex" / "state_5.sqlite"
LAUNCH_SCRIPT = ROOT_DIR / "scripts" / "launch-cli-hub.sh"
SWARM_LAUNCH_SCRIPT = ROOT_DIR / "scripts" / "launch-agent-swarm.sh"
SWARM_PROFILES_PATH = ROOT_DIR / "config" / "swarm-profiles.json"
ENTRY_MODES = ("grid", "swarm")
SUPPORTED_PANEL_COUNTS = (2, 4, 5, 6)
WORKSPACE_MODES = ("shared", "split")
UI_MODES = ("auto", "fzf", "whiptail", "text")
MAX_WORKSPACE_ENTRIES = 80
MAX_LAUNCH_PRESETS = 12


class UserCancelled(Exception):
    pass


@dataclass
class WorkspaceRecord:
    path: str
    favorite: bool = False
    use_count: int = 0
    last_used_at: str = ""
    imported_from_codex: bool = False

    def to_json(self) -> dict:
        return {
            "path": self.path,
            "favorite": self.favorite,
            "use_count": self.use_count,
            "last_used_at": self.last_used_at,
            "imported_from_codex": self.imported_from_codex,
        }

    @property
    def label(self) -> str:
        name = Path(self.path).name.strip()
        return name or self.path

    @property
    def last_used_display(self) -> str:
        if not self.last_used_at:
            return "belum pernah"
        try:
            dt = datetime.fromisoformat(self.last_used_at)
            return dt.astimezone().strftime("%Y-%m-%d %H:%M")
        except ValueError:
            return self.last_used_at


class WorkspaceStore:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.version = 1
        self.last_panel_count = 6
        self.last_workspace_mode = "shared"
        self.last_entry_mode = "grid"
        self.last_swarm_profile = "adaptive"
        self.workspaces: dict[str, WorkspaceRecord] = {}
        self.recent_launches: list[dict] = []
        self.needs_rewrite = False

    @classmethod
    def load(cls, path: Path) -> "WorkspaceStore":
        store = cls(path)
        if path.exists():
            payload, warning, needs_rewrite = load_state_payload(path)
            if warning:
                print(warning, file=sys.stderr)
            store.needs_rewrite = needs_rewrite
            store.version = int(payload.get("version", 1))
            store.last_panel_count = int(payload.get("last_panel_count", 6))
            store.last_workspace_mode = str(payload.get("last_workspace_mode", "shared"))
            store.last_entry_mode = str(payload.get("last_entry_mode", "grid"))
            store.last_swarm_profile = str(payload.get("last_swarm_profile", "adaptive"))
            for raw in payload.get("workspaces", []):
                record = WorkspaceRecord(
                    path=normalize_path(raw["path"]),
                    favorite=bool(raw.get("favorite", False)),
                    use_count=int(raw.get("use_count", 0)),
                    last_used_at=str(raw.get("last_used_at", "")),
                    imported_from_codex=bool(raw.get("imported_from_codex", False)),
                )
                store.workspaces[record.path] = record
            store.recent_launches = [
                {
                    "created_at": str(item.get("created_at", "")),
                    "panel_count": int(item.get("panel_count", 0)),
                    "workspace_mode": str(item.get("workspace_mode", "shared")),
                    "workspaces": [normalize_path(p) for p in item.get("workspaces", [])],
                }
                for item in payload.get("recent_launches", [])
            ]
        store.import_codex_history()
        if store.needs_rewrite:
            store.save()
        return store

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "version": self.version,
            "last_panel_count": self.last_panel_count,
            "last_workspace_mode": self.last_workspace_mode,
            "last_entry_mode": self.last_entry_mode,
            "last_swarm_profile": self.last_swarm_profile,
            "workspaces": [item.to_json() for item in self.sorted_records(include_missing=True)],
            "recent_launches": self.recent_launches[:MAX_LAUNCH_PRESETS],
        }
        write_text_atomic(self.path, json.dumps(payload, indent=2) + "\n")
        self.needs_rewrite = False

    def import_codex_history(self) -> None:
        if not CODEX_STATE_DB.exists():
            return

        try:
            conn = sqlite3.connect(CODEX_STATE_DB)
            cur = conn.cursor()
            cur.execute(
                """
                SELECT cwd, MAX(updated_at) AS last_used
                FROM threads
                WHERE cwd IS NOT NULL AND cwd != ''
                GROUP BY cwd
                ORDER BY last_used DESC
                LIMIT ?
                """,
                (MAX_WORKSPACE_ENTRIES,),
            )
            rows = cur.fetchall()
        except sqlite3.Error:
            return
        finally:
            try:
                conn.close()
            except Exception:
                pass

        for cwd, ts in rows:
            path = normalize_path(cwd)
            if not is_valid_workspace(path):
                continue
            record = self.workspaces.get(path)
            iso_ts = iso_from_timestamp(ts)
            if record is None:
                self.workspaces[path] = WorkspaceRecord(
                    path=path,
                    favorite=False,
                    use_count=0,
                    last_used_at=iso_ts,
                    imported_from_codex=True,
                )
                continue
            if is_newer_iso(iso_ts, record.last_used_at):
                record.last_used_at = iso_ts

    def sorted_records(self, include_missing: bool = False) -> list[WorkspaceRecord]:
        items = list(self.workspaces.values())
        if not include_missing:
            items = [item for item in items if is_valid_workspace(item.path)]
        return sorted(
            items,
            key=lambda item: (
                0 if item.favorite else 1,
                item.last_used_at or "",
                item.use_count,
                item.label.lower(),
            ),
            reverse=True,
        )

    def recent_candidates(self, excluded: set[str] | None = None) -> list[WorkspaceRecord]:
        excluded = excluded or set()
        return [item for item in self.sorted_records() if item.path not in excluded][:MAX_WORKSPACE_ENTRIES]

    def touch(self, path: str) -> WorkspaceRecord:
        path = normalize_path(path)
        record = self.workspaces.get(path)
        if record is None:
            record = WorkspaceRecord(path=path)
            self.workspaces[path] = record
        record.use_count += 1
        record.last_used_at = now_iso()
        record.imported_from_codex = False
        return record

    def set_favorite(self, path: str, favorite: bool) -> None:
        path = normalize_path(path)
        record = self.workspaces.get(path)
        if record is None:
            record = WorkspaceRecord(path=path)
            self.workspaces[path] = record
        record.favorite = favorite

    def update_favorites(self, selected_paths: Iterable[str], chosen_favorites: set[str]) -> None:
        for raw_path in selected_paths:
            path = normalize_path(raw_path)
            self.set_favorite(path, path in chosen_favorites)

    def add_launch(self, panel_count: int, workspace_mode: str, workspaces: list[str]) -> None:
        normalized = [normalize_path(path) for path in workspaces]
        launch = {
            "created_at": now_iso(),
            "panel_count": panel_count,
            "workspace_mode": workspace_mode,
            "workspaces": normalized,
        }
        deduped = [
            item
            for item in self.recent_launches
            if not (
                item.get("panel_count") == panel_count
                and item.get("workspace_mode") == workspace_mode
                and item.get("workspaces") == normalized
            )
        ]
        self.recent_launches = [launch, *deduped][:MAX_LAUNCH_PRESETS]

    def matching_launches(self, panel_count: int, workspace_mode: str) -> list[dict]:
        matches = []
        for item in self.recent_launches:
            if item.get("panel_count") != panel_count:
                continue
            if item.get("workspace_mode") != workspace_mode:
                continue
            workspaces = [normalize_path(path) for path in item.get("workspaces", [])]
            if not workspaces:
                continue
            if workspace_mode == "shared":
                if len(workspaces) != 1:
                    continue
            else:
                if len(workspaces) != panel_count:
                    continue
            if not all(is_valid_workspace(path) for path in workspaces):
                continue
            matches.append({**item, "workspaces": workspaces})
        return matches


def normalize_path(raw: str) -> str:
    return os.path.abspath(os.path.expanduser(raw.strip()))


def is_valid_workspace(path: str) -> bool:
    return Path(path).expanduser().is_dir()


def now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def parse_iso(value: str) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None


def is_newer_iso(candidate: str, current: str) -> bool:
    candidate_dt = parse_iso(candidate)
    if candidate_dt is None:
        return False
    current_dt = parse_iso(current)
    if current_dt is None:
        return True
    return candidate_dt > current_dt


def iso_from_timestamp(value: object) -> str:
    try:
        if value is None:
            return ""
        return datetime.fromtimestamp(int(value), tz=timezone.utc).astimezone().isoformat(timespec="seconds")
    except Exception:
        return ""


def backup_corrupt_state(path: Path, raw_text: str) -> Path:
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    backup_path = path.with_name(f"{path.stem}.corrupt-{stamp}{path.suffix}")
    write_text_atomic(backup_path, raw_text)
    return backup_path


def load_state_payload(path: Path) -> tuple[dict, str | None, bool]:
    raw_text = path.read_text()
    if not raw_text.strip():
        return {}, None, False

    try:
        payload = json.loads(raw_text)
    except json.JSONDecodeError:
        decoder = json.JSONDecoder()
        try:
            payload, end = decoder.raw_decode(raw_text)
        except json.JSONDecodeError:
            backup_path = backup_corrupt_state(path, raw_text)
            return (
                {},
                f"Workspace state korup. Backup dibuat di {backup_path}. State direset.",
                True,
            )

        trailing = raw_text[end:].strip()
        if trailing:
            backup_path = backup_corrupt_state(path, raw_text)
            return (
                payload if isinstance(payload, dict) else {},
                f"Workspace state dipulihkan dari JSON yang punya trailing data. Backup dibuat di {backup_path}.",
                True,
            )
    if not isinstance(payload, dict):
        backup_path = backup_corrupt_state(path, raw_text)
        return (
            {},
            f"Workspace state tidak berbentuk object JSON. Backup dibuat di {backup_path}. State direset.",
            True,
        )
    return payload, None, False


def write_text_atomic(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", delete=False, dir=path.parent, prefix=f".{path.name}.", suffix=".tmp") as handle:
        handle.write(content)
        handle.flush()
        os.fsync(handle.fileno())
        temp_path = Path(handle.name)
    temp_path.replace(path)


def run_command(command: list[str], *, input_text: str | None = None, check: bool = False) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, input=input_text, text=True, capture_output=True, check=check)


def run_whiptail(args: list[str]) -> str:
    command = ["whiptail", "--output-fd", "1", *args]
    result = subprocess.run(command, text=True, capture_output=True)
    if result.returncode == 0:
        return result.stdout.strip()
    raise UserCancelled()


def whiptail_radiolist(title: str, prompt: str, items: list[tuple[str, str, bool]]) -> str:
    height = min(24, max(16, len(items) + 10))
    width = 110
    menu_height = min(12, max(6, len(items)))
    args = ["--title", title, "--radiolist", prompt, str(height), str(width), str(menu_height)]
    for tag, desc, selected in items:
        args.extend([tag, desc, "ON" if selected else "OFF"])
    return run_whiptail(args)


def whiptail_yesno(title: str, prompt: str, default_yes: bool = True) -> bool:
    args = ["--title", title]
    if not default_yes:
        args.append("--defaultno")
    args.extend(["--yesno", prompt, "14", "78"])
    result = subprocess.run(["whiptail", *args], text=True, capture_output=True)
    if result.returncode == 0:
        return True
    if result.returncode == 1:
        return False
    raise UserCancelled()


def whiptail_inputbox(title: str, prompt: str, default: str = "") -> str:
    args = ["--title", title, "--inputbox", prompt, "14", "96", default]
    return run_whiptail(args)


def whiptail_checklist(title: str, prompt: str, items: list[tuple[str, str, bool]]) -> set[str]:
    height = min(24, max(16, len(items) + 10))
    width = 110
    menu_height = min(12, max(6, len(items)))
    args = ["--title", title, "--checklist", prompt, str(height), str(width), str(menu_height)]
    for tag, desc, selected in items:
        args.extend([tag, desc, "ON" if selected else "OFF"])
    raw = run_whiptail(args)
    if not raw:
        return set()
    return {normalize_path(item) for item in shlex.split(raw)}


def fzf_select(entries: list[tuple[str, str]], *, prompt: str, header: str) -> str:
    if not shutil.which("fzf"):
        raise RuntimeError("fzf is required for workspace search.")
    payload = "\n".join(f"{key}\t{label}" for key, label in entries)
    command = [
        "fzf",
        "--ansi",
        "--delimiter=\t",
        "--with-nth=2..",
        "--prompt",
        prompt,
        "--header",
        header,
        "--height",
        "85%",
        "--layout",
        "reverse",
        "--border",
        "rounded",
        "--cycle",
    ]
    result = subprocess.run(command, input=payload, text=True, capture_output=True)
    if result.returncode != 0:
        raise UserCancelled()
    return result.stdout.split("\t", 1)[0].strip()


def fzf_multiselect(entries: list[tuple[str, str]], *, prompt: str, header: str) -> set[str]:
    if not shutil.which("fzf"):
        raise RuntimeError("fzf is required for workspace search.")
    payload = "\n".join(f"{key}\t{label}" for key, label in entries)
    command = [
        "fzf",
        "--multi",
        "--ansi",
        "--delimiter=\t",
        "--with-nth=2..",
        "--prompt",
        prompt,
        "--header",
        header,
        "--height",
        "85%",
        "--layout",
        "reverse",
        "--border",
        "rounded",
        "--cycle",
    ]
    result = subprocess.run(command, input=payload, text=True, capture_output=True)
    if result.returncode != 0:
        raise UserCancelled()
    return {
        normalize_path(line.split("\t", 1)[0].strip())
        for line in result.stdout.splitlines()
        if line.strip()
    }


def requested_ui_mode() -> str:
    raw = (os.environ.get("CODEX_AGENT_UI") or "auto").strip().lower()
    return raw if raw in UI_MODES else "auto"


def terminal_supports_rich_ui() -> bool:
    term = (os.environ.get("TERM") or "").strip().lower()
    return bool(sys.stdin.isatty() and sys.stdout.isatty() and term and term not in {"dumb", "unknown"})


def available_ui_modes() -> list[str]:
    requested = requested_ui_mode()
    if requested != "auto":
        return [requested]

    if terminal_supports_rich_ui():
        modes = []
        if shutil.which("fzf"):
            modes.append("fzf")
        if shutil.which("whiptail"):
            modes.append("whiptail")
        modes.append("text")
        return modes

    return ["text"]


def text_menu_select(title: str, prompt: str, items: list[tuple[str, str]], *, default: str | None = None) -> str:
    if not items:
        raise RuntimeError(f"{title}: tidak ada opsi yang tersedia.")

    print(f"\n[{title}]")
    print(prompt)
    for index, (tag, desc) in enumerate(items, start=1):
        marker = " (default)" if tag == default else ""
        print(f"{index}. {desc}{marker}")

    default_index = next((index for index, (tag, _desc) in enumerate(items, start=1) if tag == default), 1)
    while True:
        raw = input(f"Pilih nomor [default {default_index}]: ").strip()
        if not raw:
            return items[default_index - 1][0]
        if raw.isdigit():
            choice_index = int(raw)
            if 1 <= choice_index <= len(items):
                return items[choice_index - 1][0]
        print("Pilihan tidak valid.")


def text_multiselect(title: str, prompt: str, items: list[tuple[str, str, bool]]) -> set[str]:
    if not items:
        return set()

    print(f"\n[{title}]")
    print(prompt)
    for index, (tag, desc, selected) in enumerate(items, start=1):
        marker = "x" if selected else " "
        print(f"{index}. [{marker}] {desc}")

    defaults = [str(index) for index, (_tag, _desc, selected) in enumerate(items, start=1) if selected]
    default_text = ",".join(defaults) if defaults else "-"
    raw = input(f"Pilih nomor dipisah koma [default {default_text}]: ").strip()
    if not raw:
        return {normalize_path(tag) for tag, _desc, selected in items if selected}

    chosen = set()
    for part in raw.split(","):
        token = part.strip()
        if not token:
            continue
        if not token.isdigit():
            print(f"Lewati input tidak valid: {token}")
            continue
        choice_index = int(token)
        if 1 <= choice_index <= len(items):
            chosen.add(normalize_path(items[choice_index - 1][0]))
    return chosen


def menu_select(title: str, prompt: str, items: list[tuple[str, str]], *, default: str | None = None) -> str:
    last_error: Exception | None = None
    for mode in available_ui_modes():
        try:
            if mode == "fzf":
                return fzf_select(items, prompt=f"{title} > ", header=prompt)
            if mode == "whiptail":
                radiolist_items = [(tag, desc, tag == default) for tag, desc in items]
                return whiptail_radiolist(title, prompt, radiolist_items)
            return text_menu_select(title, prompt, items, default=default)
        except UserCancelled:
            raise
        except Exception as error:
            last_error = error
    raise RuntimeError(f"Tidak ada UI menu yang berhasil dipakai. {last_error}")


def workspace_menu_select(title: str, prompt: str, items: list[tuple[str, str]]) -> str:
    return menu_select(title, prompt, items, default=items[0][0] if items else None)


def input_prompt(title: str, prompt: str, default: str = "") -> str:
    for mode in available_ui_modes():
        try:
            if mode == "whiptail":
                return whiptail_inputbox(title, prompt, default=default)
            break
        except UserCancelled:
            raise
        except Exception:
            continue
    raw = input(f"{prompt} [{default}]: ").strip()
    return raw or default


def confirm_prompt(title: str, prompt: str, default_yes: bool = True) -> bool:
    for mode in available_ui_modes():
        try:
            if mode == "whiptail":
                return whiptail_yesno(title, prompt, default_yes=default_yes)
            break
        except UserCancelled:
            raise
        except Exception:
            continue
    suffix = "Y/n" if default_yes else "y/N"
    raw = input(f"{prompt} ({suffix}): ").strip().lower()
    if not raw:
        return default_yes
    return raw in {"y", "yes"}


def choose_panel_count(default: int) -> int:
    options = [
        ("2", "2 agent • kiri dan kanan 50:50"),
        ("4", "4 agent • dua kiri dan dua kanan (grid 2x2)"),
        ("5", "5 agent • mode padat laptop"),
        ("6", "6 agent • mode maksimal laptop"),
    ]
    choice = menu_select(APP_TITLE, "Pilih berapa agent yang mau dipanggil.", options, default=str(default))
    return int(choice)


def choose_launch_mode(default: str) -> str:
    options = [
        ("grid", "Grid CLI multi-agent biasa"),
        ("swarm", "Agent Swarm otonom dengan aplikasi desktop live"),
    ]
    return menu_select(APP_TITLE, "Pilih mode awal Codex Agent.", options, default=default)


def choose_workspace_mode(default: str) -> str:
    options = [
        ("shared", "Satu workspace untuk semua agent"),
        ("split", "Setiap agent pilih workspace sendiri"),
    ]
    return menu_select(APP_TITLE, "Pilih strategi workspace untuk agent.", options, default=default)


def load_swarm_profiles() -> dict:
    if not SWARM_PROFILES_PATH.exists():
        return {"adaptive": {"label": "Adaptive Autonomous Swarm", "description": "Default swarm profile."}}
    try:
        return json.loads(SWARM_PROFILES_PATH.read_text())
    except json.JSONDecodeError:
        return {"adaptive": {"label": "Adaptive Autonomous Swarm", "description": "Default swarm profile."}}


def choose_swarm_profile(default: str) -> str:
    profiles = load_swarm_profiles()
    options = [
        (profile_id, f"{profile.get('label', profile_id)} • {profile.get('description', '')}".strip(" •"))
        for profile_id, profile in profiles.items()
    ]
    default_choice = default if default in profiles else options[0][0]
    return menu_select(APP_TITLE, "Pilih profile Agent Swarm.", options, default=default_choice)


def choose_swarm_objective(default: str = "") -> str:
    while True:
        objective = input_prompt(APP_TITLE, "Masukkan objective Agent Swarm.", default=default).strip()
        if objective:
            return objective
        show_message("Objective Agent Swarm tidak boleh kosong.")


def choose_swarm_search(default_enabled: bool = False) -> bool:
    return confirm_prompt(
        APP_TITLE,
        "Aktifkan live web search global untuk Agent Swarm?\n\nGunakan ini jika objective butuh riset eksternal atau data yang berubah cepat.",
        default_yes=default_enabled,
    )


def summarize_launch(launch: dict) -> str:
    workspaces = launch.get("workspaces", [])
    names = ", ".join(Path(path).name or path for path in workspaces[:4])
    if len(workspaces) > 4:
        names = f"{names}, +{len(workspaces) - 4} lainnya"
    created = launch.get("created_at", "")
    if created:
        try:
            created = datetime.fromisoformat(created).astimezone().strftime("%Y-%m-%d %H:%M")
        except ValueError:
            pass
    return f"{created} • {names}".strip(" •")


def choose_launch_preset(store: WorkspaceStore, panel_count: int, workspace_mode: str) -> list[str] | None:
    matches = store.matching_launches(panel_count, workspace_mode)
    if not matches:
        return None

    options = [("manual", "Pilih workspace manual")] + [
        (f"launch:{index}", summarize_launch(launch)) for index, launch in enumerate(matches)
    ]
    choice = menu_select(
        APP_TITLE,
        "Ditemukan history workspace yang cocok. Mau lanjutkan yang lama atau pilih manual?",
        options,
        default="launch:0",
    )
    if choice == "manual":
        return None
    index = int(choice.split(":", 1)[1])
    return matches[index]["workspaces"]


def browse_workspace(start_dir: str) -> str | None:
    if os.environ.get("DISPLAY") and shutil.which("kdialog"):
        result = run_command(["kdialog", "--title", APP_TITLE, "--getexistingdirectory", start_dir])
        if result.returncode == 0:
            value = result.stdout.strip()
            return normalize_path(value) if value else None
        return None

    if os.environ.get("DISPLAY") and shutil.which("zenity"):
        result = run_command(["zenity", "--file-selection", "--directory", "--filename", start_dir])
        if result.returncode == 0:
            value = result.stdout.strip()
            return normalize_path(value) if value else None
        return None

    manual = input_prompt(APP_TITLE, "Masukkan path workspace.", default=start_dir)
    return normalize_path(manual) if manual else None


def choose_workspace(store: WorkspaceStore, *, title: str, current_dir: str, excluded: set[str]) -> str:
    while True:
        entries: list[tuple[str, str]] = [
            ("action:browse", "➕ Browse directory dengan system picker"),
            ("action:manual", "⌨ Ketik path workspace manual"),
            ("action:current", f"📂 Pakai current directory  {current_dir}"),
        ]

        records = store.recent_candidates(excluded=excluded)
        for index, record in enumerate(records):
            badge = "★" if record.favorite else "•"
            source = "favorite" if record.favorite else "recent"
            detail = f"{badge} {record.label}   {record.path}   [{source} • dipakai {record.use_count}x • {record.last_used_display}]"
            entries.append((f"workspace:{index}", detail))

        selection = workspace_menu_select(
            title,
            "Cari workspace. Favorites tampil di atas. Pilih manual atau recent bila perlu.",
            entries,
        )

        if selection == "action:browse":
            picked = browse_workspace(current_dir)
        elif selection == "action:manual":
            raw = input_prompt(APP_TITLE, f"Masukkan path untuk {title}.", default=current_dir)
            picked = normalize_path(raw) if raw else None
        elif selection == "action:current":
            picked = normalize_path(current_dir)
        else:
            picked = records[int(selection.split(":", 1)[1])].path

        if not picked:
            continue
        if picked in excluded:
            show_message(f"Workspace {picked} sudah dipakai agent lain. Pilih workspace berbeda.")
            continue
        if not is_valid_workspace(picked):
            show_message(f"Directory tidak valid: {picked}")
            continue
        return picked


def choose_workspaces(store: WorkspaceStore, panel_count: int, workspace_mode: str, current_dir: str) -> list[str]:
    preset = choose_launch_preset(store, panel_count, workspace_mode)
    if preset:
        return preset

    if workspace_mode == "shared":
        workspace = choose_workspace(store, title="Workspace bersama", current_dir=current_dir, excluded=set())
        return [workspace]

    chosen: list[str] = []
    for number in range(1, panel_count + 1):
        workspace = choose_workspace(
            store,
            title=f"Workspace Agent {number:02d}",
            current_dir=current_dir,
            excluded=set(chosen),
        )
        chosen.append(workspace)
    return chosen


def choose_favorites(store: WorkspaceStore, selected_workspaces: list[str]) -> set[str]:
    unique_workspaces = [normalize_path(path) for path in dict.fromkeys(selected_workspaces)]
    items = []
    for path in unique_workspaces:
        record = store.workspaces.get(path, WorkspaceRecord(path=path))
        items.append((path, f"{record.label}  •  {path}", record.favorite))
    defaults = {path for path, _, selected in items if selected}
    for mode in available_ui_modes():
        try:
            if mode == "whiptail":
                return whiptail_checklist(
                    APP_TITLE,
                    "Tandai workspace yang ingin disimpan sebagai favorite.",
                    items,
                )
            if mode == "fzf":
                return fzf_multiselect(
                    items,
                    prompt="Favorites > ",
                    header="Pilih satu atau lebih workspace favorite. Tab untuk multi-select, Enter untuk simpan.",
                )
            return text_multiselect(APP_TITLE, "Tandai workspace yang ingin disimpan sebagai favorite.", items)
        except UserCancelled:
            return defaults
        except Exception:
            continue
    return defaults


def show_message(message: str) -> None:
    for mode in available_ui_modes():
        if mode == "whiptail":
            subprocess.run(["whiptail", "--title", APP_TITLE, "--msgbox", message, "14", "78"], text=True)
            return
    print(message)


def confirm_launch(panel_count: int, workspace_mode: str, workspaces: list[str]) -> None:
    lines = [
        f"Mode agent : {panel_count}",
        f"Workspace  : {'Satu workspace untuk semua agent' if workspace_mode == 'shared' else 'Setiap agent beda workspace'}",
        "",
    ]
    if workspace_mode == "shared":
        lines.append(f"Semua agent -> {workspaces[0]}")
    else:
        for index, path in enumerate(workspaces, start=1):
            lines.append(f"Agent {index:02d} -> {path}")
    prompt = "\n".join(lines)
    if not confirm_prompt(APP_TITLE, f"{prompt}\n\nLanjut launch Codex Agent?", default_yes=True):
        raise UserCancelled()


def confirm_swarm_launch(objective: str, workspace: str, profile: str, search_enabled: bool) -> None:
    prompt = "\n".join(
        [
            f"Mode      : Agent Swarm",
            f"Profile   : {profile}",
            f"Workspace : {workspace}",
            f"Search    : {'aktif' if search_enabled else 'nonaktif'}",
            "",
            "Objective:",
            objective,
        ]
    )
    if not confirm_prompt(APP_TITLE, f"{prompt}\n\nLanjut launch Agent Swarm?", default_yes=True):
        raise UserCancelled()


def launch_agents(panel_count: int, workspace_mode: str, workspaces: list[str], detached: bool, session_name: str | None) -> int:
    env = os.environ.copy()
    env["AI_AGENT_HUB_WORKSPACE_MODE"] = workspace_mode
    if detached:
        env["AI_AGENT_HUB_DETACHED"] = "1"
    if session_name:
        env["TMUX_SESSION_NAME"] = session_name
    if workspace_mode == "shared":
        env["CODEX_WORKSPACE"] = workspaces[0]
    with tempfile.NamedTemporaryFile("w", delete=False, prefix="ai-agent-hub-workspaces-", suffix=".txt") as handle:
        for path in workspaces:
            handle.write(f"{path}\n")
        temp_path = handle.name
    env["AI_AGENT_HUB_WORKSPACES_FILE"] = temp_path
    try:
        result = subprocess.run([str(LAUNCH_SCRIPT), str(panel_count)], env=env)
        return result.returncode
    finally:
        Path(temp_path).unlink(missing_ok=True)


def launch_swarm(workspace: str, objective: str, profile: str, search_enabled: bool) -> int:
    env = os.environ.copy()
    env["SWARM_WORKSPACE"] = workspace
    env["SWARM_OBJECTIVE"] = objective
    env["SWARM_PROFILE"] = profile
    env["SWARM_SEARCH"] = "1" if search_enabled else "0"
    result = subprocess.run([str(SWARM_LAUNCH_SCRIPT)], env=env)
    return result.returncode


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Interactive Codex Agent launcher")
    parser.add_argument("--launch-mode", choices=ENTRY_MODES)
    parser.add_argument("--panel-count", type=int, choices=SUPPORTED_PANEL_COUNTS)
    parser.add_argument("--workspace-mode", choices=WORKSPACE_MODES)
    parser.add_argument("--ui", choices=UI_MODES, help="Override menu UI mode")
    parser.add_argument("--workspace", action="append", default=[], help="Repeat for split mode")
    parser.add_argument("--objective", help="Objective for swarm mode")
    parser.add_argument("--profile", help="Swarm profile id")
    parser.add_argument("--search", action="store_true", help="Enable live web search for swarm mode")
    parser.add_argument("--detached", action="store_true", help="Prepare tmux session without opening Alacritty")
    parser.add_argument("--session-name", help="Override tmux session name")
    parser.add_argument("--no-shell-install", action="store_true", help=argparse.SUPPRESS)
    return parser


def ensure_noninteractive_args(panel_count: int | None, workspace_mode: str | None, workspaces: list[str]) -> None:
    if panel_count is None or workspace_mode is None:
        raise SystemExit("Non-interactive launch requires --panel-count and --workspace-mode.")
    if workspace_mode == "shared" and len(workspaces) != 1:
        raise SystemExit("Shared workspace mode requires exactly one --workspace.")
    if workspace_mode == "split" and len(workspaces) != panel_count:
        raise SystemExit(f"Split workspace mode requires {panel_count} --workspace values.")


def default_session_name(panel_count: int, workspace_mode: str, workspaces: list[str]) -> str:
    base = Path(workspaces[0]).name or "workspace"
    stamp = datetime.now().strftime("%m%d-%H%M%S")
    return f"codex-agent-{workspace_mode}-{panel_count}-{base}-{stamp}".replace(" ", "-")


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    if args.ui:
        os.environ["CODEX_AGENT_UI"] = args.ui
    store = WorkspaceStore.load(STATE_PATH)
    cwd = normalize_path(os.getcwd())
    panel_count: int | None = None
    workspace_mode: str | None = None
    workspaces: list[str] = []
    chosen_favorites: set[str] = set()

    interactive = sys.stdin.isatty() and sys.stdout.isatty() and not args.workspace

    if interactive:
        try:
            entry_mode = args.launch_mode or choose_launch_mode(store.last_entry_mode if store.last_entry_mode in ENTRY_MODES else "grid")
            if entry_mode == "grid":
                panel_count = choose_panel_count(store.last_panel_count if store.last_panel_count in SUPPORTED_PANEL_COUNTS else 6)
                workspace_mode = choose_workspace_mode(store.last_workspace_mode if store.last_workspace_mode in WORKSPACE_MODES else "shared")
                workspaces = choose_workspaces(store, panel_count, workspace_mode, cwd)
                confirm_launch(panel_count, workspace_mode, workspaces)
                chosen_favorites = choose_favorites(store, workspaces)
            else:
                swarm_profile = choose_swarm_profile(store.last_swarm_profile)
                swarm_workspace = choose_workspace(store, title="Workspace Agent Swarm", current_dir=cwd, excluded=set())
                swarm_objective = choose_swarm_objective()
                search_enabled = choose_swarm_search(default_enabled=args.search)
                confirm_swarm_launch(swarm_objective, swarm_workspace, swarm_profile, search_enabled)
                chosen_favorites = choose_favorites(store, [swarm_workspace])
        except UserCancelled:
            print("Launch dibatalkan.")
            return 1
    else:
        entry_mode = args.launch_mode or "grid"

    if entry_mode == "swarm":
        if interactive:
            workspace = swarm_workspace
            objective = swarm_objective
            profile = swarm_profile
        else:
            objective = (args.objective or "").strip()
            if not objective:
                raise SystemExit("Swarm mode requires --objective.")
            workspace_values = [normalize_path(path) for path in args.workspace] if args.workspace else [cwd]
            if len(workspace_values) != 1:
                raise SystemExit("Swarm mode accepts exactly one workspace.")
            workspace = workspace_values[0]
            if not is_valid_workspace(workspace):
                raise SystemExit(f"Workspace tidak valid: {workspace}")
            swarm_profiles = load_swarm_profiles()
            profile = args.profile or store.last_swarm_profile or "adaptive"
            if profile not in swarm_profiles:
                raise SystemExit(f"Swarm profile tidak dikenal: {profile}")
            search_enabled = args.search
            chosen_favorites = {path for path in [workspace] if store.workspaces.get(path, WorkspaceRecord(path)).favorite}

        store.touch(workspace)
        store.update_favorites([workspace], chosen_favorites)
        store.last_entry_mode = "swarm"
        store.last_swarm_profile = profile
        store.save()
        return launch_swarm(workspace, objective, profile, search_enabled)

    if not interactive:
        ensure_noninteractive_args(args.panel_count, args.workspace_mode, args.workspace)
        panel_count = args.panel_count
        workspace_mode = args.workspace_mode
        workspaces = [normalize_path(path) for path in args.workspace]
        if workspace_mode == "split" and len(set(workspaces)) != len(workspaces):
            raise SystemExit("Split workspace mode requires tiap agent memakai directory yang berbeda.")
        for path in workspaces:
            if not is_valid_workspace(path):
                raise SystemExit(f"Workspace tidak valid: {path}")
        chosen_favorites = {path for path in workspaces if store.workspaces.get(path, WorkspaceRecord(path)).favorite}

    if panel_count is None or workspace_mode is None or not workspaces:
        raise SystemExit("Grid launch belum memiliki konfigurasi panel/workspace yang lengkap.")

    session_name = args.session_name or default_session_name(panel_count, workspace_mode, workspaces)

    for path in workspaces:
        store.touch(path)
    store.update_favorites(workspaces, chosen_favorites)
    store.last_entry_mode = "grid"
    store.last_panel_count = panel_count
    store.last_workspace_mode = workspace_mode
    store.add_launch(panel_count, workspace_mode, workspaces)
    store.save()

    return launch_agents(panel_count, workspace_mode, workspaces, args.detached, session_name)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(130)
