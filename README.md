# RepoHub

[![CI](https://github.com/AhmedKElshahed/RepoHub/actions/workflows/ci.yml/badge.svg)](https://github.com/AhmedKElshahed/RepoHub/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A local web UI that turns your **GitHub starred repositories** into a launcher. Sync your stars, then clone, install, run, preview and read logs for any of them from one page, without remembering each project's setup steps.

> **RepoHub runs third-party code on your machine.** Read [Security model](#security-model) before using it.

## Features

- **Sync stars** from the GitHub API into a searchable list.
- **One-click clone** (shallow, with submodules).
- **Auto-detects how to run each repo** and proposes install/start commands. You can override both per repo.
- **Isolated Python environments**: Python repos get their own `.venv`, so `pip install` never touches your global packages.
- **Live logs** streamed to the browser, with noisy progress bars throttled.
- **Free ports**: web apps are started on a free local port and previewed in an iframe; Docker Compose stacks get free host ports where they are overridable.
- **Real terminal** for TUIs and CLIs that need a TTY (Windows, macOS, and common Linux terminal emulators).
- **`.env` editor** with "load `.env.example`" and a random-key helper.
- **Trust gate**: install/start never run until you have confirmed the exact commands.
- **Restart button** (when started with `npm start`).

### What it detects

| Found in the repo | Type | Install | Start |
| --- | --- | --- | --- |
| `docker-compose.yml`, `compose.yaml` (and `.yml`/`.yaml` variants) | `docker-compose` | none | `docker compose up` |
| `package.json` | `node` / `node-vite` | `npm install` | `npm run dev` (or `start`); Vite gets `--port` and `--host` |
| `requirements.txt` / `pyproject.toml` with Streamlit | `python-streamlit` | `pip install …` | `streamlit run app.py` |
| `requirements.txt` / `pyproject.toml` with Gradio | `python-gradio` | `pip install …` | `python app.py` (port via `GRADIO_SERVER_PORT`) |
| other Python projects | `python` | `pip install …` | `python app.py` / `main.py` / `run.py`, or the project's console script |
| `Cargo.toml` | `rust` | `cargo build --release` | `cargo run --release` |
| `go.mod` | `go` | none | `go run .` |
| `index.html` | `static-html` | none | `python -m http.server` |
| `Procfile` | `procfile` | none | the `web:` command |

Detection is heuristic. When it guesses wrong, use **⚙ Commands** to set your own; `{PORT}` is replaced with a free port and also exported as `PORT`.

## Requirements

- [Node.js](https://nodejs.org) 18 or newer, and `git`.
- Whatever the repos you run need: Python 3, Docker, Rust, Go, and so on. RepoHub does not install these.
- A GitHub personal access token (see [Configuration](#configuration)).

## Quick start

```bash
git clone https://github.com/AhmedKElshahed/RepoHub.git
cd RepoHub
npm install
npm start
```

Open <http://127.0.0.1:4000>, paste a GitHub token, click **Save**, then **Sync stars**.

`npm start` runs RepoHub under a small supervisor, which is what makes the **↻ Restart** button work. `npm run server` runs the server directly, without that button.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `HUB_PORT` | `4000` | Port the UI/API listens on (always bound to `127.0.0.1`). |
| `GITHUB_TOKEN` | – | GitHub token. Takes precedence over a token saved in the UI. |

**Token permissions.** RepoHub only needs to read your starred repositories (`GET /user/starred`). A fine-grained token with read access to **Starring** works, as does a classic token with no scopes (public stars only; private starred repos need the `repo` scope). Prefer setting `GITHUB_TOKEN` in your environment: a token saved through the UI is written in plain text to `data/db.json`.

## Security model

RepoHub exists to run code you did not write, so the guardrails matter:

- **Localhost only.** The server binds to `127.0.0.1` and the port is not configurable beyond that. Every `/api` request is checked for an allowed `Host` (blocks DNS rebinding) and `Origin` (blocks cross-site requests from web pages you visit).
- **The browser cannot choose what runs.** Commands come from repo detection or from your own overrides, and repo ids must match a synced starred repo.
- **Trust gate.** `install` and `start` return `403` until you confirm the exact commands in a dialog. Trust is a hash of those commands, so changing them (or the repo changing what is detected) asks again.
- **What it cannot do.** Confirming only shows you the commands; it cannot tell you whether the repository is safe. Everything runs with your user's permissions. Only trust repositories you would be willing to run by hand. The **Shell** button opens a terminal in the repo folder without a trust prompt, since you are the one typing.
- **Secrets at rest.** `data/db.json` (GitHub token) and any `.env` you save through the UI are plain-text files. They are gitignored; keep them out of backups and screenshots you share.

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Project layout

```
server.js        Express API + static UI, request guards, graceful shutdown
supervisor.js    Relaunches server.js when it exits with code 75 (Restart button)
lib/
  github.js      Fetches starred repos (paginated)
  detect.js      Inspects a clone and proposes install/start commands
  runner.js      Clone, install, start, stop, terminal launcher, log fan-out
  store.js       JSON-file persistence
public/index.html  Single-file UI (no build step)
test/            Unit tests for command detection
data/            (gitignored) db.json and generated terminal launchers
managed_repos/   (gitignored) your clones, one folder per repo: owner__name
```

`data/db.json` has the shape `{ "config": { "token": "" }, "repos": { "<owner>__<name>": { … } } }`. Each repo record holds the GitHub metadata, `status` (`uncloned`, `cloning`, `ready`, `installing`, `running`), the `detected` commands, your `custom` overrides, and `trustedHash`.

## Development

```bash
npm test
```

Tests run with Node's built-in test runner and need no extra dependencies. Run it through `npm test` rather than a bare `node --test`, which would also discover test files inside the repositories in `managed_repos/`.

## Limitations

- Linux terminal support depends on finding one of `x-terminal-emulator`, `gnome-terminal`, `konsole` or `xterm`.
- Repos that need a GPU, API keys, or system packages still need those set up by you.
- There is no authentication, because it is a single-user local tool. Do not put it behind a reverse proxy or expose the port.

## License

[MIT](LICENSE)
