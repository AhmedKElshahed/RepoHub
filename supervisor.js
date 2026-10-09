// Starts server.js and relaunches it when it exits with code 75 (the "restart" button).
// Any other exit code (Ctrl+C, crash) ends the supervisor too.
const { spawn } = require('child_process');
const path = require('path');

const RESTART_EXIT_CODE = 75;
let child;

function run() {
  child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    stdio: 'inherit',
    env: { ...process.env, REPOHUB_SUPERVISED: '1' },
  });
  child.on('exit', (code) => {
    if (code === RESTART_EXIT_CODE) {
      console.log('[supervisor] restarting RepoHub…');
      return run();
    }
    process.exit(code ?? 1);
  });
}

// On Windows, Ctrl+C reaches the child directly (same console); elsewhere forward it.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { if (process.platform !== 'win32') child?.kill(sig); });
}

run();
