// A signed-in request bypasses the browser's HTTP cache. ECYB, 5-8 Oct 2026:
// the API's anonymous answers are public and stale-while-revalidate, and a
// browser that had just loaded a public page handed the admin's signed-in
// request the anonymous body for the same URL, so the admin page held the
// public event list, with no umpire emails on it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApiClient } from '../dist/index.js';

function client(getToken) {
  const inits = [];
  global.fetch = async (url, init) => {
    inits.push(init);
    return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => '{}' };
  };
  return { client: createApiClient({ apiBase: 'https://api.test', orgId: 'test-org', getToken }), inits };
}

test('with a token, the fetch is cache: no-store', async () => {
  const { client: c, inits } = client(() => Promise.resolve('token'));
  await c.apiFetch('/api/league/tournaments');
  assert.equal(inits[0].cache, 'no-store');
  assert.equal(inits[0].headers.Authorization, 'Bearer token');
});

test('without a token, the browser cache is left to its defaults', async () => {
  const { client: c, inits } = client(() => Promise.resolve(null));
  await c.apiFetch('/api/league/tournaments');
  assert.equal(inits[0].cache, undefined);
});

test("a caller's own cache mode wins", async () => {
  const { client: c, inits } = client(() => Promise.resolve('token'));
  await c.apiFetch('/api/league/tournaments', { cache: 'reload' });
  assert.equal(inits[0].cache, 'reload');
});
