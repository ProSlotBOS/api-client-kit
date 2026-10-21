// A 4xx the API answers with a reason is a refusal the UI shows and logs as a
// warning; anything else stays an Error that is logged with console.error,
// which Tracer reports. The bodies below are real ones from the Tracer queue,
// Aug-Oct 2026.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApiClient, ApiRefusal, isApiRefusal, logApiFailure } from '../dist/index.js';

function answering(status, body, contentType = 'application/json') {
  global.fetch = async () => {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return { ok: status < 400, status, headers: { get: () => contentType }, json: async () => JSON.parse(text), text: async () => text };
  };
  return createApiClient({ apiBase: 'https://api.test', orgId: 'test-org', getToken: () => Promise.resolve('token') });
}

async function failure(status, body) {
  try {
    await answering(status, body).apiFetch('/api/x', { method: 'PUT', body: '{}' });
  } catch (err) {
    return err;
  }
  assert.fail('expected the call to throw');
}

test('a 4xx with a reason is a refusal, with the message and status callers already read', async () => {
  for (const [status, body, message] of [
    [400, { error: 'Every division needs a name' }, 'Every division needs a name'],
    [403, { error: 'Blackout submissions are locked', reason: 'locked', lockedAt: null }, 'Blackout submissions are locked'],
    [403, { error: 'Not authorized to edit this team' }, 'Not authorized to edit this team'],
    [400, { error: 'Appointment already cancelled' }, 'Appointment already cancelled'],
    [404, { error: 'Recovery is not offered here.' }, 'Recovery is not offered here.'],
    [409, { error: 'New Hyde Park Blue Devils (15U) is not registered in Fall Season (10-Game).' }, 'New Hyde Park Blue Devils (15U) is not registered in Fall Season (10-Game).'],
    [429, { error: 'Too many submissions from this address. Please try again later.' }, 'Too many submissions from this address. Please try again later.'],
  ]) {
    const err = await failure(status, body);
    assert.ok(err instanceof ApiRefusal, `${status} ${message}`);
    assert.ok(err instanceof Error);
    assert.equal(isApiRefusal(err), true);
    assert.equal(err.message, message);
    assert.equal(err.status, status);
  }
});

test("a refusal keeps the API's machine-readable reason", async () => {
  assert.equal((await failure(403, { error: 'Blackout submissions are locked', reason: 'locked' })).code, 'locked');
  assert.equal((await failure(403, { error: 'Viewing as a parent is read-only', code: 'READ_ONLY' })).code, 'READ_ONLY');
  assert.equal((await failure(400, { error: 'Team name is required' })).code, null);
});

test('a bare HTTP phrase gives way to the sentence that says why', async () => {
  const err = await failure(403, { error: 'Forbidden', message: 'You do not have access to this organization' });
  assert.equal(isApiRefusal(err), true);
  assert.equal(err.message, 'You do not have access to this organization');
});

test('5xx, 401, the catch-all 404 and a 4xx with no reason stay errors', async () => {
  for (const [status, body] of [
    [500, { success: false, error: 'Internal server error' }],
    [502, { error: 'Bad gateway' }],
    [401, { error: 'Link invalid or expired' }],
    [401, { error: 'Unauthorized' }],
    [404, { success: false, error: 'Endpoint not found', message: 'No handler for GET /api/x' }],
    [403, { error: 'Forbidden' }],
    [403, { success: false, error: 'Unauthorized' }],
    [400, {}],
    [400, { error: '   ' }],
    [404, '<!DOCTYPE html><title>Not Found</title>'],
    [400, 'null'],
  ]) {
    const err = await failure(status, body);
    assert.equal(isApiRefusal(err), false, `${status} ${JSON.stringify(body)}`);
    assert.ok(err instanceof Error);
    assert.equal(err.status, status);
  }
});

test('an error keeps the message it always had', async () => {
  assert.equal((await failure(500, { error: 'Internal server error' })).message, 'Internal server error');
  assert.equal((await failure(404, '<p>gone</p>')).message, '<p>gone</p>');
  assert.equal((await failure(401, { error: 'Link invalid or expired' })).message, 'Link invalid or expired');
});

test('logApiFailure warns and returns the reason for a refusal, and errors for anything else', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const error = t.mock.method(console, 'error', () => {});

  const refused = await failure(400, { error: 'Every division needs a name' });
  assert.equal(logApiFailure('Failed to save league', refused), 'Every division needs a name');
  assert.equal(warn.mock.callCount(), 1);
  assert.deepEqual(warn.mock.calls[0].arguments, ['Failed to save league:', 'Every division needs a name']);
  assert.equal(error.mock.callCount(), 0, 'a refusal never reaches console.error, which Tracer reports');

  const broken = await failure(500, { error: 'Internal server error' });
  assert.equal(logApiFailure('Failed to save league', broken), null);
  assert.equal(error.mock.callCount(), 1);
  assert.equal(error.mock.calls[0].arguments[1], broken);

  assert.equal(logApiFailure('Failed to save league', new TypeError('x is undefined')), null);
  assert.equal(error.mock.callCount(), 2);
  assert.equal(warn.mock.callCount(), 1);
});

test('isApiRefusal recognises a refusal from another copy of the kit, and nothing else', () => {
  assert.equal(isApiRefusal({ isApiRefusal: true, message: 'x', status: 400 }), true);
  for (const v of [null, undefined, 'Every division needs a name', new Error('x'), { isApiRefusal: 'yes' }, { status: 400 }]) {
    assert.equal(isApiRefusal(v), false, String(v));
  }
});
