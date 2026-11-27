import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const equal = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };
class GatewayError extends Error { constructor(gateway, status, body) { super(gateway + " answered " + status + (body?.error?.description || body?.message ? ": " + (body.error?.description || body.message) : "")); this.gateway = gateway; this.status = status; this.body = body; } }

function matchesProof(order, attempt, amount, currency, check) {
  return !!order && amount === attempt.amount_paise && currency === "INR" && check === attempt.wavly.check;
}

// Razorpay: POST /v1/orders with Basic auth; webhooks carry X-Razorpay-Signature, the hex HMAC-SHA256 of the raw body
export function razorpayGateway({ keyId, keySecret, webhookSecret, baseUrl = "https://api.razorpay.com", fetch: f = globalThis.fetch } = {}) {
  if (!keyId || !keySecret) throw new TypeError("razorpayGateway needs keyId and keySecret");
  const auth = { authorization: "Basic " + Buffer.from(keyId + ":" + keySecret).toString("base64") };
  return {
    name: "razorpay",
    async createOrder({ amount_paise, order_id, notes = {} }) {
      const res = await f(baseUrl + "/v1/orders", { method: "POST", headers: { "content-type": "application/json", ...auth },
        body: JSON.stringify({ amount: amount_paise, currency: "INR", receipt: String(order_id).slice(0, 40), notes }) });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new GatewayError("Razorpay", res.status, body);
      return body;
    },
    matchesOrder(row, attempt) {
      return !!row?.id && row.receipt === attempt.order_id.slice(0, 40)
        && (!attempt.gateway_reference || row.id === attempt.gateway_reference)
        && matchesProof(row, attempt, row.amount, row.currency, row.notes?.wavly_check);
    },
    async findOrder(attempt) {
      // Razorpay searches receipt by substring. Only an exact receipt, amount, currency AND
      // check can recover this order. An incomplete/ambiguous result remains pending.
      const receipt = attempt.order_id.slice(0, 40);
      const url = attempt.gateway_reference ? baseUrl + "/v1/orders/" + encodeURIComponent(attempt.gateway_reference)
        : baseUrl + "/v1/orders?" + new URLSearchParams({ receipt, count: "100" });
      const res = await f(url, { method: "GET", headers: auth });
      if (!res.ok) throw new GatewayError("Razorpay", res.status, null);
      const data = await res.json();
      const candidates = attempt.gateway_reference ? [data] : data.items;
      if (!Array.isArray(candidates) || (!attempt.gateway_reference && candidates.length >= 100)) return null;
      const matches = candidates.filter(row => this.matchesOrder(row, attempt));
      return matches.length === 1 ? matches[0] : null;
    },
    isPaid(order) { return order?.status === "paid"; },
    async disposition(order) {
      if (this.isPaid(order)) return "paid";
      if (Number(order?.amount_paid) > 0) return "payment_seen";
      return ["created", "attempted"].includes(order?.status) ? "created" : "pending";
    },
    verifyWebhook(rawBody, signature) {
      if (!webhookSecret) throw new TypeError("razorpayGateway needs webhookSecret to verify webhooks");
      return !!signature && equal(createHmac("sha256", webhookSecret).update(rawBody).digest("hex"), signature);
    },
    // The gateway order a payment.failed event is about
    failedOrderId(event) { return event?.event === "payment.failed" ? event.payload?.payment?.entity?.order_id || null : null; },
    reference(order) { return order.id; },
  };
}

