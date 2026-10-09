// Inspect a cloned repo and propose install/start commands.
// {PORT} is substituted by the runner. Commands are only ever taken from here
// (never from the HTTP request), so the UI cannot inject arbitrary shell.
const fs = require('fs');
const path = require('path');

function detect(dir) {
  const has = (f) => fs.existsSync(path.join(dir, f));
  const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8');

  if (has('docker-compose.yml') || has('docker-compose.yaml') || has('compose.yaml') || has('compose.yml')) {
    return { type: 'docker-compose', install: null, start: 'docker compose up', webApp: true, portManaged: false };
  }
  if (has('package.json')) {
    let pkg = {};
    try { pkg = JSON.parse(read('package.json')); } catch {}
    const scripts = pkg.scripts || {};
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const script = scripts.dev ? 'dev' : scripts.start ? 'start' : null;
    const isVite = !!deps.vite;
    const portArg = isVite ? ' -- --port {PORT} --host 127.0.0.1' : '';
    return {
      type: isVite ? 'node-vite' : 'node',
      install: 'npm install',
      start: script ? `npm run ${script}${portArg}` : null, // other frameworks read PORT env
      webApp: true,
    };
  }
  if (has('requirements.txt') || has('pyproject.toml')) {
    const reqs = has('requirements.txt') ? read('requirements.txt').toLowerCase() : '';
    const install = has('requirements.txt') ? 'pip install -r requirements.txt' : 'pip install .';
    if (reqs.includes('streamlit')) {
      const entry = ['app.py', 'streamlit_app.py', 'main.py'].find(has);
      return { type: 'python-streamlit', install, start: entry ? `streamlit run ${entry} --server.port {PORT} --server.headless true` : null, webApp: true };
    }
    if (reqs.includes('gradio')) {
      const entry = ['app.py', 'main.py'].find(has);
      return { type: 'python-gradio', install, start: entry ? `python ${entry}` : null, env: { GRADIO_SERVER_PORT: '{PORT}' }, webApp: true };
    }
    // Packages that install a command (e.g. `aihf`) via [project.scripts] / [tool.poetry.scripts].
    const script = has('pyproject.toml') && consoleScript(read('pyproject.toml'));
    const entry = ['app.py', 'main.py', 'run.py', 'src/main.py', 'src/app.py'].find(has);
    return { type: 'python', install, start: entry ? `python ${entry}` : script || null, webApp: false };
  }
  if (has('Cargo.toml')) {
    return { type: 'rust', install: 'cargo build --release', start: 'cargo run --release', webApp: false };
  }
  if (has('go.mod')) {
    return { type: 'go', install: null, start: 'go run .', webApp: false };
  }
  if (has('index.html')) {
    return { type: 'static-html', install: null, start: 'python -m http.server {PORT} --bind 127.0.0.1', webApp: true };
  }
  // Last resorts: a Heroku-style Procfile, or a bare Python entry script.
  if (has('Procfile')) {
    const web = /^web:\s*(.+)$/m.exec(read('Procfile'));
    if (web) return { type: 'procfile', install: null, start: web[1].trim(), webApp: true };
  }
  const entry = ['app.py', 'main.py', 'run.py', 'src/main.py', 'src/app.py'].find(has);
  if (entry) return { type: 'python-script', install: null, start: `python ${entry}`, webApp: false };
  return { type: 'unknown', install: null, start: null, webApp: false };
}

// First command name declared under [project.scripts] or [tool.poetry.scripts], if any.
function consoleScript(toml) {
  const section = /^\[(?:project|tool\.poetry)\.scripts\]\s*\n([\s\S]*?)(?=^\[|$(?![\s\S]))/m.exec(toml);
  const name = section && /^\s*["']?([A-Za-z0-9_.-]+)["']?\s*=/m.exec(section[1]);
  return name ? name[1] : null;
}

module.exports = { detect };
