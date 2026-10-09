// Process manager: clone, install, start, stop + live log fan-out.
const { spawn, execFile } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const net = require('net');
const crypto = require('crypto');
const path = require('path');
const store = require('./store');
const { detect } = require('./detect');

const REPOS_DIR = path.join(__dirname, '..', 'managed_repos');
fs.mkdirSync(REPOS_DIR, { recursive: true });

const MAX_LINES = 2000;
const procs = new Map();  // id -> ChildProcess (running app)
const logs = new Map();   // id -> string[] ring buffer
const bus = new EventEmitter();
bus.setMaxListeners(100);

const repoDir = (id) => path.join(REPOS_DIR, id);

// Progress bars (docker pull, git clone, pip) redraw hundreds of times a second; keep ~3 updates/s.
const PROGRESS = /\d+%|\[=*>? *\]|\b(Downloading|Extracting|Pulling|Waiting|Receiving|Resolving|Counting|Compressing)\b/;
const lastProgress = new Map();

function log(id, line) {
  if (PROGRESS.test(line)) {
    const now = Date.now();
    if (now - (lastProgress.get(id) || 0) < 300) return;
    lastProgress.set(id, now);
  }
  const buf = logs.get(id) || [];
  buf.push(line);
  if (buf.length > MAX_LINES) buf.shift();
  logs.set(id, buf);
  bus.emit(id, line);
}

// Pipe a child's stdout/stderr into the log, line by line.
function pipeLogs(id, child) {
  for (const [stream, tag] of [[child.stdout, ''], [child.stderr, '']]) {
    let partial = '';
    stream.on('data', (chunk) => {
      const lines = (partial + chunk.toString()).split(/\r\n|\n|\r/); // bare \r = in-place progress redraw
      partial = lines.pop();
      lines.forEach((l) => log(id, tag + l));
    });
    stream.on('end', () => partial && log(id, partial));
  }
}

