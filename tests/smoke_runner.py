#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import pty
import select
import shutil
import socket
import subprocess
import sys
import tempfile
import textwrap
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[1]


class SmokeFailure(RuntimeError):
    pass


def log(message: str) -> None:
    print(f"[smoke] {message}")


def require(condition: bool, message: str) -> None:
    if not condition:
        raise SmokeFailure(message)


def run(
    command: list[str],
    *,
    env: dict[str, str] | None = None,
    cwd: Path | None = None,
    timeout: int = 30,
    check: bool = True,
) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        command,
        cwd=str(cwd or ROOT_DIR),
        env=env,
        text=True,
        capture_output=True,
        timeout=timeout,
    )
    if check and result.returncode != 0:
        raise SmokeFailure(
            f"Command failed ({result.returncode}): {' '.join(command)}\nSTDOUT:\n{result.stdout}\nSTDERR:\n{result.stderr}"
        )
    return result


def random_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        sock.listen(1)
        return int(sock.getsockname()[1])


def http_json(url: str, *, method: str = "GET", payload: dict | None = None, timeout: int = 10) -> dict:
    data = None
    headers = {}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["content-type"] = "application/json"
    request = urllib.request.Request(url, data=data, method=method, headers=headers)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def wait_for_http_json(url: str, *, timeout: int = 30) -> dict:
    deadline = time.time() + timeout
    last_error: Exception | None = None
    while time.time() < deadline:
        try:
            return http_json(url, timeout=5)
        except Exception as error:
            last_error = error
            time.sleep(0.2)
    raise SmokeFailure(f"Timed out waiting for {url}: {last_error}")


def wait_for_file(path: Path, *, timeout: int = 30) -> Path:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if path.exists() and path.stat().st_size > 0:
            return path
        time.sleep(0.2)
    raise SmokeFailure(f"Timed out waiting for file: {path}")


def write_executable(path: Path, content: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)
    path.chmod(0o755)
    return path


def make_stub_codex(bin_dir: Path) -> Path:
    script = textwrap.dedent(
        """\
        #!/usr/bin/env python3
        from __future__ import annotations
        import json
        import signal
        import sys
        import time

        args = sys.argv[1:]

        def stop(_signum, _frame):
            raise SystemExit(0)

        signal.signal(signal.SIGTERM, stop)
        signal.signal(signal.SIGINT, stop)

        if args[:1] == ["exec"]:
            output_path = ""
            index = 1
            while index < len(args):
                token = args[index]
                if token in {"-o", "--output-schema", "-C", "-s", "--model", "--color"}:
                    if token == "-o" and index + 1 < len(args):
                        output_path = args[index + 1]
                    index += 2
                    continue
                if token in {"--json", "--ephemeral", "--skip-git-repo-check", "--search"}:
                    index += 1
                    continue
                index += 1

            print(json.dumps({"type": "thread.started", "thread_id": "stub-thread"}), flush=True)
            time.sleep(0.2)
            print(json.dumps({"type": "turn.started"}), flush=True)
            for _ in range(120):
                time.sleep(0.1)
            if output_path:
                with open(output_path, "w", encoding="utf-8") as handle:
                    handle.write(json.dumps({
                        "mission_summary": "stub summary",
                        "candidate_skills": [],
                        "implementation_required": False,
                    }))
            raise SystemExit(0)

        print("stub-codex", *args, flush=True)
        for _ in range(600):
            time.sleep(0.5)
        """
    )
    return write_executable(bin_dir / "codex", script)


def resolve_tmux_bin() -> str:
    system_tmux = shutil.which("tmux")
    if system_tmux:
        return system_tmux
    local_tmux = Path.home() / ".local" / "share" / "ai-agent-hub-tmux" / "bin" / "tmux"
    if local_tmux.exists():
        return str(local_tmux)
    raise SmokeFailure("tmux binary tidak ditemukan untuk smoke test.")


def terminate_process(process: subprocess.Popen[str]) -> None:
    if process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)


