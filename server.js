const express = require('express');
const path = require('path');
const store = require('./lib/store');
const { fetchStarred } = require('./lib/github');
const runner = require('./lib/runner');

const PORT = process.env.HUB_PORT || 4000;
const HOST = '127.0.0.1'; // never expose this API beyond localhost: it can run commands
const app = express();
app.use(express.json());

// Block cross-site requests (a random web page could otherwise hit localhost:4000).
// The Host check also defeats DNS rebinding, which matters now that the API can run commands.
app.use('/api', (req, res, next) => {
  if (![`${HOST}:${PORT}`, `localhost:${PORT}`].includes(req.headers.host)) {
    return res.status(403).json({ error: 'forbidden host' });
  }
  const origin = req.headers.origin;
  if (origin && origin !== `http://${HOST}:${PORT}` && origin !== `http://localhost:${PORT}`) {
    return res.status(403).json({ error: 'forbidden origin' });
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// Resolve :id to a known repo (ids come only from the synced GitHub list).
const withRepo = (req, res, next) => {
  req.repo = store.get(req.params.id);
  return req.repo ? next() : res.status(404).json({ error: 'unknown repo' });
};
const publicRepo = ({ cloneUrl, trustedHash, ...r }) => ({
  ...r,
  commands: r.status === 'uncloned' ? null : runner.view({ ...r, trustedHash }),
});

app.get('/api/repos', (req, res) => res.json(store.all().map(publicRepo)));

app.post('/api/token', (req, res) => {
  store.setToken(String(req.body.token || '').trim());
  res.json({ ok: true });
});

app.post('/api/sync', async (req, res) => {
  try {
    const starred = await fetchStarred(store.getToken());
    for (const r of starred) {
      store.upsert(r.id, { ...r, status: store.get(r.id)?.status || 'uncloned' });
    }
    res.json({ count: starred.length });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Long-running actions return 202 immediately; progress arrives via logs + polling.
app.post('/api/repos/:id/clone', withRepo, (req, res) => { runner.clone(req.repo.id); res.status(202).end(); });
// install/start execute third-party code: refused until the user has confirmed the exact commands.
const gated = (action) => (req, res) => {
  const check = runner.canRun(req.repo.id);
  if (!check.ok) return res.status(check.untrusted ? 403 : 404).json(check);
  runner[action](req.repo.id);
  res.status(202).end();
};
app.post('/api/repos/:id/install', withRepo, gated('install'));
app.post('/api/repos/:id/start', withRepo, gated('start'));

// Opens a real terminal window. With a start command it types it for you (trust-gated);
// with none (or {shell:true}) it just opens a shell in the repo, which needs no trust.
app.post('/api/repos/:id/terminal', withRepo, async (req, res) => {
  try {
    const shell = !!req.body?.shell || !runner.view(runner.refresh(req.repo.id)).start;
    if (!shell) {
      const check = runner.canRun(req.repo.id);
      if (!check.ok) return res.status(403).json(check);
    }
    res.json({ ok: true, ...(await runner.openTerminal(req.repo.id, { shell })) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/repos/:id/trust', withRepo, (req, res) =>
  runner.trust(req.repo.id, String(req.body.hash)) ? res.json({ ok: true }) : res.status(409).json({ error: 'commands changed, reopen the dialog' }));

app.put('/api/repos/:id/commands', withRepo, (req, res) => {
  runner.setCustom(req.repo.id, req.body || {});
  res.json({ ok: true });
});

app.get('/api/repos/:id/env', withRepo, (req, res) => res.json(runner.readEnv(req.repo.id)));
app.put('/api/repos/:id/env', withRepo, (req, res) => {
  if (typeof req.body.content !== 'string') return res.status(400).json({ error: 'content required' });
  runner.writeEnv(req.repo.id, req.body.content);
  res.json({ ok: true });
});

app.get('/api/repos/:id/readme', withRepo, (req, res) => res.type('text/plain').send(runner.readme(req.repo.id)));
app.post('/api/repos/:id/stop', withRepo, (req, res) => { runner.stop(req.repo.id); res.status(202).end(); });

// Live logs over Server-Sent Events: replay buffer, then stream new lines.
app.get('/api/repos/:id/logs', withRepo, (req, res) => {
  const id = req.repo.id;
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const send = (line) => res.write(`data: ${JSON.stringify(line)}\n\n`);
  (runner.logs.get(id) || []).forEach(send);
  runner.bus.on(id, send);
  req.on('close', () => runner.bus.off(id, send));
});

// Restart: stop managed apps, exit with code 75, and supervisor.js (started by `npm start`) relaunches us.
const RESTART_EXIT_CODE = 75;
app.get('/api/status', (req, res) => res.json({ supervised: !!process.env.REPOHUB_SUPERVISED, running: runner.runningCount(), pid: process.pid }));
app.post('/api/restart', (req, res) => {
  if (!process.env.REPOHUB_SUPERVISED) {
    return res.status(409).json({ error: 'Not started with `npm start`, so there is nothing to relaunch the server. Stop it and run `npm start` once.' });
  }
  res.json({ ok: true, stopping: runner.runningCount() });
  setTimeout(() => shutdown(RESTART_EXIT_CODE), 100); // let the response flush first
});

runner.reconcile();
const server = app.listen(PORT, HOST, () => console.log(`RepoHub → http://${HOST}:${PORT}`));
server.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} is already in use. Set HUB_PORT to pick another one.` : e.message);
  process.exit(1);
});

// Stop managed apps (waiting for e.g. `docker compose down`, up to 20s), then exit.
let shuttingDown = false;
async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  await Promise.race([runner.stopAll(), new Promise((r) => setTimeout(r, 20000))]);
  process.exit(code);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
