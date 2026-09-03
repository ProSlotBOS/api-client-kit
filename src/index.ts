/**
 * @proslotbosllc/api-client-kit
 *
 * A cached, org-scoped fetch client for talking to proslot-api from a
 * satellite dashboard, with correct cache invalidation and identity-scoped
 * caching for staff impersonation ("Log In As").
 *
 * Extracted from Boys of Summer's src/lib/api.ts after a real production
 * bug: adding an impersonation prefix to cache keys (so one impersonated
 * identity's cached responses could never leak into another's) broke
 * clearCache()'s matching for EVERY signed-in user, not just impersonated
 * ones — key.startsWith(path) was checked against
 * `${impersonateEmail || ''}|${path}|${body}`, which never starts with the
 * bare path even when impersonateEmail is ''. A mutation's cache-clear
 * silently no-op'd, so newly created records didn't appear until a hard
 * refresh reset the in-memory cache. See cacheKeyPath() below for the fix.
 */

export interface ApiClientConfig {
  /** Base URL of the proslot-api backend, e.g. https://proslot-api-....run.app */
  apiBase: string;
  /** This site's organization id, sent as X-Organization-ID and ?organizationId=. */
  orgId: string;
  /** Returns the signed-in user's Firebase ID token, or null if signed out. */
  getToken: () => Promise<string | null>;
  /** How long a GET response stays cached. Default 5 minutes. */
  cacheTtlMs?: number;
  /** How long GETs bypass the cache after a matching-prefix mutation. Default 30s. */
  mutationBypassWindowMs?: number;
}

export interface ApiClient {
  /**
   * Cached, org-scoped fetch. GETs are cached by (impersonated identity,
   * path, body); any other method clears the cache for its path's base
   * (e.g. POST /api/teams clears everything under /api/teams) and opens a
   * short window where matching GETs bypass the cache entirely.
   */
  apiFetch<T = any>(path: string, options?: RequestInit): Promise<T>;
  /** Clear cached entries whose path starts with `path`, or everything if omitted. */
  clearCache(path?: string): void;
  /**
   * Set (or clear, with null) the email of the user being impersonated.
   * The backend resolves impersonation itself from the X-Impersonate-Email
   * header this adds to every request; changing identity always clears the
   * whole cache so one identity's responses can never leak into another's.
   */
  setImpersonationEmail(email: string | null): void;
}

interface CacheEntry {
  data: unknown;
  ts: number;
}

export function createApiClient(config: ApiClientConfig): ApiClient {
  const { apiBase, orgId, getToken } = config;
  const CACHE_TTL = config.cacheTtlMs ?? 5 * 60 * 1000;
  const MUTATION_BYPASS_WINDOW = config.mutationBypassWindowMs ?? 30_000;

  const cache = new Map<string, CacheEntry>();
  const recentMutations = new Map<string, number>();
  let impersonateEmail: string | null = null;

  /**
   * The `path` segment of a cache key. Keys are built as
   * `${impersonateEmail}|${path}|${body}` — the leading impersonation
   * prefix (empty string when nobody's impersonated, an email otherwise)
   * means a key never literally starts with its own path, so matching has
   * to isolate this segment rather than using key.startsWith(path) — that
   * always returned false and was the whole bug.
   */
  function cacheKeyPath(key: string): string {
    const first = key.indexOf('|');
    const second = key.indexOf('|', first + 1);
    return key.slice(first + 1, second === -1 ? undefined : second);
  }

  function clearCache(path?: string): void {
    if (path) {
      for (const key of cache.keys()) {
        if (cacheKeyPath(key).startsWith(path)) cache.delete(key);
      }
      recentMutations.set(path, Date.now());
    } else {
      cache.clear();
    }
  }

  function setImpersonationEmail(email: string | null): void {
    const next = email ? email.toLowerCase() : null;
    if (next === impersonateEmail) return;
    impersonateEmail = next;
    // Responses are cached by identity too; entries fetched as one
    // identity must never be served to another.
    cache.clear();
  }

  async function apiFetch<T = any>(path: string, options?: RequestInit): Promise<T> {
    const cacheKey = `${impersonateEmail || ''}|${path}|${JSON.stringify(options?.body || '')}`;
    const isGet = !options?.method || options.method === 'GET';

    if (isGet) {
      const isBypassActive = [...recentMutations.entries()].some(
        ([prefix, ts]) => path.startsWith(prefix) && Date.now() - ts < MUTATION_BYPASS_WINDOW
      );
      if (!isBypassActive) {
        const cached = cache.get(cacheKey);
        if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data as T;
      }
    }

    const token = await getToken();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Organization-ID': orgId,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(impersonateEmail ? { 'X-Impersonate-Email': impersonateEmail } : {}),
    };

    const separator = path.includes('?') ? '&' : '?';
    const fetchPath = `${path}${separator}organizationId=${orgId}`;

    const res = await fetch(`${apiBase}${fetchPath}`, {
      ...options,
      headers: { ...headers, ...options?.headers },
    });

    if (!res.ok) {
      let errorMsg = `API ${res.status}`;
      try {
        const errText = await res.text();
        try {
          const errJson = JSON.parse(errText);
          errorMsg = errJson.error || errJson.message || errText;
        } catch {
          errorMsg = errText || errorMsg;
        }
      } catch {
        // response body unreadable — keep the generic status message
      }
      const error = new Error(errorMsg) as Error & { status?: number };
      error.status = res.status;
      throw error;
    }

    if (res.status === 204) return {} as T;

    const data = await res.json();
    if (isGet) {
      cache.set(cacheKey, { data, ts: Date.now() });
    } else {
      // e.g. /api/sports-orgs/123 -> /api/sports-orgs
      const basePath = path.split('/').slice(0, 3).join('/');
      clearCache(basePath);
    }
    return data as T;
  }

  return { apiFetch, clearCache, setImpersonationEmail };
}
