const test = require('node:test');
const assert = require('node:assert');
const { fetchStarred } = require('../lib/github');

const repo = (name) => ({ full_name: `octo/${name}`, clone_url: `https://github.com/octo/${name}.git`, stargazers_count: 1 });
const page = (items, next) => ({
  ok: true,
  json: async () => items,
  headers: { get: (h) => (h.toLowerCase() === 'link' && next ? `<${next}>; rel="next"` : null) },
});

// Replace global fetch with a scripted sequence of responses; records every requested URL and auth header.
function stubFetch(responses) {
  const calls = [];
  const original = global.fetch;
  global.fetch = async (url, opts) => { calls.push({ url, auth: opts.headers.Authorization }); return responses.shift(); };
  return { calls, restore: () => { global.fetch = original; } };
}

test('requires a token', async () => {
  await assert.rejects(() => fetchStarred(''), /No GitHub token/);
});

test('follows pagination on api.github.com and maps repo fields', async () => {
  const next = 'https://api.github.com/user/starred?page=2';
  const stub = stubFetch([page([repo('a')], next), page([repo('b')])]);
  try {
    const out = await fetchStarred('tok');
    assert.deepEqual(out.map((r) => r.id), ['octo__a', 'octo__b']);
    assert.equal(stub.calls.length, 2);
    assert.equal(stub.calls[1].url, next);
    assert.equal(stub.calls[1].auth, 'Bearer tok');
  } finally { stub.restore(); }
});

test('never sends the token to a pagination link on another host', async () => {
  const stub = stubFetch([page([repo('a')], 'https://evil.example/steal'), page([repo('b')])]);
  try {
    await assert.rejects(() => fetchStarred('tok'), /outside api\.github\.com/);
    assert.equal(stub.calls.length, 1, 'second request must not be made');
  } finally { stub.restore(); }
});
