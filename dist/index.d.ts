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
declare class ApiRefusal extends Error {
    readonly status: number;
    /** The API's machine-readable reason (`code` or `reason`), when it gave one. */
    readonly code: string | null;
    readonly isApiRefusal = true;
    constructor(message: string, status: number, code?: string | null);
}
/** True for an ApiRefusal, including one from another copy of this package. */
declare function isApiRefusal(err: unknown): err is ApiRefusal;
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
declare function logApiFailure(context: string, err: unknown): string | null;
declare function createApiClient(config: ApiClientConfig): ApiClient;

export { type ApiClient, type ApiClientConfig, ApiRefusal, createApiClient, isApiRefusal, logApiFailure };
