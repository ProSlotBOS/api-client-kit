"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/index.ts
var src_exports = {};
__export(src_exports, {
  ApiRefusal: () => ApiRefusal,
  createApiClient: () => createApiClient,
  isApiRefusal: () => isApiRefusal,
  logApiFailure: () => logApiFailure
});
module.exports = __toCommonJS(src_exports);
var ApiRefusal = class extends Error {
  constructor(message, status, code = null) {
    super(message);
    this.isApiRefusal = true;
    this.name = "ApiRefusal";
    this.status = status;
    this.code = code;
  }
};
function isApiRefusal(err) {
  return Boolean(err && typeof err === "object" && err.isApiRefusal === true);
}
function logApiFailure(context, err) {
  if (isApiRefusal(err)) {
    console.warn(`${context}:`, err.message);
    return err.message;
  }
  console.error(`${context}:`, err);
  return null;
}
var HTTP_PHRASE = /^(bad request|unauthorized|forbidden|not found|method not allowed|conflict|unprocessable entity|too many requests)\.?$/i;
function refusalFrom(status, body) {
  if (status < 400 || status >= 500 || status === 401) return null;
  if (!body || typeof body !== "object") return null;
  const { error, message, code, reason } = body;
  if (status === 404 && error === "Endpoint not found") return null;
  const text = [error, message].find((v) => typeof v === "string" && v.trim() !== "" && !HTTP_PHRASE.test(v.trim()));
  if (!text) return null;
  const why = typeof code === "string" ? code : typeof reason === "string" ? reason : null;
  return new ApiRefusal(text, status, why);
}
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
    const third = key.indexOf("|", second + 1);
    return key.slice(second + 1, third === -1 ? void 0 : third);
  }
  function mutatedCollectionPaths(path) {
    const query = path.indexOf("?");
    const clean = query === -1 ? path : path.slice(0, query);
    const parts = clean.split("/").filter(Boolean);
    if (parts[0] !== "api") return [`/${parts.slice(0, 2).join("/")}`];
    const paths = [];
    for (let i = 1; i < parts.length; i += 2) {
      const collection = `/api/${parts[i]}`;
      if (!paths.includes(collection)) paths.push(collection);
    }
    return paths.length > 0 ? paths : [clean];
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
    const isGet = !options?.method || options.method === "GET";
    const token = await getToken();
    const authFlag = token ? "auth" : "anon";
    const cacheKey = `${impersonateEmail || ""}|${authFlag}|${path}|${JSON.stringify(options?.body || "")}`;
    if (isGet) {
      const isBypassActive = [...recentMutations.entries()].some(
        ([prefix, ts]) => path.startsWith(prefix) && Date.now() - ts < MUTATION_BYPASS_WINDOW
      );
      if (!isBypassActive) {
        const cached = cache.get(cacheKey);
        if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;
      }
    }
    const headers = {
      "Content-Type": "application/json",
      "X-Organization-ID": orgId,
      ...token ? { Authorization: `Bearer ${token}` } : {},
      ...impersonateEmail ? { "X-Impersonate-Email": impersonateEmail } : {}
    };
    const separator = path.includes("?") ? "&" : "?";
    const fetchPath = `${path}${separator}organizationId=${orgId}`;
    const res = await fetch(`${apiBase}${fetchPath}`, {
      ...token ? { cache: "no-store" } : {},
      ...options,
      headers: { ...headers, ...options?.headers }
    });
    if (!res.ok) {
      let errorMsg = `API ${res.status}`;
      let errJson = null;
      try {
        const errText = await res.text();
        try {
          errJson = JSON.parse(errText);
          errorMsg = errJson.error || errJson.message || errText;
        } catch {
          errorMsg = errText || errorMsg;
        }
      } catch {
      }
      const refusal = refusalFrom(res.status, errJson);
      if (refusal) throw refusal;
      const error = new Error(errorMsg);
      error.status = res.status;
      throw error;
    }
    if (res.status === 204) return {};
    const data = await res.json();
    if (isGet) {
      cache.set(cacheKey, { data, ts: Date.now() });
    } else {
      for (const basePath of mutatedCollectionPaths(path)) clearCache(basePath);
    }
    return data;
  }
  return { apiFetch, clearCache, setImpersonationEmail };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  ApiRefusal,
  createApiClient,
  isApiRefusal,
  logApiFailure
});
//# sourceMappingURL=index.cjs.map