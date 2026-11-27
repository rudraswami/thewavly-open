// TheWavly JavaScript SDK. No dependencies; runs on Node 20+, Deno, Bun and modern browsers (server-side keys only).
//
//   import { Wavly } from "@thewavly/sdk";
//   const wavly = new Wavly(process.env.WAVLY_API_KEY);
//   const mandate = await wavly.mandates.create({ instruction, approved_by, rules: { items: ["Saree"], max_amount_paise: 250000 } });
//   const check = await wavly.checks.create({ mandate: mandate.id, purchase: { item: "Saree", amount_paise: 249900 } });
//   if (check.decision === "proceed") { pay(); await wavly.checks.reportOutcome(check.id, { status: "paid", payment_reference }); }
//
// An agent registered in TheWavly's public registry passes its identity once, and every check is signed with its key,
// so it counts toward the agent's public record. At a store that takes TheWavly, send Wavly.checkoutHeaders(check, agent):
//   const wavly = new Wavly(key, { agent: { id: "acme-travelbot", privateKey: jwk } });
//   const check = await wavly.checks.create({ mandate, purchase });           // signed, agent set
//   await fetch(store + "/checkout", { headers: Wavly.checkoutHeaders(check, "acme-travelbot"), … });

export const DEFAULT_BASE_URL = "https://thewavly.com";