def start_server(script_path: Path, *, port: int, env: dict[str, str]) -> subprocess.Popen[str]:
    process = subprocess.Popen(
        ["node", str(script_path)],
        cwd=str(ROOT_DIR),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    try:
        wait_for_http_json(f"http://127.0.0.1:{port}/api/health")
    except Exception:
        terminate_process(process)
        try:
            output = process.stdout.read() if process.stdout else ""
        except Exception:
            output = ""
        raise SmokeFailure(f"Server gagal start: {script_path}\n{output}")
    return process


def ensure_tmux_session_gone(tmux_bin: str, session_name: str) -> None:
    run([tmux_bin, "kill-session", "-t", session_name], check=False, timeout=10)


def test_wrapper_install_and_dispatch() -> None:
    log("test wrapper install and dispatch")
    with tempfile.TemporaryDirectory(prefix="ai-agent-wrapper-", ignore_cleanup_errors=True) as temp_home:
        home = Path(temp_home)
        fake_original = write_executable(
            home / ".local" / "lib" / "node_modules" / "@openai" / "codex" / "bin" / "codex.js",
            "#!/usr/bin/env bash\nprintf 'fake-openai-codex %s\\n' \"$*\"\n",
        )
        require(fake_original.exists(), "fake original codex tidak berhasil dibuat")

        env = os.environ.copy()
        env["HOME"] = temp_home
        env["PATH"] = f"{home / '.local' / 'bin'}:{env.get('PATH', '')}"

        run(["bash", str(ROOT_DIR / "scripts/install-codex-agent-shell.sh")], env=env)

        wrapper = home / ".local" / "bin" / "codex"
        require(wrapper.exists(), "wrapper codex tidak terpasang")

        delegated = run([str(wrapper), "--version"], env=env)
        require("fake-openai-codex --version" in delegated.stdout, "wrapper tidak mendelegasikan codex biasa")

        agent_help = run([str(wrapper), "agent", "--help"], env=env)
        require("Interactive Codex Agent launcher" in agent_help.stdout, "wrapper tidak mengarah ke codex_agent.py")

        repo_help = run([str(ROOT_DIR / "scripts/codex-agent"), "--help"], env=env)
        require("Interactive Codex Agent launcher" in repo_help.stdout, "scripts/codex-agent tidak konsisten")

        for relative in (".bashrc", ".zshrc", ".config/fish/config.fish"):
            rc_path = home / relative
            content = rc_path.read_text() if rc_path.exists() else ""
            require("AI_AGENT_HUB_ROOT" in content, f"env block tidak ditulis ke {rc_path}")
            require(str(ROOT_DIR) in content, f"root repo tidak tercatat di {rc_path}")


def test_swarm_launcher_entrypoint() -> None:
    log("test swarm launcher entrypoint")
    with tempfile.TemporaryDirectory(prefix="ai-agent-swarm-launcher-", ignore_cleanup_errors=True) as temp_dir:
        temp = Path(temp_dir)
        output_path = temp / "electron-call.json"
        electron_stub = write_executable(
            temp / "electron",
            textwrap.dedent(
                f"""\
                #!/usr/bin/env bash
                set -euo pipefail
                python3 - "$@" <<'PY'
                import json
                import os
                import sys
                from pathlib import Path
                out = Path({json.dumps(str(output_path))})
                out.write_text(json.dumps({{
                    "argv": sys.argv[1:],
                    "env": {{
                        "HOST": os.environ.get("HOST"),
                        "SWARM_ELECTRON_HOST": os.environ.get("SWARM_ELECTRON_HOST"),
                        "SWARM_ELECTRON_DEFAULT_PORT": os.environ.get("SWARM_ELECTRON_DEFAULT_PORT"),
                        "SWARM_WORKSPACE": os.environ.get("SWARM_WORKSPACE"),
                        "SWARM_OBJECTIVE": os.environ.get("SWARM_OBJECTIVE"),
                        "SWARM_PROFILE": os.environ.get("SWARM_PROFILE"),
                        "SWARM_SEARCH": os.environ.get("SWARM_SEARCH"),
                        "CODEX_MODEL": os.environ.get("CODEX_MODEL"),
                        "CODEX_SANDBOX": os.environ.get("CODEX_SANDBOX"),
                        "CODEX_BIN": os.environ.get("CODEX_BIN"),
                    }}
                }}, indent=2))
                PY
                """
            ),
        )

        env = os.environ.copy()
        env.pop("DISPLAY", None)
        env.pop("WAYLAND_DISPLAY", None)
        env["AI_AGENT_SWARM_ALLOW_HEADLESS"] = "1"
        env["ELECTRON_BIN"] = str(electron_stub)
        env["HOST"] = "127.0.0.1"
        env["PORT"] = "4545"
        env["SWARM_WORKSPACE"] = str(ROOT_DIR)
        env["SWARM_OBJECTIVE"] = "Smoke test swarm launcher"
        env["SWARM_PROFILE"] = "adaptive"
        env["SWARM_SEARCH"] = "1"
        env["CODEX_MODEL"] = "gpt-5.4"
        env["CODEX_SANDBOX"] = "workspace-write"
        env["CODEX_BIN"] = "/tmp/stub-codex"

        result = run(["bash", str(ROOT_DIR / "scripts/launch-agent-swarm.sh")], env=env)
        require("Launching Agent Swarm desktop app" in result.stdout, "launcher swarm tidak start")
        require(output_path.exists(), "stub electron tidak terpanggil")

        payload = json.loads(output_path.read_text())
        require(payload["argv"] == [str(ROOT_DIR / "desktop/main.cjs")], "launcher swarm tidak memanggil entry Electron yang benar")
        require(payload["env"]["SWARM_OBJECTIVE"] == "Smoke test swarm launcher", "objective swarm tidak diteruskan")
        require(payload["env"]["SWARM_WORKSPACE"] == str(ROOT_DIR), "workspace swarm tidak diteruskan")
        require(payload["env"]["SWARM_PROFILE"] == "adaptive", "profile swarm tidak diteruskan")
        require(payload["env"]["SWARM_SEARCH"] == "1", "flag search swarm tidak diteruskan")
        require(payload["env"]["CODEX_MODEL"] == "gpt-5.4", "model codex tidak diteruskan")
        require(payload["env"]["CODEX_SANDBOX"] == "workspace-write", "sandbox codex tidak diteruskan")


def test_grid_interactive_smoke() -> None:
    log("test grid interactive smoke")
    tmux_bin = resolve_tmux_bin()
    session_name = f"smoke-grid-{int(time.time())}"
    ensure_tmux_session_gone(tmux_bin, session_name)

    try:
        with tempfile.TemporaryDirectory(prefix="ai-agent-grid-home-", ignore_cleanup_errors=True) as temp_home, tempfile.TemporaryDirectory(prefix="ai-agent-grid-bin-", ignore_cleanup_errors=True) as temp_bin:
            home = Path(temp_home)
            stub_codex = make_stub_codex(Path(temp_bin))
            state_path = home / ".local" / "state" / "ai-agent-hub" / "workspace-state.json"
            state_path.parent.mkdir(parents=True, exist_ok=True)
            state_path.write_text(
                json.dumps(
                    {
                        "version": 1,
                        "last_panel_count": 2,
                        "last_workspace_mode": "shared",
                        "last_entry_mode": "grid",
                        "last_swarm_profile": "adaptive",
                        "workspaces": [
                            {
                                "path": str(ROOT_DIR),
                                "favorite": False,
                                "use_count": 3,
                                "last_used_at": "2026-03-19T08:11:00+07:00",
                                "imported_from_codex": False,
                            }
                        ],
                        "recent_launches": [
                            {
                                "created_at": "2026-03-19T08:11:00+07:00",
                                "panel_count": 2,
                                "workspace_mode": "shared",
                                "workspaces": [str(ROOT_DIR)],
                            }
                        ],
                    },
                    indent=2,
                )
                + "\n"
            )

            env = os.environ.copy()
            env["HOME"] = temp_home
            env["CODEX_AGENT_UI"] = "text"
            env["ALACRITTY_BIN"] = "true"
            env["CODEX_BIN"] = str(stub_codex)
            env["TMUX_BIN"] = tmux_bin

            master_fd, slave_fd = pty.openpty()
            process = subprocess.Popen(
                [
                    sys.executable,
                    str(ROOT_DIR / "scripts/codex_agent.py"),
                    "--ui",
                    "text",
                    "--session-name",
                    session_name,
                    "--detached",
                ],
                cwd=str(ROOT_DIR),
                env=env,
                stdin=slave_fd,
                stdout=slave_fd,
                stderr=slave_fd,
                text=False,
            )
            os.close(slave_fd)

            prompts = [
                "Pilih mode awal Codex Agent.",
                "Pilih berapa agent yang mau dipanggil.",
                "Pilih strategi workspace untuk agent.",
                "Ditemukan history workspace yang cocok.",
                "Lanjut launch Codex Agent?",
                "Tandai workspace yang ingin disimpan sebagai favorite.",
            ]
            answered = 0
            output = ""
            deadline = time.time() + 45

            try:
                while time.time() < deadline:
                    ready, _, _ = select.select([master_fd], [], [], 0.2)
                    if ready:
                        try:
                            raw_chunk = os.read(master_fd, 4096)
                        except OSError:
                            raw_chunk = b""
                        if not raw_chunk:
                            if process.poll() is not None:
                                break
                            continue
                        chunk = raw_chunk.decode("utf-8", errors="replace")
                        output += chunk
                        while answered < len(prompts) and prompts[answered] in output:
                            os.write(master_fd, b"\n")
                            answered += 1
                    if process.poll() is not None:
                        break
                return_code = process.wait(timeout=10)
            finally:
                os.close(master_fd)

            require(return_code == 0, f"grid interactive launch gagal\n{output}")
            require(answered == len(prompts), f"wizard grid tidak melewati semua prompt yang diharapkan\n{output}")

            time.sleep(1.0)
            panes = run(
                [tmux_bin, "list-panes", "-t", f"{session_name}:0", "-F", "#{pane_index}:#{pane_width}x#{pane_height}:#{pane_current_command}"],
                timeout=10,
            ).stdout.splitlines()
            require(len(panes) == 2, f"tmux session {session_name} tidak punya 2 pane: {panes}")
    finally:
        ensure_tmux_session_gone(tmux_bin, session_name)


def test_grid_split_workspace_smoke() -> None:
    log("test grid split workspace smoke")
    tmux_bin = resolve_tmux_bin()
    session_name = f"smoke-grid-split-{int(time.time())}"
    ensure_tmux_session_gone(tmux_bin, session_name)

    try:
        with tempfile.TemporaryDirectory(prefix="ai-agent-split-home-", ignore_cleanup_errors=True) as temp_home, tempfile.TemporaryDirectory(prefix="ai-agent-split-bin-", ignore_cleanup_errors=True) as temp_bin, tempfile.TemporaryDirectory(prefix="ai-agent-split-ws-a-", ignore_cleanup_errors=True) as workspace_a, tempfile.TemporaryDirectory(prefix="ai-agent-split-ws-b-", ignore_cleanup_errors=True) as workspace_b:
            stub_codex = make_stub_codex(Path(temp_bin))
            env = os.environ.copy()
            env["HOME"] = temp_home
            env["ALACRITTY_BIN"] = "true"
            env["CODEX_BIN"] = str(stub_codex)
            env["TMUX_BIN"] = tmux_bin

            result = run(
                [
                    sys.executable,
                    str(ROOT_DIR / "scripts/codex_agent.py"),
                    "--launch-mode",
                    "grid",
                    "--panel-count",
                    "2",
                    "--workspace-mode",
                    "split",
                    "--workspace",
                    workspace_a,
                    "--workspace",
                    workspace_b,
                    "--detached",
                    "--session-name",
                    session_name,
                ],
                env=env,
                timeout=30,
            )
            require(result.returncode == 0, f"split workspace launch gagal\n{result.stdout}\n{result.stderr}")

            time.sleep(1.0)
            pane_titles = run(
                [tmux_bin, "list-panes", "-t", f"{session_name}:0", "-F", "#{pane_index}:#{pane_title}"],
                timeout=10,
            ).stdout.splitlines()
            require(len(pane_titles) == 2, f"session split tidak punya 2 pane: {pane_titles}")
            require(Path(workspace_a).name in pane_titles[0] or Path(workspace_a).name in pane_titles[1], f"title pane tidak memuat workspace A: {pane_titles}")
            require(Path(workspace_b).name in pane_titles[0] or Path(workspace_b).name in pane_titles[1], f"title pane tidak memuat workspace B: {pane_titles}")

            pane_zero = run([tmux_bin, "capture-pane", "-pt", f"{session_name}:0.0"], timeout=10).stdout
            pane_one = run([tmux_bin, "capture-pane", "-pt", f"{session_name}:0.1"], timeout=10).stdout
            compact_zero = "".join(pane_zero.split())
            compact_one = "".join(pane_one.split())
            require("".join(workspace_a.split()) in compact_zero, f"output pane 0 tidak memuat workspace A:\n{pane_zero}")
            require("".join(workspace_b.split()) in compact_one, f"output pane 1 tidak memuat workspace B:\n{pane_one}")

            duplicate = run(
                [
                    sys.executable,
                    str(ROOT_DIR / "scripts/codex_agent.py"),
                    "--launch-mode",
                    "grid",
                    "--panel-count",
                    "2",
                    "--workspace-mode",
                    "split",
                    "--workspace",
                    workspace_a,
                    "--workspace",
                    workspace_a,
                    "--detached",
                    "--session-name",
                    f"{session_name}-dupe",
                ],
                env=env,
                timeout=30,
                check=False,
            )
            require(duplicate.returncode != 0, "split workspace duplikat seharusnya ditolak")
            require(
                "directory yang berbeda" in duplicate.stderr or "directory yang berbeda" in duplicate.stdout,
                f"pesan error split duplicate tidak tepat:\nSTDOUT:\n{duplicate.stdout}\nSTDERR:\n{duplicate.stderr}",
            )
    finally:
        ensure_tmux_session_gone(tmux_bin, session_name)
        ensure_tmux_session_gone(tmux_bin, f"{session_name}-dupe")


def test_web_two_panel_sync() -> None:
    log("test web 2-panel sync")
    with tempfile.TemporaryDirectory(prefix="ai-agent-web-bin-", ignore_cleanup_errors=True) as temp_bin:
        stub_codex = make_stub_codex(Path(temp_bin))
        port = random_port()
        env = os.environ.copy()
        env["PORT"] = str(port)
        env["CODEX_BIN"] = str(stub_codex)
        process = start_server(ROOT_DIR / "server/index.js", port=port, env=env)
        try:
            response = http_json(
                f"http://127.0.0.1:{port}/api/sessions/sync",
                method="POST",
                payload={
                    "panelCount": 2,
                    "workspace": str(ROOT_DIR),
                    "model": "gpt-5.4",
                    "sandbox": "workspace-write",
                    "approval": "on-request",
                },
            )
            require(response["settings"]["panelCount"] == 2, f"panelCount diserialisasi salah: {response}")
            require(len(response["sessions"]) == 2, f"session count web salah: {response}")
        finally:
            terminate_process(process)


def test_real_electron_boot_smoke() -> None:
    if os.environ.get("AI_AGENT_SMOKE_ELECTRON_REAL") != "1":
        log("skip real electron boot smoke (set AI_AGENT_SMOKE_ELECTRON_REAL=1 to enable)")
        return

    log("test real electron boot smoke")
    electron_bin = os.environ.get("ELECTRON_BIN") or str(ROOT_DIR / "node_modules" / ".bin" / "electron")
    require(Path(electron_bin).exists(), f"electron binary tidak ditemukan: {electron_bin}")
    require(bool(os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY")), "display tidak tersedia untuk real electron smoke test")

    with tempfile.TemporaryDirectory(prefix="ai-agent-electron-bin-", ignore_cleanup_errors=True) as temp_bin, tempfile.TemporaryDirectory(prefix="ai-agent-electron-out-", ignore_cleanup_errors=True) as temp_out:
        stub_codex = make_stub_codex(Path(temp_bin))
        boot_file = Path(temp_out) / "swarm-boot.json"
        log_file = Path(temp_out) / "swarm-app.log"
        env = os.environ.copy()
        env["ELECTRON_BIN"] = electron_bin
        env["AI_AGENT_SWARM_LOG"] = str(log_file)
        env["AI_AGENT_SWARM_SMOKE_BOOT_FILE"] = str(boot_file)
        env["AI_AGENT_SWARM_SMOKE_EXIT_ON_LOAD"] = "1"
        env["SWARM_WORKSPACE"] = str(ROOT_DIR)
        env["SWARM_OBJECTIVE"] = ""
        env["SWARM_PROFILE"] = "adaptive"
        env["CODEX_BIN"] = str(stub_codex)
        env["PORT"] = str(random_port())

        result = run(["bash", str(ROOT_DIR / "scripts/launch-agent-swarm.sh")], env=env, timeout=60)
        require(result.returncode == 0, f"launcher Electron nyata gagal\n{result.stdout}\n{result.stderr}")
        wait_for_file(boot_file, timeout=10)
        payload = json.loads(boot_file.read_text())
        require(payload.get("ok") is True, f"smoke boot Electron gagal: {payload}")
        require(payload.get("state") == "loaded", f"Electron tidak mencapai state loaded: {payload}")
        require(str(payload.get("url", "")).startswith("http://127.0.0.1:"), f"url boot Electron tidak valid: {payload}")
        require(payload.get("title") == "Codex Agent Swarm", f"title window tidak sesuai: {payload}")
        require(log_file.exists(), "log file Electron tidak dibuat")


def test_swarm_stop_semantics() -> None:
    log("test swarm stop semantics")
    with tempfile.TemporaryDirectory(prefix="ai-agent-swarm-bin-", ignore_cleanup_errors=True) as temp_bin:
        stub_codex = make_stub_codex(Path(temp_bin))
        port = random_port()
        env = os.environ.copy()
        env["PORT"] = str(port)
        env["CODEX_BIN"] = str(stub_codex)
        process = start_server(ROOT_DIR / "server/swarm-server.js", port=port, env=env)
        try:
            started = http_json(
                f"http://127.0.0.1:{port}/api/swarm/start",
                method="POST",
                payload={
                    "workspace": str(ROOT_DIR),
                    "objective": "Smoke test stop semantics",
                },
            )
            run_id = started["run"]["id"]
            time.sleep(1.0)
            http_json(
                f"http://127.0.0.1:{port}/api/swarm/{run_id}/stop",
                method="POST",
                payload={},
            )
            time.sleep(1.5)
            health = http_json(f"http://127.0.0.1:{port}/api/health")
            active_run = health.get("activeRun") or {}
            require(active_run.get("id") == run_id, f"activeRun hilang setelah stop: {health}")
            require(active_run.get("status") == "stopped", f"status swarm salah setelah stop: {active_run}")
            require(active_run.get("phase") == "plan", f"phase swarm maju terlalu jauh setelah stop: {active_run}")
            titles = [item.get("title", "") for item in active_run.get("events", [])]
            phase_trail = [item.get("phase") for item in active_run.get("events", []) if item.get("kind") == "phase"]
            require("Swarm gagal" not in titles, f"event Swarm gagal masih muncul: {titles}")
            require("Stop requested" in titles, f"event stop tidak tercatat: {titles}")
            require(all(phase == "plan" for phase in phase_trail), f"phase swarm melewati plan saat stop: {phase_trail}")
        finally:
            terminate_process(process)


TESTS = [
    test_wrapper_install_and_dispatch,
    test_swarm_launcher_entrypoint,
    test_grid_interactive_smoke,
    test_grid_split_workspace_smoke,
    test_web_two_panel_sync,
    test_real_electron_boot_smoke,
    test_swarm_stop_semantics,
]


def main() -> int:
    started = time.time()
    for test in TESTS:
        test()
    log(f"all smoke tests passed in {time.time() - started:.1f}s")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SmokeFailure as error:
        print(f"[smoke] FAIL: {error}", file=sys.stderr)
        raise SystemExit(1)
