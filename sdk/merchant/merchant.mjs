// TheWavly for merchants: accept an AI agent's order only when TheWavly says the user approved it.
//
// An agent that checks out at your store sends two headers with the order:
//   Wavly-Agent:          its handle or id in TheWavly's public registry (see /agents)
//   Wavly-Payment-Token:  the single-use payment token TheWavly gave it when the purchase was checked
// Before you charge, ask TheWavly two things in one call: is this agent who it says it is, and did the user approve this
// payment? Then redeem the token once, for the amount you are about to charge. A second use, a higher amount or another
// payee is refused, so the same approval can never pay twice. You need no TheWavly account: the token is the permission.
//
//   import { wavlyMerchant } from "@thewavly/merchant";
//   const wavly = wavlyMerchant({ payees: ["shop@okhdfc", "myshop.in"], mode: "require" });
//   const order = wavly.read(request.headers);                        // { agent, payment_token } or null
//   const answer = await wavly.check(order, { amount_paise: 54900 });  // { accept, reasons, agent, payment }
//   if (!answer.accept) return refuse(answer.reasons);
//   const paid = await wavly.redeem(order, { amount_paise: 54900, payment_reference: orderId });   // just before charging
//
// Modes: "require" refuses an order that declares an agent but is not accepted. "label" never refuses: it records the
// answer so you can see which agent orders TheWavly would have stopped. Orders that declare no agent are not touched in
// either mode.
//
// Optional: pass apiKey, a secret key from your own TheWavly account (free). Redemptions are then recorded as made by an
// independent store, which is what lets the agent's company show a publicly verifiable assurance level. The key is sent
// only with redemptions, and only for a token in the same mode as the key (sk_live_ for live, sk_test_ for test).

import { createHash, randomBytes } from "node:crypto";

export const HEADERS = { agent: "wavly-agent", token: "wavly-payment-token" };
const DEFAULT_BASE_URL = "https://thewavly.com";

export class WavlyMerchantError extends Error {
  constructor(status, body) {
    super(body?.error?.message || "TheWavly answered " + status);
    this.status = status; this.code = body?.error?.code || null; this.body = body;
  }
}

const payeeKey = v => String(v ?? "").trim().toLowerCase();
const header = (headers, name) => {
  if (!headers) return null;
  if (typeof headers.get === "function") return headers.get(name);
  const k = Object.keys(headers).find(h => h.toLowerCase() === name);
  const v = k === undefined ? null : headers[k];
  return Array.isArray(v) ? v[0] : v;
};
const clean = (v, max) => typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;

