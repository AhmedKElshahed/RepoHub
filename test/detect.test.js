const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { detect } = require('../lib/detect');

// Build a throwaway repo folder from { 'relative/path': 'contents' } and run detect() on it.
function detectIn(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repohub-detect-'));
  try {
    for (const [name, content] of Object.entries(files)) {
      const file = path.join(dir, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    }
    return detect(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('docker compose wins over package.json', () => {
  const d = detectIn({ 'compose.yaml': '', 'package.json': '{}' });
  assert.equal(d.type, 'docker-compose');
  assert.equal(d.start, 'docker compose up');
  assert.equal(d.portManaged, false);
});

test('node: prefers the dev script, falls back to start', () => {
  assert.equal(detectIn({ 'package.json': '{"scripts":{"dev":"x","start":"y"}}' }).start, 'npm run dev');
  assert.equal(detectIn({ 'package.json': '{"scripts":{"start":"y"}}' }).start, 'npm run start');
});

test('node: no scripts means no start command', () => {
  const d = detectIn({ 'package.json': '{}' });
  assert.equal(d.type, 'node');
  assert.equal(d.install, 'npm install');
  assert.equal(d.start, null);
});

test('node: vite gets a managed port and loopback host', () => {
  const d = detectIn({ 'package.json': '{"scripts":{"dev":"vite"},"devDependencies":{"vite":"^5"}}' });
  assert.equal(d.type, 'node-vite');
  assert.equal(d.start, 'npm run dev -- --port {PORT} --host 127.0.0.1');
});

test('node: a malformed package.json does not throw', () => {
  const d = detectIn({ 'package.json': '{not json' });
  assert.equal(d.type, 'node');
  assert.equal(d.start, null);
});

test('python: streamlit uses the first matching entry file', () => {
  const d = detectIn({ 'requirements.txt': 'Streamlit==1.0\n', 'streamlit_app.py': '' });
  assert.equal(d.type, 'python-streamlit');
  assert.equal(d.install, 'pip install -r requirements.txt');
  assert.equal(d.start, 'streamlit run streamlit_app.py --server.port {PORT} --server.headless true');
});

test('python: gradio gets its port through the environment', () => {
  const d = detectIn({ 'requirements.txt': 'gradio\n', 'app.py': '' });
  assert.equal(d.type, 'python-gradio');
  assert.deepEqual(d.env, { GRADIO_SERVER_PORT: '{PORT}' });
});

test('python: pyproject console script is used when there is no entry file', () => {
  const d = detectIn({ 'pyproject.toml': '[project]\nname = "x"\n\n[project.scripts]\naihf = "pkg.main:run"\n\n[tool.other]\nfoo = 1\n' });
  assert.equal(d.type, 'python');
  assert.equal(d.install, 'pip install .');
  assert.equal(d.start, 'aihf');
  assert.equal(d.webApp, false);
});

test('python: entry file beats console script', () => {
  const d = detectIn({ 'requirements.txt': 'requests\n', 'main.py': '' });
  assert.equal(d.start, 'python main.py');
});

test('rust, go and static html', () => {
  assert.equal(detectIn({ 'Cargo.toml': '' }).start, 'cargo run --release');
  assert.equal(detectIn({ 'go.mod': '' }).start, 'go run .');
  const d = detectIn({ 'index.html': '' });
  assert.equal(d.type, 'static-html');
  assert.equal(d.start, 'python -m http.server {PORT} --bind 127.0.0.1');
});

test('Procfile web process is picked up', () => {
  const d = detectIn({ Procfile: 'worker: node w.js\nweb: node server.js --flag\n' });
  assert.equal(d.type, 'procfile');
  assert.equal(d.start, 'node server.js --flag');
});

test('a bare entry script is a python-script', () => {
  const d = detectIn({ 'run.py': '' });
  assert.equal(d.type, 'python-script');
  assert.equal(d.start, 'python run.py');
});

test('an empty repo is unknown with nothing to run', () => {
  const d = detectIn({ 'notes.txt': 'hi' });
  assert.equal(d.type, 'unknown');
  assert.equal(d.start, null);
  assert.equal(d.install, null);
});
