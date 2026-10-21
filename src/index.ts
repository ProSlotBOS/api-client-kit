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

/**
 * The API saying no, for a reason the person on the screen can act on: "Every
 * division needs a name", "Blackout submissions are locked", "Not authorized
 * to edit this team". When it is the rule working, not the site breaking, it is
 * shown to them and logged as a warning (logApiFailure) — Tracer captures
 * console.error as a crash.
 *
 * Use logApiFailure only where a refusal can only be the person's to fix, like
 * a form the API validates and the screen does not. In the Tracer queue for
 * Aug-Oct 2026 most refusals logged as errors were real defects that surfaced
 * as one (a permission check, a stale family id, a payment race), so the
 * default is still to report. The SDK reports only 403 and 5xx on its own.
 *
 * Thrown by apiFetch for a 4xx whose JSON body carries a message. Everything
 * else stays a plain Error and keeps being reported:
 *   - any 5xx;
 *   - a 4xx with no message, or only an HTTP phrase ("Forbidden");
 *   - every 401: a session the API did not accept is how a broken sign-in or
 *     an auth gate mounted in front of a public route shows up (proslotbos,
 *     Sept 2026: a public onboarding link answered "Link invalid or expired");
 *   - the API's catch-all 404 ("Endpoint not found"): the site called a route
 *     that does not exist.
 * The SDK still reports every 403 by endpoint on its own, so a refusal the
 * UI shows is never the only trace of a wrong permission.
 *
 * `status` is what the plain Error carried and `message` is the same `error`
 * text, so callers that read err.message or err.status behave as before. The
 * one difference: `{ error: "Forbidden", message: "You do not have access to
 * this organization" }` reads as the second, which says why.
 */
export class ApiRefusal extends Error {
  readonly status: number;
  /** The API's machine-readable reason (`code` or `reason`), when it gave one. */
  readonly code: string | null;
  readonly isApiRefusal = true;

  constructor(message: string, status: number, code: string | null = null) {
    super(message);
    this.name = 'ApiRefusal';
    this.status = status;
    this.code = code;
  }
}

/** True for an ApiRefusal, including one from another copy of this package. */
export function isApiRefusal(err: unknown): err is ApiRefusal {
  return Boolean(err && typeof err === 'object' && (err as { isApiRefusal?: unknown }).isApiRefusal === true);
}

/**
 * Log a failed call the standard way, and return what to show the person.
 *
 *   } catch (err) {
 *     setSaveError(logApiFailure('Failed to save league', err) ?? 'The league could not be saved. Please try again.');
 *   }
 *
 * A refusal is logged with console.warn and its message returned for the UI.
 * Anything else is logged with console.error, which Tracer reports, and null is
 * returned so the caller shows its own generic text.
 */
export function logApiFailure(context: string, err: unknown): string | null {
  if (isApiRefusal(err)) {
    console.warn(`${context}:`, err.message);
    return err.message;
  }
  console.error(`${context}:`, err);
  return null;
}

// Bare HTTP reason phrases. A body that says only this gives the person nothing to act on.
const HTTP_PHRASE = /^(bad request|unauthorized|forbidden|not found|method not allowed|conflict|unprocessable entity|too many requests)\.?$/i;

