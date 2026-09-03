// Regression test for the exact bug this package was extracted to fix:
// a mutation's cache-clear must actually remove the stale GET response,
// for a plain signed-in user AND for an impersonated one, or a coach's
// dashboard shows stale data until a hard refresh.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApiClient } from '../dist/index.js';

function fakeFetchClient({ getIdToken = () => Promise.resolve('token') } = {}) {
  const responses = new Map(); // path -> value returned on next fetch
  let fetchCount = 0;
  global.fetch = async (url) => {
    fetchCount++;
    const path = new URL(url).pathname;
    const value = responses.get(path) ?? { call: fetchCount };
    return { ok: true, status: 200, json: async () => value, text: async () => JSON.stringify(value) };
  };
  const client = createApiClient({ apiBase: 'https://api.test', orgId: 'test-org', getToken: getIdToken });
  return { client, responses, callCount: () => fetchCount };
}

test('a GET after a matching POST returns fresh data, not the stale cached one', async () => {
  const { client, responses, callCount } = fakeFetchClient();
  responses.set('/api/teams', { teams: ['before'] });
  const before = await client.apiFetch('/api/teams');
  assert.deepEqual(before, { teams: ['before'] });
  assert.equal(callCount(), 1);

  // A second GET within the TTL must be served from cache (no new fetch).
  await client.apiFetch('/api/teams');
  assert.equal(callCount(), 1);

  // A POST to a matching path must invalidate the cached GET.
  responses.set('/api/teams', { teams: ['before', 'after'] });
  await client.apiFetch('/api/teams', { method: 'POST', body: JSON.stringify({ name: 'New Team' }) });
  assert.equal(callCount(), 2);

  const after = await client.apiFetch('/api/teams');
  assert.deepEqual(after, { teams: ['before', 'after'] });
  assert.equal(callCount(), 3, 'must refetch, not serve the pre-mutation cache entry');
});

test('cache invalidation also works while impersonating someone', async () => {
  const { client, responses, callCount } = fakeFetchClient();
  client.setImpersonationEmail('coach@example.com');

  responses.set('/api/teams', { teams: ['before'] });
  await client.apiFetch('/api/teams');
  assert.equal(callCount(), 1);

  responses.set('/api/teams', { teams: ['after'] });
  await client.apiFetch('/api/teams', { method: 'POST', body: '{}' });
  assert.equal(callCount(), 2);

  const after = await client.apiFetch('/api/teams');
  assert.deepEqual(after, { teams: ['after'] });
  assert.equal(callCount(), 3);
});

test('switching impersonated identity never serves another identity\'s cached response', async () => {
  const { client, responses } = fakeFetchClient();

  client.setImpersonationEmail('coach-a@example.com');
  responses.set('/api/teams', { teams: ['coach-a-team'] });
  const asA = await client.apiFetch('/api/teams');
  assert.deepEqual(asA, { teams: ['coach-a-team'] });

  client.setImpersonationEmail('coach-b@example.com');
  responses.set('/api/teams', { teams: ['coach-b-team'] });
  const asB = await client.apiFetch('/api/teams');
  assert.deepEqual(asB, { teams: ['coach-b-team'] }, 'must not reuse coach A\'s cached response');
});