// Cashfree PG: POST /pg/orders with x-client-id, x-client-secret and x-api-version; webhooks carry x-webhook-signature,
// the base64 HMAC-SHA256 of timestamp + raw body, keyed with the client secret
export function cashfreeGateway({ clientId, clientSecret, environment = "production", apiVersion = "2023-08-01", baseUrl, fetch: f = globalThis.fetch } = {}) {
  if (!clientId || !clientSecret) throw new TypeError("cashfreeGateway needs clientId and clientSecret");
  const base = baseUrl || (environment === "sandbox" ? "https://sandbox.cashfree.com" : "https://api.cashfree.com");
  const auth = { "x-client-id": clientId, "x-client-secret": clientSecret, "x-api-version": apiVersion };
  return {
    name: "cashfree",
    validate({ customer }) {
      if (!customer?.customer_id || !customer?.customer_phone) throw new TypeError("Cashfree needs customer.customer_id and customer.customer_phone");
    },
    async createOrder({ amount_paise, order_id, notes = {}, customer }) {
      if (!customer?.customer_id || !customer?.customer_phone) throw new TypeError("Cashfree needs customer.customer_id and customer.customer_phone");
      const res = await f(base + "/pg/orders", { method: "POST", headers: { "content-type": "application/json", ...auth },
        body: JSON.stringify({ order_id: String(order_id), order_amount: Number((amount_paise / 100).toFixed(2)), order_currency: "INR", customer_details: customer, order_tags: notes }) });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new GatewayError("Cashfree", res.status, body);
      return body;
    },
    matchesOrder(row, attempt) {
      return row?.order_id === attempt.order_id
        && matchesProof(row, attempt, Math.round(Number(row.order_amount) * 100), row.order_currency, row.order_tags?.wavly_check);
    },
    async findOrder(attempt) {
      const res = await f(base + "/pg/orders/" + encodeURIComponent(attempt.order_id), { method: "GET", headers: auth });
      if (res.status === 404) return null;
      if (!res.ok) throw new GatewayError("Cashfree", res.status, null);
      const row = await res.json();
      return this.matchesOrder(row, attempt) ? row : null;
    },
    isPaid(order) { return order?.order_status === "PAID"; },
    async disposition(order) {
      if (this.isPaid(order)) return "paid";
      if (order.order_status === "ACTIVE") return "created";
      if (order.order_status !== "EXPIRED") return "pending";
      // Expiry prevents new attempts. An attempt already in progress can still succeed during
      // its transaction TTL. Query every payment; never treat an empty, incomplete or stale
      // snapshot as proof that no late authorisation is possible.
      const res = await f(base + "/pg/orders/" + encodeURIComponent(order.order_id) + "/payments", { method: "GET", headers: auth });
      if (!res.ok) throw new GatewayError("Cashfree", res.status, null);
      const payments = await res.json();
      if (!Array.isArray(payments) || payments.length === 0) return "pending";
      if (payments.some(p => p?.order_id === order.order_id && p.cf_payment_id && p.payment_status === "SUCCESS")) return "payment_seen";
      const seen = new Set();
      for (const payment of payments) {
        if (!payment || payment.order_id !== order.order_id || !payment.cf_payment_id || seen.has(String(payment.cf_payment_id))
          || payment.payment_status !== "FAILED" || !Number.isFinite(Date.parse(payment.payment_completion_time))) return "pending";
        seen.add(String(payment.cf_payment_id));
      }
      // A snapshot of failed attempts alone cannot establish that a not-yet-visible one
      // will never appear. Require the provider's final unpaid closure before releasing.
      return "closure_review";
    },
    verifyWebhook(rawBody, signature, timestamp) {
      return !!signature && !!timestamp && equal(createHmac("sha256", clientSecret).update(String(timestamp) + rawBody).digest("base64"), signature);
    },
    failedOrderId(event) { return /^PAYMENT_FAILED/.test(event?.type || "") ? event.data?.order?.order_id || null : null; },
    reference(order) { return order.order_id; },
  };
}

// Low-level release for a definitively unpaid, closed order. A failed payment attempt is insufficient.
export async function releaseFailed({ wavly, record, reason = "payment failed" }) {
  if (!record?.payment_token || !record?.release_key) return { released: false, reason: "no TheWavly approval was used for this order" };
  const r = await wavly.release({ payment_token: record.payment_token }, { releaseKey: record.release_key, reason });
  return { released: true, ...r };
}

// Only returned to the merchant process. Never send recovery material or error causes to a buyer.
export class CheckoutPendingError extends Error {
  constructor(attempt, cause) {
    super("Keep order " + attempt.order_id + " on hold and reconcile its gateway state.", { cause });
    this.code = "checkout_pending";
    this.order_id = attempt.order_id;
    Object.defineProperty(this, "recovery", { value: attempt });
  }
}

const result = (record, gatewayOrder) => ({ refused: false, order_id: record.order_id, gateway_order: gatewayOrder,
  wavly: record.wavly, agent_order: true, accepted: true, reasons: [] });

function paidResult(record) {
  return { state: "paid", refused: false, order_id: record.order_id, gateway_reference: record.gateway_reference,
    gateway_order: null, wavly: record.wavly, agent_order: true, accepted: true, reasons: [] };
}

async function transition(journal, prior, next) {
  return !journal || await journal.transition(prior.state, next);
}

async function finishRelease({ wavly, journal }, attempt) {
  try {
    await releaseFailed({ wavly, record: attempt.wavly, reason: attempt.reason });
    const released = { ...attempt, state: "released" };
    await transition(journal, attempt, released);
    return { state: "released", order_id: attempt.order_id };
  } catch (error) {
    throw new CheckoutPendingError(attempt, error);
  }
}