/** The refusal a 4xx answer carries, or null when it is not one (see ApiRefusal). */
function refusalFrom(status: number, body: unknown): ApiRefusal | null {
  if (status < 400 || status >= 500 || status === 401) return null;
  if (!body || typeof body !== 'object') return null;
  const { error, message, code, reason } = body as Record<string, unknown>;
  if (status === 404 && error === 'Endpoint not found') return null;
  const text = [error, message].find((v): v is string => typeof v === 'string' && v.trim() !== '' && !HTTP_PHRASE.test(v.trim()));
  if (!text) return null;
  const why = typeof code === 'string' ? code : typeof reason === 'string' ? reason : null;
  return new ApiRefusal(text, status, why);
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
   * `${impersonateEmail}|${authFlag}|${path}|${body}` — two identity
   * prefixes (impersonation and signed-in-or-not) come before path, so a
   * key never literally starts with its own path. Matching has to isolate
   * this segment rather than using key.startsWith(path) — that always
   * returned false and was the whole original bug.
   */
  function cacheKeyPath(key: string): string {
    const first = key.indexOf('|');
    const second = key.indexOf('|', first + 1);
    const third = key.indexOf('|', second + 1);
    return key.slice(second + 1, third === -1 ? undefined : third);
  }

  /**
   * Every collection path a mutation touches, outermost first.
   *
   *   /api/teams/t1                    -> ['/api/teams']
   *   /api/sports-orgs/o1/teams/t1     -> ['/api/sports-orgs', '/api/teams']
   *
   * A nested collection is looked up at its own top-level route elsewhere
   * (`GET /api/teams`), so its cache has to be cleared under that name rather
   * than under the nested path it was written through.
   */
  function mutatedCollectionPaths(path: string): string[] {
    const query = path.indexOf('?');
    const clean = query === -1 ? path : path.slice(0, query);
    const parts = clean.split('/').filter(Boolean); // ['api','sports-orgs','o1','teams','t1']
    if (parts[0] !== 'api') return [`/${parts.slice(0, 2).join('/')}`];

    const paths: string[] = [];
    for (let i = 1; i < parts.length; i += 2) {
      const collection = `/api/${parts[i]}`;
      if (!paths.includes(collection)) paths.push(collection);
    }
    return paths.length > 0 ? paths : [clean];
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
    const isGet = !options?.method || options.method === 'GET';

    // Fetched before the cache check, not just before the network call —
    // a response fetched while signed out must never be handed back after
    // the same tab signs in (or vice versa), so "is there a token" is part
    // of the cache key.
    const token = await getToken();
    const authFlag = token ? 'auth' : 'anon';
    const cacheKey = `${impersonateEmail || ''}|${authFlag}|${path}|${JSON.stringify(options?.body || '')}`;

    if (isGet) {
      const isBypassActive = [...recentMutations.entries()].some(
        ([prefix, ts]) => path.startsWith(prefix) && Date.now() - ts < MUTATION_BYPASS_WINDOW
      );
      if (!isBypassActive) {
        const cached = cache.get(cacheKey);
        if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data as T;
      }
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Organization-ID': orgId,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(impersonateEmail ? { 'X-Impersonate-Email': impersonateEmail } : {}),
    };

    const separator = path.includes('?') ? '&' : '?';
    const fetchPath = `${path}${separator}organizationId=${orgId}`;

    // A signed-in request is never answered from the browser's HTTP cache. The
    // API's public GETs allow stale-while-revalidate, and a browser that had
    // just fetched one anonymously (a public page, the sign-in shell) handed
    // that body to the signed-in request for the same URL a moment later,
    // revalidating in the background. ECYB, 5-8 Oct 2026: the admin page held
    // the public event list, with no umpire emails on it. The API now varies
    // its answers on Authorization too; this keeps every site safe regardless.
    const res = await fetch(`${apiBase}${fetchPath}`, {
      ...(token ? { cache: 'no-store' as RequestCache } : {}),
      ...options,
      headers: { ...headers, ...options?.headers },
    });

    if (!res.ok) {
      let errorMsg = `API ${res.status}`;
      let errJson: unknown = null;
      try {
        const errText = await res.text();
        try {
          errJson = JSON.parse(errText);
          errorMsg = (errJson as any).error || (errJson as any).message || errText;
        } catch {
          errorMsg = errText || errorMsg;
        }
      } catch {
        // response body unreadable — keep the generic status message
      }
      const refusal = refusalFrom(res.status, errJson);
      if (refusal) throw refusal;
      const error = new Error(errorMsg) as Error & { status?: number };
      error.status = res.status;
      throw error;
    }

    if (res.status === 204) return {} as T;

    const data = await res.json();
    if (isGet) {
      cache.set(cacheKey, { data, ts: Date.now() });
    } else {
      // A mutation invalidates every collection its path names, not just the
      // first one. `/api/sports-orgs/{id}/teams/{id}` writes to the club AND to
      // the team document, so clearing only `/api/sports-orgs` left a five
      // minute stale `/api/teams` behind it: linking a team to a club appeared
      // to do nothing, because the refetched team list still showed the team
      // as unlinked.
      //
      // Path segments alternate collection/id, so the collections are the
      // even-indexed segments after the `/api` prefix.
      for (const basePath of mutatedCollectionPaths(path)) clearCache(basePath);
    }
    return data as T;
  }

  return { apiFetch, clearCache, setImpersonationEmail };
}