// Run a command to completion, streaming output. Resolves with exit code.
function runToCompletion(id, cmd, args, opts = {}) {
  return new Promise((resolve) => {
    log(id, `$ ${cmd} ${args.join(' ')}`);
    const child = spawn(cmd, args, { ...opts, shell: opts.shell ?? false });
    pipeLogs(id, child);
    child.on('error', (e) => { log(id, `error: ${e.message}`); resolve(-1); });
    child.on('close', (code) => resolve(code));
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function clone(id) {
  const repo = store.get(id);
  if (!repo || procs.has(id)) return;
  const dir = repoDir(id);
  store.upsert(id, { status: 'cloning', error: null });
  // cloneUrl came from the GitHub API response, never from the client.
  const code = await runToCompletion(id, 'git', ['clone', '--depth', '1', '--recurse-submodules', '--shallow-submodules', '--progress', repo.cloneUrl, dir]);
  if (code !== 0) return store.upsert(id, { status: 'uncloned', error: `git clone exited ${code}` });
  store.upsert(id, { status: 'ready', localPath: dir, detected: detect(dir) });
}

// --- Effective commands, user overrides and trust -------------------------------------------
// Commands run = detected defaults, overridden per-field by repo.custom. A repo must be "trusted"
// for the exact current commands before install/start will run (trust is a hash of them).
function effective(repo) {
  const d = repo.detected || {};
  const c = repo.custom || {};
  return { ...d, install: c.install || d.install || null, start: c.start || d.start || null };
}
const hashOf = (e) => crypto.createHash('sha256')
  .update(JSON.stringify([e.type, e.install, e.start, e.env || null])).digest('hex').slice(0, 16);

function refresh(id) {
  const r = store.get(id);
  // Re-detect on every action so improved rules (or repo changes) apply to old clones.
  return r && fs.existsSync(repoDir(id)) ? store.upsert(id, { detected: detect(repoDir(id)) }) : r;
}

function view(repo) {
  const e = effective(repo);
  const hash = hashOf(e);
  return { install: e.install, start: e.start, hash, trusted: repo.trustedHash === hash };
}

function canRun(id) {
  const r = refresh(id);
  if (!r) return { ok: false, error: 'unknown repo' };
  const v = view(r);
  return v.trusted ? { ok: true } : { ok: false, untrusted: true, commands: v };
}

function trust(id, hash) {
  const r = refresh(id);
  if (!r || view(r).hash !== hash) return false; // user confirmed different commands than current
  store.upsert(id, { trustedHash: hash });
  return true;
}

function setCustom(id, { install, start }) {
  const clean = (s) => (typeof s === 'string' && s.trim() ? s.trim().replace(/[\r\n]+/g, ' ').slice(0, 500) : undefined);
  store.upsert(id, { custom: { install: clean(install), start: clean(start) } });
}

const ENV_FILE = (id) => path.join(repoDir(id), '.env');
function readEnv(id) {
  const find = (names) => names.map((f) => path.join(repoDir(id), f)).find(fs.existsSync);
  const read = (f) => (f ? fs.readFileSync(f, 'utf8') : null);
  return { content: read(fs.existsSync(ENV_FILE(id)) ? ENV_FILE(id) : null), example: read(find(['.env.example', '.env.sample', '.env.template'])) };
}
function writeEnv(id, content) { fs.writeFileSync(ENV_FILE(id), String(content).slice(0, 100000)); }

function readme(id) {
  const f = ['README.md', 'readme.md', 'README.rst', 'README.txt', 'README'].map((n) => path.join(repoDir(id), n)).find(fs.existsSync);
  return f ? fs.readFileSync(f, 'utf8').slice(0, 20000) : '';
}

// --- Per-repo Python virtual environments ---------------------------------------------------
// Python repos get their own <repo>/.venv so `pip install` never touches the global/user site-packages.
const venvDir = (id) => path.join(repoDir(id), '.venv');
const venvBin = (id) => path.join(venvDir(id), process.platform === 'win32' ? 'Scripts' : 'bin');
const venvExists = (id) => fs.existsSync(path.join(venvBin(id), process.platform === 'win32' ? 'python.exe' : 'python'));
const usesPython = (e) => /^python/.test(e.type || '') || /\b(pip3?|python3?)\b/.test(`${e.install || ''} ${e.start || ''}`);

function venvEnv(id, base) {
  const env = { ...base };
  // Windows env keys are case-insensitive ("Path"); reuse the existing key to avoid a duplicate.
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') || 'PATH';
  env[pathKey] = venvBin(id) + path.delimiter + (env[pathKey] || '');
  env.VIRTUAL_ENV = venvDir(id);
  env.PYTHONNOUSERSITE = '1'; // ignore ~/AppData/.../local-packages
  env.PYTHONUTF8 = '1';       // piped stdout otherwise uses cp1252 on Windows and chokes on emoji
  env.PYTHONIOENCODING = 'utf-8';
  delete env.PYTHONHOME;
  return env;
}

async function ensureVenv(id) {
  if (venvExists(id)) return true;
  log(id, '[creating virtual environment .venv]');
  const attempts = process.platform === 'win32'
    ? [['python', ['-m', 'venv', '.venv']], ['py', ['-3', '-m', 'venv', '.venv']]]
    : [['python3', ['-m', 'venv', '.venv']], ['python', ['-m', 'venv', '.venv']]];
  for (const [cmd, args] of attempts) {
    if ((await runToCompletion(id, cmd, args, { cwd: repoDir(id) })) === 0 && venvExists(id)) return true;
  }
  return false;
}

async function install(id) {
  const repo = store.get(id);
  const eff = repo && effective(repo);
  const cmd = eff?.install;
  if (!cmd) return;
  store.upsert(id, { status: 'installing', error: null });
  let env = process.env;
  if (usesPython(eff)) {
    if (!(await ensureVenv(id))) return store.upsert(id, { status: 'ready', error: 'could not create .venv (is Python installed?)' });
    env = venvEnv(id, process.env);
  }
  const code = await runToCompletion(id, cmd, [], { cwd: repoDir(id), shell: true, env });
  store.upsert(id, code === 0 ? { status: 'ready' } : { status: 'ready', error: `install exited ${code}` });
}

async function start(id) {
  let repo = refresh(id);
  if (!repo || procs.has(id)) return;
  repo = { ...repo, detected: effective(repo) }; // from here on, detected.* means "effective"
  if (!repo.detected.start) return;
  const port = repo.detected.portManaged === false ? null : await freePort();
  const sub = (s) => s.replaceAll('{PORT}', String(port));
  const cmd = sub(repo.detected.start);
  const env = { ...process.env, HOST: '127.0.0.1', BROWSER: 'none' };
  if (port) env.PORT = String(port);
  // Host's own PORT/HOST must not leak into compose substitution unless we chose them.
  else delete env.PORT;
  for (const [k, v] of Object.entries(repo.detected.env || {})) env[k] = sub(v);

  // Python repos run inside their own .venv (created by Install), never the global interpreter.
  let runEnv = env;
  if (usesPython(repo.detected)) {
    if (venvExists(id)) { runEnv = venvEnv(id, env); log(id, '[using .venv]'); }
    else log(id, '[no .venv yet — click Install first, or dependencies will be missing]');
  }

  // Compose: host ports like "${WEB_PORT:-8080}:80" are env-overridable; hand them free ports to avoid clashes.
  if (repo.detected.type === 'docker-compose') {
    const file = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yaml', 'compose.yml']
      .map((f) => path.join(repoDir(id), f)).find(fs.existsSync);
    const text = file ? fs.readFileSync(file, 'utf8') : '';
    for (const m of text.matchAll(/["']?\$\{(\w+)(?::?-\d+)?\}:\d+/g)) {
      if (env[m[1]]) continue;
      env[m[1]] = String(await freePort());
      log(id, `[using free host port ${env[m[1]]} for ${m[1]}]`);
    }
  }

  // Compose repos often reference a .env that isn't committed; an empty one lets them boot.
  const envFile = path.join(repoDir(id), '.env');
  if (repo.detected.type === 'docker-compose' && !fs.existsSync(envFile)) {
    const example = ['.env.example', '.env.sample'].map((f) => path.join(repoDir(id), f)).find(fs.existsSync);
    if (example) fs.copyFileSync(example, envFile); else fs.writeFileSync(envFile, '');
    log(id, `[created ${path.basename(envFile)}${example ? ' from ' + path.basename(example) : ' (empty)'} — edit it if the app needs secrets]`);
  }

  log(id, `$ ${cmd}`);
  const child = spawn(cmd, { cwd: repoDir(id), env: runEnv, shell: true, detached: process.platform !== 'win32' });
  procs.set(id, child);
  pipeLogs(id, child);
  store.upsert(id, { status: 'running', port, pid: child.pid, error: null });

  if (repo.detected.type === 'docker-compose') watchComposePorts(id, child);

  child.on('error', (e) => log(id, `error: ${e.message}`));
  child.on('close', (code) => {
    procs.delete(id);
    log(id, `[process exited with code ${code}]`);
    store.upsert(id, { status: 'ready', port: null, pid: null, error: code ? `exited ${code}` : null });
  });
}

// --- Interactive terminal -------------------------------------------------------------------
// TUIs and CLIs need a real TTY, which the log pane can't provide. Open the OS terminal in the
// repo folder, venv activated, and type the start command (or just leave a shell open).
const LAUNCH_DIR = path.join(__dirname, '..', 'data', 'launchers');

async function openTerminal(id, { shell = false } = {}) {
  const repo = refresh(id);
  if (!repo || !fs.existsSync(repoDir(id))) throw new Error('repo is not cloned');
  const eff = effective(repo);
  const dir = repoDir(id);
  const port = await freePort();
  const cmd = !shell && eff.start ? eff.start.replaceAll('{PORT}', String(port)) : null;
  const py = usesPython(eff);
  const title = `RepoHub - ${repo.fullName}`.replace(/[&|<>^%"]/g, '');
  fs.mkdirSync(LAUNCH_DIR, { recursive: true });

  if (process.platform === 'win32') {
    const q = (s) => s; // run exactly as typed in cmd, so %VAR% expands
    const lines = ['@echo off', `title ${title}`, `cd /d "${dir}"`, 'set "HOST=127.0.0.1"', `set "PORT=${port}"`];
    if (py && venvExists(id)) lines.push(`call "${path.join(venvBin(id), 'activate.bat')}"`, 'set "PYTHONNOUSERSITE=1"', 'set "PYTHONUTF8=1"');
    else if (py) lines.push('echo [no .venv yet - click Install in RepoHub first]');
    if (cmd) lines.push(`call ${q(cmd)}`, 'echo.', 'echo [RepoHub] command finished with exit code %errorlevel%');
    else lines.push('echo [RepoHub] shell in this repo');
    const script = path.join(LAUNCH_DIR, `${id}.cmd`);
    fs.writeFileSync(script, lines.join('\r\n') + '\r\n');
    // `start` opens a new console window; cmd /k keeps it open after the command ends.
    spawn('cmd.exe', ['/d', '/s', '/c', `start "${title}" cmd /d /k ""${script}""`], {
      windowsVerbatimArguments: true, detached: true, stdio: 'ignore',
    }).unref();
  } else {
    const sq = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
    const lines = ['#!/bin/sh', `cd ${sq(dir)}`, 'export HOST=127.0.0.1', `export PORT=${port}`];
    if (py && venvExists(id)) lines.push(`. ${sq(path.join(venvBin(id), 'activate'))}`, 'export PYTHONNOUSERSITE=1 PYTHONUTF8=1');
    else if (py) lines.push('echo "[no .venv yet - click Install in RepoHub first]"');
    if (cmd) lines.push(cmd, 'echo', 'echo "[RepoHub] command finished with exit code $?"');
    lines.push('exec "${SHELL:-/bin/sh}"');
    const script = path.join(LAUNCH_DIR, `${id}.sh`);
    fs.writeFileSync(script, lines.join('\n') + '\n', { mode: 0o755 });
    if (process.platform === 'darwin') {
      spawn('osascript', ['-e', `tell application "Terminal" to do script ${JSON.stringify(sq(script))}`, '-e', 'tell application "Terminal" to activate'], { detached: true, stdio: 'ignore' }).unref();
    } else {
      const terms = [['x-terminal-emulator', ['-e']], ['gnome-terminal', ['--']], ['konsole', ['-e']], ['xterm', ['-e']]];
      const found = terms.find(([t]) => execFileSyncOk('which', [t]));
      if (!found) throw new Error('no terminal emulator found; run ' + script + ' manually');
      spawn(found[0], [...found[1], script], { detached: true, stdio: 'ignore' }).unref();
    }
  }
  return { command: cmd || '(shell)' };
}
function execFileSyncOk(cmd, args) {
  try { require('child_process').execFileSync(cmd, args, { stdio: 'ignore' }); return true; } catch { return false; }
}

// Compose publishes its own ports, so poll `compose ps` and adopt the first published TCP port.
function watchComposePorts(id, child) {
  const timer = setInterval(() => {
    if (!procs.has(id)) return clearInterval(timer);
    execFile('docker', ['compose', 'ps', '--format', 'json'], { cwd: repoDir(id) }, (err, out) => {
      if (err || !out.trim()) return;
      let rows;
      try { rows = out.trim().startsWith('[') ? JSON.parse(out) : out.trim().split('\n').map((l) => JSON.parse(l)); } catch { return; }
      const ports = rows.flatMap((r) => r.Publishers || [])
        .filter((p) => p.PublishedPort > 0 && p.Protocol === 'tcp')
        .map((p) => p.PublishedPort);
      if (ports.length && store.get(id)?.port !== ports[0]) {
        store.upsert(id, { port: ports[0] });
        log(id, `[detected published port ${ports[0]}]`);
      }
    });
  }, 3000);
  child.on('close', () => clearInterval(timer));
}

// Resolves once the stop command has finished, so shutdown/restart can wait for it.
function stop(id) {
  const child = procs.get(id);
  if (!child) return Promise.resolve();
  return new Promise((resolve) => {
    if (store.get(id)?.detected?.type === 'docker-compose') {
      // Killing the CLI would leave containers running; tear the stack down properly.
      log(id, '$ docker compose down');
      return execFile('docker', ['compose', 'down'], { cwd: repoDir(id) }, (err, out, errout) => {
        if (out) log(id, out.trim());
        if (errout) log(id, errout.trim());
        resolve();
      });
    }
    if (process.platform === 'win32') {
      execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => resolve()); // kill whole tree
    } else {
      try { process.kill(-child.pid, 'SIGTERM'); } catch {}
      resolve();
    }
  });
}

function stopAll() { return Promise.all([...procs.keys()].map(stop)); }
function runningCount() { return procs.size; }

// On boot, nothing is actually running/cloning anymore: reconcile persisted state.
function reconcile() {
  for (const r of store.all()) {
    if (['running', 'cloning', 'installing'].includes(r.status)) {
      const cloned = fs.existsSync(repoDir(r.id));
      store.upsert(r.id, { status: cloned ? 'ready' : 'uncloned', port: null, pid: null });
    }
  }
}

module.exports = {
  clone, install, start, stop, stopAll, runningCount, reconcile, logs, bus,
  view, canRun, trust, setCustom, readEnv, writeEnv, readme, openTerminal, refresh,
};