export class WavlyError extends Error {
  constructor(status, body) {
    super(body?.error?.message || "TheWavly request failed with HTTP " + status);
    this.name = "WavlyError"; this.status = status; this.code = body?.error?.code; this.field = body?.error?.field; this.requestId = body?.error?.request_id;
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const b64u = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
// JSON with object keys sorted, as TheWavly hashes a purchase for agent signatures
export const canonical = v => Array.isArray(v) ? "[" + v.map(canonical).join(",") + "]"
  : v && typeof v === "object" ? "{" + Object.keys(v).filter(k => v[k] !== undefined).sort().map(k => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}" : JSON.stringify(v);
const newKey = () => (globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2) + Date.now().toString(36));

export class Wavly {
  constructor(apiKey, { baseUrl = DEFAULT_BASE_URL, fetch: fetchImpl = globalThis.fetch, maxRetries = 2, timeoutMs = 15000, agent = null } = {}) {
    if (!/^sk_(test|live)_/.test(apiKey || "")) throw new Error("TheWavly needs a secret key that starts with sk_test_ or sk_live_");
    if (agent && (typeof agent.id !== "string" || !agent.id || (agent.privateKey && typeof agent.privateKey !== "object"))) throw new Error("agent must be { id, privateKey } with the agent's registry handle or id and its private JWK");
    this.agent = agent;
    this.apiKey = apiKey; this.baseUrl = baseUrl.replace(/\/+$/, ""); this.fetch = fetchImpl; this.maxRetries = maxRetries; this.timeoutMs = timeoutMs;
    const r = this.request.bind(this), q = params => { const s = new URLSearchParams(Object.entries(params || {}).filter(([, v]) => v != null)).toString(); return s ? "?" + s : ""; };
    this.mandates = {
      create: (body, o) => r("POST", "/v1/mandates", body, o),
      retrieve: id => r("GET", "/v1/mandates/" + encodeURIComponent(id)),
      list: params => r("GET", "/v1/mandates" + q(params)),
      revoke: (id, body = {}) => r("POST", "/v1/mandates/" + encodeURIComponent(id) + "/revoke", body),
    };
    this.checks = {
      // With an agent identity, the check names the agent and is signed with its key (unless you signed it yourself)
      create: async (body, o) => {
        if (this.agent && body && body.agent_signature === undefined) {
          body = { ...body, agent: body.agent ?? this.agent.id };
          if (this.agent.privateKey) body.agent_signature = await Wavly.signCheck({ privateKey: this.agent.privateKey, mandate: body.mandate, purchase: body.purchase });
        }
        return r("POST", "/v1/checks", body, o);
      },
      retrieve: id => r("GET", "/v1/checks/" + encodeURIComponent(id)),
      list: params => r("GET", "/v1/checks" + q(params)),
      reportOutcome: (id, body, o) => r("POST", "/v1/checks/" + encodeURIComponent(id) + "/outcome", body, o),
      evidence: id => r("GET", "/v1/checks/" + encodeURIComponent(id) + "/evidence"),
      // A new single-use payment token for a check that may proceed (for example after the user approved an ask)
      paymentToken: id => r("POST", "/v1/checks/" + encodeURIComponent(id) + "/payment_token", {}),
      // Polls until the user answers an "ask" or the request expires. Prefer webhooks in production.
      // What happened to the order after payment: delivered, partially_delivered, not_delivered, returned, refunded, cancelled
      reportFulfilment: (id, body, o) => r("POST", "/v1/checks/" + encodeURIComponent(id) + "/fulfilment", body, o),
      fulfilment: id => r("GET", "/v1/checks/" + encodeURIComponent(id) + "/fulfilment"),
      waitForApproval: async (id, { intervalMs = 3000, timeoutMs = 15 * 60 * 1000 } = {}) => {
        const until = Date.now() + timeoutMs;
        for (;;) {
          const c = await r("GET", "/v1/checks/" + encodeURIComponent(id));
          if (!c.approval || c.approval.status !== "pending" || Date.now() > until) return c;
          await sleep(intervalMs);
        }
      },
    };
    this.approvals = { retrieve: id => r("GET", "/v1/approvals/" + encodeURIComponent(id)) };
    this.webhookEndpoints = {
      create: body => r("POST", "/v1/webhook_endpoints", body),
      list: () => r("GET", "/v1/webhook_endpoints"),
      del: id => r("DELETE", "/v1/webhook_endpoints/" + encodeURIComponent(id)),
    };
    this.events = { list: params => r("GET", "/v1/events" + q(params)) };
    // The public registry: register an agent, prove its website, add its keys. Reads need no key.
    const rg = a => "/v1/registry/agents/" + encodeURIComponent(a);
    this.registry = {
      register: body => r("POST", "/v1/registry/agents", body),
      mine: () => r("GET", "/v1/registry/agents?mine=true"),
      manage: agent => r("GET", rg(agent) + "/manage"),
      verifyDomain: agent => r("POST", rg(agent) + "/verify", {}),
      addKey: (agent, body) => r("POST", rg(agent) + "/keys", body),
      revokeKey: (agent, kid) => r("POST", rg(agent) + "/keys/" + encodeURIComponent(kid) + "/revoke", {}),
      retrieve: agent => r("GET", rg(agent)),
      directory: () => r("GET", "/v1/registry/agents"),
    };
    this.mandates.import = (body, o) => r("POST", "/v1/mandates/import", body, o);
    const d = id => "/v1/disputes/" + encodeURIComponent(id);
    this.disputes = {
      create: (body, o) => r("POST", "/v1/disputes", body, o),
      retrieve: id => r("GET", d(id)),
      list: params => r("GET", "/v1/disputes" + q(params)),
      addEvidence: (id, body, o) => r("POST", d(id) + "/evidence", body, o),
      // Retained for older clients. Integration keys receive reviewer_sign_in_required; use the signed-in dispute desk.
      resolve: (id, body, o) => r("POST", d(id) + "/resolve", body, o),
      appeal: (id, body, o) => r("POST", d(id) + "/appeal", body, o),
      withdraw: (id, body = {}, o) => r("POST", d(id) + "/withdraw", body, o),
      // The desk: assign by member id or email (null unassigns), and the desk's figures
      assign: (id, assignee, o) => r("POST", d(id) + "/assign", { assignee }, o),
      stats: params => r("GET", "/v1/disputes/stats" + q(params)),
      // Ask the merchant, agent operator or payment provider to respond through a link (returned once)
      inviteParty: (id, body) => r("POST", d(id) + "/parties", body),
      parties: id => r("GET", d(id) + "/parties"),
      revokeParty: (id, partyId) => r("POST", d(id) + "/parties/" + encodeURIComponent(partyId) + "/revoke", {}),
      updateRemedy: (id, body, o) => r("POST", d(id) + "/remedy", body, o),
    };
    const ag = a => "/v1/agents/" + encodeURIComponent(a);
    this.agents = { list: () => r("GET", "/v1/agents"), score: agent => r("GET", ag(agent) + "/score"),
      addKey: (agent, body) => r("POST", ag(agent) + "/keys", body), listKeys: agent => r("GET", ag(agent) + "/keys"),
      revokeKey: (agent, kid) => r("POST", ag(agent) + "/keys/" + encodeURIComponent(kid) + "/revoke", {}) };
    this.payments = { record: (body, o) => r("POST", "/v1/payments", body, o), list: params => r("GET", "/v1/payments" + q(params)) };
    this.endUsers = { erase: body => r("POST", "/v1/end_users/erase", body) };
    this.health = () => r("GET", "/v1/health");
  }