// Recover only against provider reads. A timeout, a missing order or a failed payment
// attempt does not prove that the order cannot still be paid.
export async function recoverCheckout({ wavly, gateway, journal, order_id, recovery }) {
  const attempt = journal ? await journal.get(gateway.name, String(order_id ?? recovery?.order_id)) : recovery;
  if (!attempt || attempt.gateway !== gateway.name) throw new TypeError("No checkout recorded for this gateway and order");
  if (attempt.state === "paid") return paidResult(attempt);
  if (["released", "redemption_rejected"].includes(attempt.state)) return { state: attempt.state, order_id: attempt.order_id };
  if (attempt.state === "release_pending") return finishRelease({ wavly, journal }, attempt);
  if (attempt.state === "redeeming") return { state: "retry_original_request", order_id: attempt.order_id };
  let found, disposition;
  try {
    found = await gateway.findOrder(attempt);
    disposition = found ? await gateway.disposition?.(found) ?? "created" : "pending";
  } catch (error) { throw new CheckoutPendingError(attempt, error); }
  if (disposition === "paid") {
    const paidRecord = { ...attempt, state: "paid", gateway_reference: gateway.reference(found) };
    if (!await transition(journal, attempt, paidRecord)) return recoverCheckout({ wavly, gateway, journal, order_id: attempt.order_id });
    return paidResult(paidRecord);
  }
  if (disposition !== "created" || attempt.state === "payment_seen") {
    const state = disposition === "payment_seen" || attempt.state === "payment_seen" ? "payment_seen" : "awaiting_finality";
    if (attempt.state !== state && (found || attempt.state === "created")) {
      const waiting = { ...attempt, state, gateway_reference: found ? gateway.reference(found) : attempt.gateway_reference };
      if (!await transition(journal, attempt, waiting)) return recoverCheckout({ wavly, gateway, journal, order_id: attempt.order_id });
    }
    return { state: state === "payment_seen" ? "pending" : disposition, order_id: attempt.order_id };
  }
  const reference = gateway.reference(found);
  if (attempt.state !== "created") {
    if (!await transition(journal, attempt, { ...attempt, state: "created", gateway_reference: reference }))
      return recoverCheckout({ wavly, gateway, journal, order_id: attempt.order_id });
  }
  return { state: "created", ...result(attempt, found) };
}

// Merchant back office only. Use after the gateway has independently confirmed the order
// cannot be paid. Preserve its case/closure reference with the durable decision.
export async function confirmUnpaidCheckout({ wavly, gateway, journal, order_id, evidence_reference }) {
  if (!journal || typeof evidence_reference !== "string" || !evidence_reference.trim() || evidence_reference.length > 150)
    throw new TypeError("A checkout journal and provider closure reference are required.");
  const attempt = await journal.get(gateway.name, String(order_id));
  if (!attempt) throw new TypeError("Unknown checkout");
  if (["paid", "payment_seen"].includes(attempt.state)) throw new Error("A payment was already observed on this order. Keep its approval.");
  if (attempt.state === "released") return { state: "released", order_id: attempt.order_id };
  if (attempt.state === "release_pending") return finishRelease({ wavly, journal }, attempt);
  if (!["submitted", "created", "awaiting_finality"].includes(attempt.state)) throw new Error("No gateway submission is recorded for this order.");
  const found = await gateway.findOrder(attempt);
  if (found && await gateway.disposition?.(found) !== "closure_review")
    throw new Error("The gateway still lists a payable or paid order, or its payment attempts are unresolved. Keep its approval.");
  if (!found && attempt.gateway_reference) throw new Error("A previously accepted order cannot be found. Reconcile its attempts before closing.");
  const pending = { ...attempt, state: "release_pending", reason: "Merchant verified unpaid closure: " + evidence_reference.trim() };
  if (!await transition(journal, attempt, pending))
    return confirmUnpaidCheckout({ wavly, gateway, journal, order_id, evidence_reference });
  return finishRelease({ wavly, journal }, pending);
}

async function resumeExisting(options, attempt) {
  const recovered = await recoverCheckout({ ...options, recovery: attempt });
  if (["created", "paid"].includes(recovered.state)) return recovered;
  if (["released", "redemption_rejected"].includes(recovered.state)) throw new Error("Approval is closed for this order. Use a new order and approval.");
  throw new CheckoutPendingError(attempt);
}

