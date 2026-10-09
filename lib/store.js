// Tiny JSON-file store (data shape is documented in the README). Swap for SQLite if it outgrows this.
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
fs.mkdirSync(DATA_DIR, { recursive: true });

let db = { config: { token: '' }, repos: {} };
try { db = { ...db, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) }; } catch {}

function save() {
  // The file can hold a GitHub token, so keep it private to the owner (no effect on Windows).
  fs.writeFileSync(DB_FILE + '.tmp', JSON.stringify(db, null, 2), { mode: 0o600 });
  fs.renameSync(DB_FILE + '.tmp', DB_FILE);
}

module.exports = {
  getToken: () => process.env.GITHUB_TOKEN || db.config.token,
  setToken(t) { db.config.token = t; save(); },
  all: () => Object.values(db.repos),
  get: (id) => db.repos[id],
  // Merge fields into a repo record and persist.
  upsert(id, fields) {
    db.repos[id] = { ...(db.repos[id] || {}), ...fields, id };
    save();
    return db.repos[id];
  },
};
