// A sign-in that lapsed is renewed once, and a lost one is reported. Boys of
// Summer, 28 Oct 2026: an admin's tab left open overnight missed its token
// refresh during a five-second network drop. The site's getter turned the
// failure into null, every signed-in call (a game edit included) went out
// signed out and was refused, and the page went on showing him signed in.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApiClient, firebaseTokenGetter } from '../dist/index.js';

const fresh = ['fresh', 'id', 'token'].join('-');
const stale = ['stale', 'id', 'token'].join('-');
const signedOut = { error: 'Unauthorized', message: 'Sign in required' };

function respond(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

// fetch answers 401 to a request without a token, or with the stale one; 200 otherwise.
function api() {
  const sent = [];
  global.fetch = async (url, init) => {
    const auth = init.headers.Authorization || null;
    sent.push({ url, auth, method: init.method || 'GET', body: init.body });
    return !auth || auth === `Bearer ${stale}` ? respond(401, signedOut) : respond(200, { ok: true, auth });
  };
  return sent;
}

function tokens(...answers) {
  const asked = [];
  const getToken = async (request) => { asked.push(request); return answers.length > 1 ? answers.shift() : answers[0]; };
  return { getToken, asked };
}

test('a 401 is retried once with a forced fresh token, and the answer comes back', async () => {
  const sent = api();
  const { getToken, asked } = tokens(stale, fresh);
  const c = createApiClient({ apiBase: 'https://api.test', orgId: 'org', getToken });
  const data = await c.apiFetch('/api/league/games/g1', { method: 'PUT', body: '{"homeTeamId":"a"}' });
  assert.equal(data.auth, `Bearer ${fresh}`);
  assert.deepEqual(asked[1], { forceRefresh: true });
  assert.equal(sent.length, 2);
  assert.equal(sent[1].body, '{"homeTeamId":"a"}');
});

test('a getter that returns the same token again is not sent twice', async () => {
  const sent = api();
  const { getToken } = tokens(stale);
  const c = createApiClient({ apiBase: 'https://api.test', orgId: 'org', getToken });
  await assert.rejects(c.apiFetch('/api/users/all-for-org'), /Unauthorized/);
  assert.equal(sent.length, 1);
});

test('signed in but no token to be had: the request fails and the lost sign-in is reported once', async () => {
  api();
  let lost = 0;
  const { getToken } = tokens(null);
  const c = createApiClient({ apiBase: 'https://api.test', orgId: 'org', getToken, isSignedIn: () => true, onSignInLost: () => { lost += 1; } });
  await assert.rejects(c.apiFetch('/api/sports/coach-documents/all'), /Unauthorized/);
  await assert.rejects(c.apiFetch('/api/league/games/reschedule-requests'), /Unauthorized/);
  assert.equal(lost, 1);
});

test('a visitor who never signed in is not told their sign-in was lost', async () => {
  api();
  let lost = 0;
  const { getToken } = tokens(null);
  const c = createApiClient({ apiBase: 'https://api.test', orgId: 'org', getToken, isSignedIn: () => false, onSignInLost: () => { lost += 1; } });
  await assert.rejects(c.apiFetch('/api/users/all-for-org'), /Unauthorized/);
  assert.equal(lost, 0);
});

test('when a signed-in request goes through again, the site hears the sign-in is back', async () => {
  api();
  const events = [];
  const { getToken } = tokens(null, null, fresh);
  const c = createApiClient({
    apiBase: 'https://api.test', orgId: 'org', getToken, isSignedIn: () => true,
    onSignInLost: () => events.push('lost'), onSignInRestored: () => events.push('restored'),
  });
  await assert.rejects(c.apiFetch('/api/users/all-for-org'), /Unauthorized/);
  await c.apiFetch('/api/users/all-for-org');
  assert.deepEqual(events, ['lost', 'restored']);
});

test('an answer fetched on the retry is cached as signed in, never under the signed-out key', async () => {
  const sent = api();
  const answers = [null, fresh];
  const c = createApiClient({ apiBase: 'https://api.test', orgId: 'org', getToken: async () => (answers.length ? answers.shift() : null) });
  await c.apiFetch('/api/league/tournaments');
  // Signed out now: the signed-in answer must not be handed back from the cache.
  await assert.rejects(c.apiFetch('/api/league/tournaments'), /Unauthorized/);
  assert.equal(sent.length, 3);
});

test('firebaseTokenGetter: no user means no token, and a forced refresh is passed through', async () => {
  assert.equal(await firebaseTokenGetter(() => null)(), null);
  const calls = [];
  const user = { getIdToken: async (force) => { calls.push(force); return fresh; } };
  const get = firebaseTokenGetter(() => user);
  assert.equal(await get(), fresh);
  assert.equal(await get({ forceRefresh: true }), fresh);
  assert.deepEqual(calls, [false, true]);
});

test('firebaseTokenGetter: a failed token is fetched again forced; when that fails too it logs the code, never a token', async () => {
  const warned = [];
  const realWarn = console.warn;
  console.warn = (...args) => warned.push(args.join(' '));
  try {
    let n = 0;
    const flaky = { getIdToken: async (force) => { n += 1; if (!force) throw Object.assign(new Error('x'), { code: 'auth/network-request-failed' }); return fresh; } };
    assert.equal(await firebaseTokenGetter(() => flaky)(), fresh);
    assert.equal(n, 2);
    assert.equal(warned.length, 0);

    const broken = { getIdToken: async () => { throw Object.assign(new Error(stale), { code: 'auth/user-token-expired' }); } };
    assert.equal(await firebaseTokenGetter(() => broken)(), null);
    assert.equal(warned.length, 1);
    assert.match(warned[0], /auth\/user-token-expired/);
    assert.doesNotMatch(warned[0], new RegExp(stale));
  } finally {
    console.warn = realWarn;
  }
});
