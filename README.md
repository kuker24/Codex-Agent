# AI Agent Hub

[![Smoke](https://github.com/kuker24/Codex-Agent/actions/workflows/smoke.yml/badge.svg)](https://github.com/kuker24/Codex-Agent/actions/workflows/smoke.yml)

Launcher lokal untuk `codex agent` dengan dua mode utama:

- `Grid`: multi-agent CLI di `tmux`
- `Swarm`: agent swarm otonom dengan aplikasi desktop native

## Entry Point

Perintah utama:

```bash
codex agent
```

Workflow git/PR helper:

```bash
./scripts/git-pr-flow --help
```

Saat dipanggil, sekarang muncul menu awal:

1. `Grid CLI multi-agent biasa`
2. `Agent Swarm otonom dengan aplikasi desktop live`

State pilihan terakhir disimpan, jadi workflow berikutnya lebih cepat.

## Command Integration

Supaya `codex agent` stabil di `bash`, `zsh`, dan `fish`:

```bash
./scripts/install-codex-agent-shell.sh
```

Integrasi ini membuat:

- wrapper `~/.local/bin/codex` yang menangkap `codex agent`
- `codex ...` selain `agent` tetap diteruskan ke Codex asli lewat `~/.local/bin/codex-openai`
- env `AI_AGENT_HUB_ROOT` ditulis ke `~/.bashrc`, `~/.zshrc`, dan `~/.config/fish/config.fish`

Jika shell Anda sudah lama terbuka, buka terminal baru atau `source` file config shell Anda sekali.

Jika UI terminal terasa blank atau macet, paksa mode teks:

```bash
CODEX_AGENT_UI=text codex agent
```

Mode yang tersedia: `auto`, `fzf`, `whiptail`, `text`.

## Workspace Memory

Workspace memory disimpan di:

```text
~/.local/state/ai-agent-hub/workspace-state.json
```

Yang disimpan:

- workspace terakhir
- favorite workspace
- use count workspace
- history workspace dari Codex
- preset launch grid
- mode awal terakhir (`grid` atau `swarm`)
- profile swarm terakhir

History workspace awal juga diimpor dari state Codex, jadi directory yang pernah dipakai bisa langsung muncul lagi di menu.

## Grid Mode

Mode ini adalah launcher CLI yang sudah ada sebelumnya.

Flow-nya:

1. pilih jumlah agent `2`, `4`, `5`, atau `6`
2. pilih mode workspace:
   - `shared`: satu workspace untuk semua agent
   - `split`: setiap agent wajib workspace berbeda
3. pilih workspace dari favorite, history, browse, manual path, atau current directory
4. tandai favorite bila perlu
5. launcher membuka `alacritty` + `tmux` dan menjalankan `codex` di setiap pane

Layout:

- `2`: kiri dan kanan, 50:50
- `4`: dua kiri dan dua kanan, grid `2x2`
- `5`: layout padat laptop
- `6`: layout maksimal laptop

## Swarm Mode

Mode ini menambahkan sistem berbeda di atas Codex biasa.

Flow-nya:

1. pilih `Agent Swarm`
2. pilih `swarm profile`
3. pilih workspace dari memory yang sama dengan mode grid
4. isi objective swarm
5. pilih apakah `live web search` global diaktifkan
6. launcher membuka aplikasi desktop swarm lokal

### Swarm Engine

Swarm dijalankan oleh `server/swarm-server.js` dan memakai `codex exec --json` sebagai backend agent nyata.

Arsitektur default `adaptive`:

- `Swarm Lead`: membuat plan dan synthesis akhir
- `Repo Mapper`: memetakan codebase dan risk surface
- `Skill Router`: memilih skill Codex yang paling relevan dari katalog skill terpasang
- `Builder`: mengeksekusi perubahan bila objective memang butuh implementasi
- `Verifier`: mengecek correctness, regression risk, dan evidence akhir

Mode `analysis` menjaga swarm tetap `read-only`.

### Observability Swarm

Aplikasi swarm menampilkan:

- fase swarm aktif
- visual topology/animasi agent swarm
- komunikasi antar-agent dan handoff
- raw event `codex exec --json`
- thread id per agent
- selected skills hasil routing
- synthesis akhir swarm

### Skill Routing

Agent swarm membaca katalog skill terpasang langsung dari:

```text
~/.agents/skills/**/SKILL.md
```

Artinya skill Codex lokal Anda sekarang ikut masuk ke pipeline swarm secara dinamis, bukan hardcoded statis.

## Script Penting

- `scripts/codex_agent.py`: launcher utama `codex agent`
- `scripts/install-codex-agent-shell.sh`: pasang wrapper `codex agent` lintas shell
- `scripts/launch-cli-hub.sh`: launcher grid CLI `tmux`
- `scripts/launch-agent-swarm.sh`: launcher aplikasi desktop Agent Swarm
- `desktop/main.cjs`: shell desktop Electron
- `desktop/loading.html`: loading screen native saat server boot
- `scripts/run-codex-pane.sh`: runner per pane untuk mode grid
- `server/swarm-server.js`: engine orchestration swarm
- `public/swarm.html`
- `public/swarm.js`
- `public/swarm.css`
- `config/swarm-profiles.json`: profile role dan phase swarm

## Jalankan Langsung

Grid CLI:

```bash
./scripts/launch-cli-hub.sh 4
```

Agent Swarm langsung:

```bash
SWARM_WORKSPACE="$PWD" \
SWARM_OBJECTIVE="Audit singkat workspace ini dan beri risk utama" \
./scripts/launch-agent-swarm.sh
```

Atau via npm:

```bash
npm run swarm:app
```

## Smoke Test

Regression smoke suite yang sekarang tersedia:

```bash
npm test
```

Anda juga bisa memilih subset test tertentu:

```bash
AI_AGENT_SMOKE_TESTS=wrapper,swarm-launcher,web-two-panel,swarm-stop npm test
```

Yang diverifikasi:

- install dan dispatch wrapper `codex agent`
- launcher swarm desktop ke entry Electron yang benar
- wizard `Grid` interaktif tetap bisa launch headless
- `Grid` non-interaktif `split workspace` benar-benar memisahkan workspace per pane
- legacy web grid benar-benar menerima `2 panel`
- boot Electron nyata bisa memuat dashboard lalu shutdown bersih
- `Swarm stop` tidak lagi berubah jadi failure palsu

Catatan:

- launcher swarm mendukung override `ELECTRON_BIN` untuk advanced usage dan smoke test
- `AI_AGENT_SWARM_ALLOW_HEADLESS=1` hanya untuk headless testing, bukan mode pakai harian
- boot Electron nyata aktif jika `AI_AGENT_SMOKE_ELECTRON_REAL=1`

Contoh local smoke penuh dengan Electron nyata:

```bash
AI_AGENT_SMOKE_ELECTRON_REAL=1 npm test
```

## GitHub Actions

Workflow CI tersedia di:

```text
.github/workflows/smoke.yml
```

Workflow ini berjalan pada `push`, `pull_request`, dan `workflow_dispatch`, lalu:

- install dependency Node dan Python
- install `tmux`, `xvfb`, dan `xauth`
- menjalankan static validation
- menjalankan smoke suite standar pada `push` dan `pull_request`
- menyediakan jalur manual `workflow_dispatch` untuk real Electron smoke bila ingin diuji di CI

Catatan CI:

- `npm test` lokal tetap menjalankan full suite, termasuk grid `tmux`
- workflow GitHub default memakai subset smoke yang paling stabil lintas runner
- grid `tmux` dan real Electron tetap tersedia untuk verifikasi lokal / manual dispatch

## GitHub CLI Lokal

Installer lokal tanpa `sudo` tersedia di:

```bash
./scripts/install-gh-local.sh
```

Script ini akan:

1. download GitHub CLI release terbaru
2. install ke `~/.local/share/github-cli/<version>`
3. symlink binary ke `~/.local/bin/gh`

Untuk login `gh`, gunakan:

```bash
./scripts/gh-auth-login.sh
```

Flow auth:

1. jika `gh` belum ada, installer lokal dijalankan otomatis
2. jika `GH_TOKEN` atau `GITHUB_TOKEN` tersedia, login dilakukan non-interaktif
3. jika token tidak ada, script turun ke `gh auth login --web --git-protocol ssh`
4. setelah login, script menjalankan `gh auth setup-git`

## Branch Dan PR

Starter branch standar tersedia di:

```bash
./scripts/start-work-branch
```

Contoh:

```bash
./scripts/start-work-branch \
  --type feat \
  --scope swarm \
  --ticket AGENT-24 \
  --slug live-dashboard
```

Hasil branch:

```text
feat/swarm/agent-24-live-dashboard
```

Jenis branch yang didukung:

- `feat`
- `fix`
- `chore`
- `docs`
- `refactor`
- `test`
- `perf`
- `ci`
- `build`
- `release`
- `hotfix`

Automation helper commit/push/PR tetap tersedia di:

```bash
./scripts/git-pr-flow
```

Flow yang dikerjakan script ini:

1. switch atau buat branch kerja
2. stage semua perubahan
3. commit jika working tree kotor
4. push branch ke `origin`
5. buat PR otomatis jika `gh` atau `GH_TOKEN` / `GITHUB_TOKEN` tersedia
6. fallback ke compare URL jika auth PR belum tersedia

Contoh dengan branch eksplisit:

```bash
./scripts/git-pr-flow \
  --branch feat/ui-polish \
  --message "Polish dashboard layout" \
  --title "Polish dashboard layout" \
  --body "Refine layout spacing and interaction polish."
```

Contoh dengan branch standar otomatis:

```bash
./scripts/git-pr-flow \
  --type fix \
  --scope swarm \
  --ticket BUG-42 \
  --slug stop-loop \
  --message "Fix swarm stop handling"
```

Mode push-only:

```bash
./scripts/git-pr-flow \
  --type chore \
  --slug ci-cleanup \
  --message "Clean CI workflow" \
  --push-only
```

Catatan:

- untuk create PR otomatis, paling praktis pakai `./scripts/gh-auth-login.sh`
- alternatifnya set `GH_TOKEN` atau `GITHUB_TOKEN`
- kalau auth PR belum ada, script akan memberi compare URL GitHub yang siap dibuka

## Verifikasi

Pemeriksaan yang relevan:

```bash
python3 -m py_compile \
  scripts/codex_agent.py \
  scripts/git_flow_common.py \
  scripts/git_pr_flow.py \
  scripts/start_work_branch.py \
  tests/smoke_runner.py

bash -n \
  scripts/install-gh-local.sh \
  scripts/gh-auth-login.sh \
  scripts/git-pr-flow \
  scripts/start-work-branch

env AI_AGENT_SMOKE_TESTS=gh-install,gh-auth,branch-helper python3 tests/smoke_runner.py
bash -n scripts/launch-cli-hub.sh
bash -n scripts/launch-agent-swarm.sh
node --check server/swarm-server.js
node --check desktop/main.cjs
```

## Catatan

- Mode web grid lama masih ada, tetapi entry utama sekarang adalah `codex agent`.
- Swarm sekarang dibuka sebagai aplikasi desktop Electron, bukan tab browser eksternal.
- Jika objective swarm kosong, aplikasi tetap bisa dibuka dan objective bisa diisi dari form.
