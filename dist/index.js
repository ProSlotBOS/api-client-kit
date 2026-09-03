// src/index.ts
function createApiClient(config) {
  const { apiBase, orgId, getToken } = config;
  const CACHE_TTL = config.cacheTtlMs ?? 5 * 60 * 1e3;
  const MUTATION_BYPASS_WINDOW = config.mutationBypassWindowMs ?? 3e4;
  const cache = /* @__PURE__ */ new Map();
  const recentMutations = /* @__PURE__ */ new Map();
  let impersonateEmail = null;
  function cacheKeyPath(key) {
    const first = key.indexOf("|");
    const second = key.indexOf("|", first + 1);
    return key.slice(first + 1, second === -1 ? void 0 : second);
  }
  function clearCache(path) {
    if (path) {
      for (const key of cache.keys()) {
        if (cacheKeyPath(key).startsWith(path)) cache.delete(key);
      }
      recentMutations.set(path, Date.now());
    } else {
      cache.clear();
    }
  }
  function setImpersonationEmail(email) {
    const next = email ? email.toLowerCase() : null;
    if (next === impersonateEmail) return;
    impersonateEmail = next;
    cache.clear();
  }
  async function apiFetch(path, options) {
    const cacheKey = `${impersonateEmail || ""}|${path}|${JSON.stringify(options?.body || "")}`;
    const isGet = !options?.method || options.method === "GET";
    if (isGet) {
      const isBypassActive = [...recentMutations.entries()].some(
        ([prefix, ts]) => path.startsWith(prefix) && Date.now() - ts < MUTATION_BYPASS_WINDOW
      );
      if (!isBypassActive) {
        const cached = cache.get(cacheKey);
        if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;
      }
    }
    const token = await getToken();
    const headers = {
      "Content-Type": "application/json",
      "X-Organization-ID": orgId,
      ...token ? { Authorization: `Bearer ${token}` } : {},
      ...impersonateEmail ? { "X-Impersonate-Email": impersonateEmail } : {}
    };
    const separator = path.includes("?") ? "&" : "?";
    const fetchPath = `${path}${separator}organizationId=${orgId}`;
    const res = await fetch(`${apiBase}${fetchPath}`, {
      ...options,
      headers: { ...headers, ...options?.headers }
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
      }
      const error = new Error(errorMsg);
      error.status = res.status;
      throw error;
    }
    if (res.status === 204) return {};
    const data = await res.json();
    if (isGet) {
      cache.set(cacheKey, { data, ts: Date.now() });
    } else {
      const basePath = path.split("/").slice(0, 3).join("/");
      clearCache(basePath);
    }
    return data;
  }
  return { apiFetch, clearCache, setImpersonationEmail };
}
export {
  createApiClient
};
//# sourceMappingURL=index.js.map