export function wavlyMerchant({ baseUrl = DEFAULT_BASE_URL, payees = [], merchant = null, mode = "require", allowTest = false, apiKey = null, onKeyRefused = null, fetch: f = globalThis.fetch, timeoutMs = 10000 } = {}) {
  if (!["require", "label"].includes(mode)) throw new TypeError('mode must be "require" or "label"');
  if (apiKey !== null && !/^sk_(live|test)_[\w-]{20,64}$/.test(String(apiKey))) throw new TypeError("apiKey must be a TheWavly secret key, sk_live_… or sk_test_…");
  const base = String(baseUrl).replace(/\/+$/, ""), mine = new Set(payees.map(payeeKey).filter(Boolean));
  const releaseKeys = new Map();   // payment token → release key, for redemptions made by this process

  const post = async (path, body, auth = null) => {
    const res = await f(base + path, { method: "POST", headers: { "content-type": "application/json", "user-agent": "wavly-merchant/0.1", ...(auth ? { authorization: "Bearer " + auth } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new WavlyMerchantError(res.status, data);
    return data;
  };

  // The agent and token an order carries, from request headers (a Headers object or a plain object), or null
  function read(headers) {
    const agent = clean(header(headers, HEADERS.agent), 80), payment_token = clean(header(headers, HEADERS.token), 4000);
    return agent || payment_token ? { agent, payment_token } : null;
  }

  // TheWavly's answer, plus the store's own checks: the amount you will charge, the payee, and test tokens on a live store.
  // Never throws for a bad order: a failure to reach TheWavly is an answer that does not accept.
  async function check(order, { amount_paise } = {}) {
    if (!order) return { accept: true, agent_order: false, reasons: [], agent: null, payment: null, mode };
    let answer;
    try { answer = await post("/v1/registry/verify", { agent: order.agent || "", payment_token: order.payment_token || undefined }); }
    catch (e) { answer = { accept: false, agent: null, payment: null, reasons: ["TheWavly could not be reached, so the order was not verified" + (e.status ? " (" + e.status + ")" : "") + "."] }; }
    const reasons = [...(answer.reasons || [])], p = answer.payment;
    if (p?.valid) {
      if (Number.isInteger(amount_paise) && amount_paise > p.max_amount_paise) reasons.push("The order total is more than the user approved (at most ₹" + (p.max_amount_paise / 100).toFixed(2) + ").");
      if (p.payee && mine.size && !mine.has(payeeKey(p.payee))) reasons.push("The user approved paying " + p.payee + ", not this store.");
      if (p.currency && p.currency !== "INR") reasons.push("The approval is for " + p.currency + ".");
      if (!p.livemode && !allowTest) reasons.push("The payment token is a test token.");
    }
    return { accept: answer.accept === true && reasons.length === 0, agent_order: true, reasons, agent: answer.agent || null, payment: p || null, mode };
  }

  // Whether to refuse the order: only in "require" mode, and only an agent order that was not accepted
  const refuse = answer => mode === "require" && answer.agent_order && !answer.accept;

  // Redeem the token once, just before charging. Throws WavlyMerchantError when TheWavly refuses. The answer carries
  // receipt and verify_url: keep them with the order as proof that the user approved it, for example against a dispute.
  // The store's own key, for a token in the same mode only: a live key never goes with a test token, or the other way
  const keyFor = token => { if (!apiKey) return null; try { const live = !!JSON.parse(Buffer.from(String(token).split(".")[1], "base64url")).livemode; return live === apiKey.startsWith("sk_live_") ? apiKey : null; } catch { return null; } };
  async function redeem(order, { amount_paise, payment_reference, payee, releaseKey }) {
    if (!order?.payment_token) throw new TypeError("The order carries no payment token.");
    if (!Number.isInteger(amount_paise) || amount_paise <= 0) throw new TypeError("amount_paise must be the whole number of paise about to be charged.");
    if (!clean(payment_reference, 120)) throw new TypeError("payment_reference is required, such as your order id.");
    // The token names the payee the user approved; send it back only when it is one of yours
    let to = payee;
    if (to === undefined) {
      const info = await post("/v1/payment_tokens/inspect", { token: order.payment_token });
      to = info.payee && (!mine.size || mine.has(payeeKey(info.payee))) ? info.payee : undefined;
    }
    // Every redemption is bound to a release key made here before the request (or the one you stored with the order), so
    // a retry after a lost answer proves it is the same checkout, and nobody else who saw the token can claim it first.
    // Store paid.release_key with the order and pass it as releaseKey when you retry from another process.
    const key = releaseKey || releaseKeys.get(order.payment_token) || "rlk_" + randomBytes(24).toString("base64url");
    releaseKeys.set(order.payment_token, key);
    const body = { token: order.payment_token, amount_paise, payee: to, merchant: merchant || undefined, payment_reference: String(payment_reference).slice(0, 120), currency: "INR",
      release_key_hash: createHash("sha256").update(key).digest("base64url") };
    // The store's key is optional. If TheWavly refuses it (revoked, rotated, restricted or from a blocked address), the
    // sale goes ahead without it, as a redemption that simply does not count as independent. onKeyRefused hears about it.
    let paid;
    try { paid = await post("/v1/payment_tokens/redeem", body, keyFor(order.payment_token)); }
    catch (e) {
      if (!(e instanceof WavlyMerchantError) || ![401, 403].includes(e.status) || !keyFor(order.payment_token) || !["unauthenticated", "insufficient_scope", "ip_not_allowed"].includes(e.body?.error?.code)) throw e;
      onKeyRefused?.(e);
      paid = await post("/v1/payment_tokens/redeem", body);
    }
    if (!paid.release_key_bound) throw new WavlyMerchantError(409, { error: { code: "redemption_unbound", message: "TheWavly did not confirm this redemption is yours. Do not charge." } });
    paid.release_key = key;
    return paid;
  }

  // After charging, confirm the debit you actually took, from your own TheWavly account (apiKey). It is what lets the agent
  // company show a publicly verifiable level 4. Needs the release key redeem() returned (remembered here for this process).
  async function confirm(order, { amount_paise, payment_reference, releaseKey } = {}) {
    if (!apiKey) throw new TypeError("confirm needs apiKey: your own TheWavly secret key.");
    if (!order?.payment_token) throw new TypeError("The order carries no payment token.");
    if (!Number.isInteger(amount_paise) || amount_paise <= 0) throw new TypeError("amount_paise must be the whole number of paise actually debited.");
    if (!clean(payment_reference, 120)) throw new TypeError("payment_reference is required: the gateway payment id or UPI reference of the debit.");
    const key = releaseKey || releaseKeys.get(order.payment_token), auth = keyFor(order.payment_token);
    if (!key) throw new TypeError("confirm needs the release_key that redeem() returned for this token.");
    if (!auth) throw new TypeError("apiKey is for the other mode than this payment token (sk_live_ for live tokens, sk_test_ for test).");
    return post("/v1/payment_tokens/confirm", { token: order.payment_token, release_key: key, amount_paise, payment_reference: String(payment_reference).slice(0, 120) }, auth);
  }

  // The charge failed after redeem(): give the approval back, so the user's budget is not spent on a payment that never
  // happened. Needs the release_key redeem() returned (remembered here for this process; store it with the order if the
  // charge may fail later). Safe to repeat.
  async function release(order, { releaseKey, reason } = {}) {
    if (!order?.payment_token) throw new TypeError("The order carries no payment token.");
    const key = releaseKey || releaseKeys.get(order.payment_token);
    if (!key) throw new TypeError("release needs the release_key that redeem() returned for this token.");
    return post("/v1/payment_tokens/release", { token: order.payment_token, release_key: key, ...(reason ? { reason: String(reason).slice(0, 200) } : {}) });
  }

  // Report what happened to an agent order: "delivered", "partially_delivered", "not_delivered", "returned", "refunded"
  // (with amountPaise) or "cancelled". It becomes signed evidence the agent company and its user can rely on, and settles
  // most "it never arrived" disputes before they start. Needs the release key, like release().
  async function fulfil(order, status, { releaseKey, items, amountPaise, carrier, trackingReference, note, occurredAt } = {}) {
    if (!order?.payment_token) throw new TypeError("The order carries no payment token.");
    const key = releaseKey || releaseKeys.get(order.payment_token);
    if (!key) throw new TypeError("fulfil needs the release_key that redeem() returned for this token.");
    const body = { token: order.payment_token, release_key: key, status, items, amount_paise: amountPaise, carrier, tracking_reference: trackingReference, note, occurred_at: occurredAt };
    return post("/v1/payment_tokens/fulfilment", Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)));
  }

  // Connect/Express middleware: reads the headers, checks the order and sets req.wavly. In "require" mode an agent order
  // that is not accepted gets 403 with the reasons. amount(req) returns the order total in paise, when you know it here.
  function middleware({ amount } = {}) {
    return async (req, res, next) => {
      try {
        const order = read(req.headers);
        const answer = await check(order, { amount_paise: amount ? await amount(req) : undefined });
        req.wavly = { order, ...answer, redeem: opts => redeem(order, opts) };
        if (refuse(answer)) {
          res.statusCode = 403; res.setHeader("content-type", "application/json");
          return res.end(JSON.stringify({ error: { code: "agent_order_refused", message: "This store accepts AI agent orders only when TheWavly verifies them.", reasons: answer.reasons } }));
        }
        next();
      } catch (e) { next(e); }
    };
  }

  // What to publish at /.well-known/wavly-merchant.json, so agents know to send the headers
  const discovery = () => ({ accepts: ["wavly-payment-token"], headers: { agent: "Wavly-Agent", payment_token: "Wavly-Payment-Token" }, payees: [...payees], requires_verified_agent: mode === "require", verifier: base });

  return { read, check, refuse, redeem, confirm, release, fulfil, middleware, discovery, mode };
}