function fingerprint(order, amount, customer, notes) {
  const normalize = v => v && typeof v === "object" && !Array.isArray(v)
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k, normalize(v[k])])) : v;
  return createHash("sha256").update(JSON.stringify(normalize({ order, amount, customer, notes }))).digest("hex");
}

export async function agentCheckout({ wavly, gateway, journal, recovery, headers, amount_paise, order_id, notes = {}, customer }) {
  if (!Number.isSafeInteger(amount_paise) || amount_paise <= 0) throw new TypeError("amount_paise must be a whole number of paise");
  if (!order_id || !String(order_id).trim() || String(order_id).trim() !== String(order_id) || String(order_id).length > 120) throw new TypeError("order_id must be 1 to 120 characters");
  order_id = String(order_id);
  const order = wavly.read(headers);
  const options = { wavly, gateway, journal, order_id };
  const key = fingerprint(order, amount_paise, customer, notes);
  let attempt = journal ? await journal.get(gateway.name, order_id) : recovery;
  if (attempt && (attempt.gateway !== gateway.name || attempt.order_id !== order_id)) throw new Error("Mismatched checkout record.");
  if (!attempt) {
    const answer = await wavly.check(order, { amount_paise });
    if (wavly.refuse(answer)) {
      // Another request may have redeemed this same order while verification was in flight.
      attempt = journal && await journal.get(gateway.name, order_id);
      if (!attempt) return { refused: true, reasons: answer.reasons, agent: answer.agent };
    } else {
      gateway.validate?.({ customer, amount_paise, order_id });
      if (!order || !answer.accept) {
        const gatewayOrder = await gateway.createOrder({ amount_paise, order_id, notes, customer });
        return { refused: false, order_id, gateway_order: gatewayOrder, wavly: null, agent_order: !!order, accepted: false, reasons: answer.reasons };
      }
      attempt = { gateway: gateway.name, order_id, amount_paise, fingerprint: key, state: "redeeming",
        wavly: { payment_token: order.payment_token, agent: answer.agent?.handle || order.agent, release_key: "rlk_" + randomBytes(32).toString("base64url") } };
      if (journal && !await journal.insert(attempt)) attempt = await journal.get(gateway.name, order_id);
    }
  }
  if (attempt.fingerprint !== key) throw new Error("This merchant order ID belongs to a different checkout.");
  if (attempt.state !== "redeeming") return resumeExisting(options, attempt);

  let paid;
  try {
    paid = await wavly.redeem(order, { amount_paise, payment_reference: order_id, releaseKey: attempt.wavly.release_key });
  } catch (error) {
    if (error.code && [401, 403, 409, 410, 422].includes(error.status)) {
      await transition(journal, attempt, { ...attempt, state: "redemption_rejected" });
      throw error;
    }
    throw new CheckoutPendingError(attempt, error);
  }
  if (!paid.release_key) throw new CheckoutPendingError(attempt);
  const proof = { ...attempt.wavly, check: paid.check, receipt: paid.receipt || null, verify_url: paid.verify_url || null, release_key: paid.release_key };
  const submitted = { ...attempt, state: "submitted", wavly: proof };
  if (!await transition(journal, attempt, submitted)) return resumeExisting(options, submitted);
  let gatewayOrder;
  try {
    gatewayOrder = await gateway.createOrder({ amount_paise, order_id, notes: { ...notes, wavly_check: proof.check, wavly_agent: String(proof.agent || "").slice(0, 80) }, customer });
    if (!gatewayOrder || (gateway.reference && !gateway.reference(gatewayOrder)) || (gateway.matchesOrder && !gateway.matchesOrder(gatewayOrder, submitted)))
      throw new Error("Gateway returned no matching order confirmation.");
  } catch (error) {
    // Only an authenticated adapter's explicit refusal is final. A duplicate, timeout,
    // disconnect, 5xx or malformed success may follow an accepted order.
    if (!(error instanceof GatewayError && [401, 403].includes(error.status))) throw new CheckoutPendingError(submitted, error);
    const pending = { ...submitted, state: "release_pending", reason: "Gateway rejected order creation" };
    if (!await transition(journal, submitted, pending)) return resumeExisting(options, submitted);
    await finishRelease(options, pending);
    throw error;
  }
  const created = { ...submitted, state: gateway.isPaid?.(gatewayOrder) ? "paid" : "created", gateway_reference: gateway.reference?.(gatewayOrder) };
  try {
    if (!await transition(journal, submitted, created)) return resumeExisting(options, submitted);
  } catch (error) { throw new CheckoutPendingError(submitted, error); }
  return created.state === "paid" ? paidResult(created) : result(created, gatewayOrder);
}
