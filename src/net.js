// The only network code. `fetch` is injected through ctx so tests and replays never touch the internet.
const TIMEOUT_MS = 12_000;

async function attempt(fetchImpl, url, init) {
  const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`);
  return res.json();
}

async function withRetry(fn) {
  try {
    return await fn();
  } catch {
    return fn();
  }
}

export const getJson = (url, ctx = {}) => withRetry(() => attempt(ctx.fetch ?? fetch, url, { headers: { accept: "application/json" } }));

export const postJson = (url, body, ctx = {}) =>
  withRetry(() => attempt(ctx.fetch ?? fetch, url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));

/** One try, for a caller that has other endpoints to move on to. */
export const postJsonOnce = (url, body, ctx = {}) =>
  attempt(ctx.fetch ?? fetch, url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** The work's answer, or the fallback if it takes longer than ms. */
export function withDeadline(work, ms, fallback) {
  let timer;
  const limit = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([work, limit]).finally(() => clearTimeout(timer));
}

/** What every adapter returns when a source could not be read: never success, and it says which source. */
export function failedRead(provider, ref, reason, now) {
  return {
    legs: [{ id: `failed:${provider}:${ref}`, provider, ref, status: "LOOKUP_FAILED", class: "UNKNOWN", evidence: [], reason: String(reason).slice(0, 160) }],
    edges: [],
    evidence: [{ id: `read:${provider}:${ref}`, source: provider, kind: "read", ref, observedAt: now, class: "UNKNOWN" }],
    claims: [],
    identifiers: [],
    next: [],
  };
}
