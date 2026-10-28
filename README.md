# @proslotbosllc/api-client-kit

A cached, org-scoped fetch client for a satellite dashboard talking to
`proslot-api`, with correct cache invalidation and identity-scoped caching
for staff impersonation ("Log In As").

## Why this exists

Boys of Summer's `src/lib/api.ts` added an impersonation prefix to its
cache keys (`${impersonateEmail}|${path}|${body}`) so one impersonated
identity's cached responses could never leak into another's. That's the
right fix for that problem, but the same commit left `clearCache()`
checking `key.startsWith(path)` — which never matches, because a key never
literally starts with its own path once the prefix is there (not even for
a plain signed-in user, where the prefix is just `''`). A mutation's
cache-clear silently no-op'd for **every** user, impersonated or not, so a
newly created team or a submitted registration didn't show up on the
coach dashboard until a hard refresh reset the whole in-memory cache.

This package is that fixed client, extracted so East Coast Youth Baseball
and Blue Chip College League — which never had backend-aware impersonation
at all, only the UI-level "Log In As" toggle — can adopt the same correct,
tested implementation instead of a second hand-rolled copy.

## Install

```bash
npm install @proslotbosllc/api-client-kit
```

## Use

```ts
// src/lib/api.ts
import { createApiClient } from '@proslotbosllc/api-client-kit';
import { auth } from './firebase';

export const API_BASE = import.meta.env.VITE_API_URL || 'https://proslot-api-473053764604.us-central1.run.app';
export const ORG_ID = 'your-org-id';

const client = createApiClient({
  apiBase: API_BASE,
  orgId: ORG_ID,
  getToken: firebaseTokenGetter(() => auth.currentUser),
  isSignedIn: () => !!auth.currentUser,
  onSignInLost: reportSignInLost,         // @proslotbosllc/sso-kit
  onSignInRestored: clearSignInLost,      // @proslotbosllc/sso-kit
});

export const { apiFetch, clearCache, setImpersonationEmail } = client;

export const api = {
  getTeams: () => apiFetch('/api/teams'),
  // ...every other endpoint method, unchanged
};
```

Call `setImpersonationEmail(targetUser.email)` from the same place your
`AuthContext`'s `impersonateUser()` sets its own state, and
`setImpersonationEmail(null)` when impersonation stops. Every request then
carries `X-Impersonate-Email`, the backend resolves the impersonated
identity's real permissions, and that identity's responses are cached
separately from the real admin's.

## API

| Export | Purpose |
|---|---|
| `createApiClient(config)` | Returns `{ apiFetch, clearCache, setImpersonationEmail }` bound to one org/API base/token source. |
| `config.apiBase` | Base URL of `proslot-api`. |
| `config.orgId` | Sent as `X-Organization-ID` and `?organizationId=` on every request. |
| `config.getToken` | `(request?) => Promise<string \| null>` — the signed-in user's Firebase ID token. Asked again with `{ forceRefresh: true }` after a 401. |
| `config.isSignedIn` | `() => boolean` — whether the site shows someone as signed in. |
| `config.onSignInLost` | Called once when a signed-in person's requests keep being refused as signed out (see below). |
| `config.onSignInRestored` | Called when a signed-in request goes through again after that. |
| `firebaseTokenGetter(currentUser)` | The `getToken` for a Firebase site: honours `forceRefresh`, retries a failed token once, logs Firebase's error code when it cannot get one. |
| `config.cacheTtlMs` | How long a GET stays cached. Default 5 minutes. |
| `config.mutationBypassWindowMs` | How long GETs bypass the cache after a matching mutation. Default 30s. |

| `ApiRefusal` | What `apiFetch` throws for a 4xx that carries a reason (see below). Has `message`, `status`, `code`. |
| `isApiRefusal(err)` | True for an `ApiRefusal`. |
| `logApiFailure(context, err)` | Logs a refusal with `console.warn` and returns its message; logs anything else with `console.error` and returns `null`. |

`apiFetch(path, options?)` — GET by default, cached; any other method
clears the cache for that path's base (`/api/teams/123` → `/api/teams`)
and opens `mutationBypassWindowMs` where matching GETs skip the cache
outright, so the very next read after a mutation is always fresh even
before the cleared entry would have been refetched anyway.

## Refusals are shown, not reported

When the API says no for a reason only the person can fix ("Every division
needs a name"), the site should say so under the form and log a warning:
logging it with `console.error` makes Tracer report the rule working as a
crash.

Use it per call site, not everywhere. In the Tracer queue for Aug-Oct 2026
most refusals logged as errors were real defects that surfaced as a refusal
(a permission check that was wrong, a stale family id, a payment race), and
only a few were the rule working. The SDK reports only 403 and 5xx by itself,
so a refusal silenced here is invisible unless it is a 403. Save League on the
league sites is the one adopter so far.

`apiFetch` throws an `ApiRefusal` for a 4xx whose JSON body carries a message.
It stays a plain `Error`, still reported, for every 5xx, every 401 (a session
the API didn't accept is how a broken sign-in shows up), the API's catch-all
`Endpoint not found` 404, and a 4xx with no message or only "Forbidden". The
Tracer SDK reports every 403 by endpoint on its own, so a wrong permission is
still seen once even when the screen explains it.

```ts
import { logApiFailure } from '@proslotbosllc/api-client-kit';

try {
  await api.updateTournament(id, payload);
} catch (err) {
  setSaveError(logApiFailure('Failed to save league', err) ?? 'The league could not be saved. Please try again.');
}
```

`err.message` and `err.status` are what they were before, so existing
handlers keep working.

## Sign-ins that lapse

A Firebase ID token lasts an hour and is refreshed in the background. A tab
that sleeps through the refresh, or loses its network at that moment, can be
left with no token. Every site's own getter turned that failure into `null`
without a word, so the request went out signed out and the API refused it
while the page still showed the person signed in. Boys of Summer, 28 Oct
2026: an admin's tab left open overnight hit a five-second network drop at
refresh time, and for ten minutes every signed-in call was refused, a game
edit included.

Now:

- `apiFetch` answers a 401 by asking `getToken({ forceRefresh: true })` and
  sending the request once more with the new token. The API checks the
  sign-in before a route runs, so resending a write after a 401 does nothing
  twice.
- `firebaseTokenGetter` asks Firebase for a new token when the one it holds
  will not come, and logs Firebase's error code (never the token) as a
  warning when that fails too, so the next reported error carries the reason.
- When the API still says signed out and `isSignedIn()` is true,
  `onSignInLost` fires once. Wire it to the sso-kit's `reportSignInLost` and
  mount its `SignInLostNotice`, which asks the person to sign in again. A
  visitor who never signed in is never told anything.

## Developing

```bash
npm install
npm run build       # dist/ (ESM + CJS + types)
npm run typecheck
npm test             # regression tests for the bugs above
```