  // Writes carry an Idempotency-Key (generated unless you pass one), so retrying a timed-out write never applies it twice
  async request(method, path, body, { idempotencyKey } = {}) {
    const key = method === "POST" ? (idempotencyKey || newKey()) : null;
    for (let attempt = 0; ; attempt++) {
      let res, data;
      try {
        res = await this.fetch(this.baseUrl + path, { method, signal: AbortSignal.timeout(this.timeoutMs),
          headers: { authorization: "Bearer " + this.apiKey, "user-agent": "wavly-js/0.1", ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(key ? { "idempotency-key": key } : {}) },
          body: body !== undefined ? JSON.stringify(body) : undefined });
        data = await res.json().catch(() => null);
      } catch (e) {
        if (attempt < this.maxRetries) { await sleep(400 * 2 ** attempt); continue; }
        throw e;
      }
      if (res.ok) return data;
      const retryable = res.status === 429 || res.status >= 500 || (res.status === 409 && data?.error?.code === "busy");
      if (retryable && attempt < this.maxRetries) { await sleep(Math.max(+(res.headers.get?.("retry-after") || 0) * 1000, 400 * 2 ** attempt)); continue; }
      throw new WavlyError(res.status, data);
    }
  }

  // For agents at checkout: the headers a store that takes TheWavly reads (see /.well-known/wavly-merchant.json)
  static checkoutHeaders(check, agent) {
    const token = check?.payment_token?.token;
    if (!token) throw new Error("This check has no payment token: it may only be paid once its decision is proceed, or after the user approves");
    if (typeof agent !== "string" || !agent) throw new Error("checkoutHeaders needs the agent's registry handle or id");
    return { "Wavly-Agent": agent, "Wavly-Payment-Token": token };
  }

