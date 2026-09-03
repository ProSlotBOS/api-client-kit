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
  getToken: async () => {
    try { return (await auth.currentUser?.getIdToken()) || null; } catch { return null; }
  },
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
| `config.getToken` | `() => Promise<string \| null>` — the signed-in user's Firebase ID token. |
| `config.cacheTtlMs` | How long a GET stays cached. Default 5 minutes. |
| `config.mutationBypassWindowMs` | How long GETs bypass the cache after a matching mutation. Default 30s. |

`apiFetch(path, options?)` — GET by default, cached; any other method
clears the cache for that path's base (`/api/teams/123` → `/api/teams`)
and opens `mutationBypassWindowMs` where matching GETs skip the cache
outright, so the very next read after a mutation is always fresh even
before the cleared entry would have been refetched anyway.

## Developing

```bash
npm install
npm run build       # dist/ (ESM + CJS + types)
npm run typecheck
npm test             # regression tests for the cache-invalidation bug above
```
