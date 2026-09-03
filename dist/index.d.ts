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
interface ApiClientConfig {
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
interface ApiClient {
    /**
     * Cached, org-scoped fetch. GETs are cached by (impersonated identity,
     * path, body); any other method clears the cache for its path's base
     * (e.g. POST /api/teams clears everything under /api/teams) and opens a
     * short window where matching GETs bypass the cache entirely.
     */
    apiFetch<T = unknown>(path: string, options?: RequestInit): Promise<T>;
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
declare function createApiClient(config: ApiClientConfig): ApiClient;

export { type ApiClient, type ApiClientConfig, createApiClient };