  // Whether a store takes TheWavly payment tokens: its /.well-known/wavly-merchant.json, or null
  static async merchantInfo(storeUrl, { fetch: f = globalThis.fetch, timeoutMs = 5000 } = {}) {
    try {
      const res = await f(new URL("/.well-known/wavly-merchant.json", storeUrl).href, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json", "user-agent": "wavly-js/0.1" } });
      if (!res.ok) return null;
      const info = await res.json();
      return Array.isArray(info?.accepts) && info.accepts.includes("wavly-payment-token") ? info : null;
    } catch { return null; }
  }

  // For merchants: is this agent verified, and did its user approve this payment? No key needed.
  static async verifyOrder({ agent, payment_token }, { baseUrl = DEFAULT_BASE_URL, fetch: f = globalThis.fetch } = {}) { return Wavly.#public(f, baseUrl, "/v1/registry/verify", { agent, payment_token }); }

  // For payment providers, who need no TheWavly key: the token is the permission. Redeem exactly once, just before charging.
  static async inspectPaymentToken(token, { baseUrl = DEFAULT_BASE_URL, fetch: f = globalThis.fetch } = {}) { return Wavly.#public(f, baseUrl, "/v1/payment_tokens/inspect", { token }); }
  static async redeemPaymentToken(token, { amount_paise, payee, merchant, payment_reference, currency = "INR" }, { baseUrl = DEFAULT_BASE_URL, fetch: f = globalThis.fetch } = {}) {
    return Wavly.#public(f, baseUrl, "/v1/payment_tokens/redeem", { token, amount_paise, payee, merchant, payment_reference, currency });
  }
  // The charge failed after redemption: give the user's approval back, with the release_key the redemption returned.
  // Needs no TheWavly key; safe to repeat.
  static async releasePaymentToken(token, { release_key, reason } = {}, { baseUrl = DEFAULT_BASE_URL, fetch: f = globalThis.fetch } = {}) { return Wavly.#public(f, baseUrl, "/v1/payment_tokens/release", { token, release_key, ...(reason ? { reason } : {}) }); }
  // For the store or payment provider that redeemed the token: report what happened to the order, proven with the
  // release_key the redemption returned. Needs no TheWavly key.
  static async reportFulfilment(token, { release_key, status, items, amount_paise, occurred_at, carrier, tracking_reference, note, party } = {}, { baseUrl = DEFAULT_BASE_URL, fetch: f = globalThis.fetch } = {}) {
    const body = Object.fromEntries(Object.entries({ token, release_key, status, items, amount_paise, occurred_at, carrier, tracking_reference, note, party }).filter(([, v]) => v !== undefined));
    return Wavly.#public(f, baseUrl, "/v1/payment_tokens/fulfilment", body);
  }
  static async #public(f, baseUrl, path, body) {
    const res = await f(baseUrl.replace(/\/+$/, "") + path, { method: "POST", headers: { "content-type": "application/json", "user-agent": "wavly-js/0.1" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new WavlyError(res.status, data);
    return data;
  }

  // For agents: sign a check with the agent's private key (an Ed25519 or P-256 JWK registered with POST /v1/agents/:agent/keys).
  // Pass the result as agent_signature in checks.create, with exactly the same purchase object.
  static async signCheck({ privateKey, mandate, purchase, jti = newKey().replace(/[^\w-]/g, ""), iat = Math.floor(Date.now() / 1000) }) {
    const pub = privateKey.kty === "OKP" ? { crv: privateKey.crv, kty: "OKP", x: privateKey.x } : { crv: privateKey.crv, kty: "EC", x: privateKey.x, y: privateKey.y };
    const sha = async text => b64u(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))));
    const alg = privateKey.kty === "OKP" ? "EdDSA" : "ES256";
    const header = { alg, kid: await sha(JSON.stringify(pub)), typ: "wavly-check+jws" };
    const payload = { mandate, purchase: await sha(canonical(purchase)), iat, jti };
    const input = b64u(new TextEncoder().encode(JSON.stringify(header))) + "." + b64u(new TextEncoder().encode(JSON.stringify(payload)));
    const algo = alg === "EdDSA" ? [{ name: "Ed25519" }, { name: "Ed25519" }] : [{ name: "ECDSA", namedCurve: "P-256" }, { name: "ECDSA", hash: "SHA-256" }];
    const key = await crypto.subtle.importKey("jwk", privateKey, algo[0], false, ["sign"]);
    return input + "." + b64u(new Uint8Array(await crypto.subtle.sign(algo[1], key, new TextEncoder().encode(input))));
  }

  // Checks a webhook's Wavly-Signature header and returns the event. Throws if it does not match or is too old.
  static async verifyWebhook(rawBody, signatureHeader, secret, { toleranceSeconds = 300 } = {}) {
    const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(signatureHeader || "");
    if (!m) throw new Error("Missing or malformed Wavly-Signature header");
    if (Math.abs(Date.now() / 1000 - Number(m[1])) > toleranceSeconds) throw new Error("Webhook timestamp is outside the allowed window");
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(m[1] + "." + rawBody)));
    const hex = [...mac].map(b => b.toString(16).padStart(2, "0")).join("");
    let diff = hex.length ^ m[2].length; for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ m[2].charCodeAt(i);
    if (diff) throw new Error("Webhook signature does not match");
    return JSON.parse(rawBody);
  }

  // Verifies any TheWavly token (mandate, receipt, evidence pack signature) offline against a JWKS. Returns its payload.
  static async verifyToken(token, jwks) {
    const [body, sig] = String(token).split(".");
    const unb64 = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), c => c.charCodeAt(0));
    const payload = JSON.parse(new TextDecoder().decode(unb64(body)));
    const jwk = (jwks?.keys || jwks || []).find(k => k.kid === payload.kid);
    if (!jwk) throw new Error("No published key matches this token");
    const key = await crypto.subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", x: jwk.x }, { name: "Ed25519" }, false, ["verify"]);
    if (!(await crypto.subtle.verify({ name: "Ed25519" }, key, unb64(sig), new TextEncoder().encode(body)))) throw new Error("Signature does not match");
    return payload;
  }
}

export default Wavly;
