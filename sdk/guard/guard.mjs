// TheWavly Guard: makes TheWavly check impossible to skip for an MCP server that takes orders or payments.
//
// TheWavly MCP server is advisory: the agent is told to call wavly_check_purchase before paying, and an agent that has
// been talked into something (a prompt-injected listing, a fake discount) can simply not call it. The Guard sits in the
// tool path instead. Every call to a tool you mark as an order or payment tool is held until TheWavly answers:
//   proceed  the call goes through, the outcome is reported to TheWavly, and the result carries the receipt link
//   ask      the call is not made; the agent gets the user's approval link, and the same call goes through once approved
//   stop     the call is not made
// It reads the purchase from the shop itself where it can (for example the server's own cart total, not the price the
// agent was quoted), and the mandate comes from your configuration, never from the agent. Anything it cannot read or
// check fails closed: the order is not placed.
//
// Two ways to use it: guardHandler() around an in-process JSON-RPC handler, or the wavly-guard command in front of any
// stdio MCP server (see cli.mjs). The configuration is the same:
//
//   { "mandate": "mdt_…",                                  // or WAVLY_MANDATE; never taken from the agent
//     "tools": { "place_order": {
//         "resolve": { "tool": "view_cart", "arguments": { "cart_id": "args.cart_id" } },   // optional: ask the server
//         "purchase": { "item": { "const": "Food order" }, "amount_rupees": "resolved.total_rupees",
//                       "merchant": "resolved.store", "payee": "resolved.upi_id", "terms": { "subscription": "resolved.subscription" } },
//         "reference": "result.order_id" } } }
//
// Paths start with args (the tool call's arguments), resolved (the resolve tool's result) or result (the order tool's
// result, for the payment reference). Amounts may be given as amount_paise or amount_rupees.
import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

// Inside a guarded function: the headers to send a store that takes TheWavly (Wavly-Agent and Wavly-Payment-Token),
// or null when the agent has no registry identity or the check carries no payment token.
//   const execute = guardFunction(async ({ cart_id }) => fetch(store + "/checkout", { headers: { ...checkoutHeaders() }, … }), { … })
const current = new AsyncLocalStorage();
export const checkoutHeaders = () => current.getStore()?.headers || null;
export const currentCheck = () => current.getStore()?.check || null;

// The token for a check that may be paid: the one it came with, or a fresh one after the user approved
async function headersFor(wavly, check, agent) {
  const id = wavly.agent?.id || agent;
  if (!id) return null;
  let token = check.payment_token?.token;
  if (!token) { try { token = (await wavly.checks.paymentToken(check.id)).token; } catch { token = null; } }
  return token ? { "Wavly-Agent": id, "Wavly-Payment-Token": token } : null;
}

const at = (obj, path) => String(path).split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
const value = (spec, src) => spec && typeof spec === "object" && "const" in spec ? spec.const : typeof spec === "string" ? at(src, spec) : undefined;
const key = (name, purchase) => createHash("sha256").update(name + "\n" + JSON.stringify(purchase)).digest("hex");

// The data a tool result carries: structuredContent, or JSON in its first text block
export function resultData(result) {
  if (!result) return null;
  if (result.structuredContent && typeof result.structuredContent === "object") return result.structuredContent;
  const text = result.content?.find?.(c => c.type === "text")?.text;
  if (typeof text !== "string") return null;
  try { return JSON.parse(text); } catch { return null; }
}

const refuse = (text, wavly) => ({ content: [{ type: "text", text }], isError: true, structuredContent: { wavly } });

export function buildPurchase(spec, src) {
  const p = {}, s = spec || {};
  p.item = value(s.item, src);
  const paise = s.amount_paise !== undefined ? Number(value(s.amount_paise, src)) : s.amount_rupees !== undefined ? Math.round(Number(value(s.amount_rupees, src)) * 100) : NaN;
  p.amount_paise = paise;
  for (const f of ["merchant", "payee", "deliver_to", "item_id"]) { const v = value(s[f], src); if (v !== undefined && v !== null) p[f] = String(v); }
  const q = value(s.quantity, src); if (q !== undefined && q !== null) p.quantity = Number(q);
  if (s.terms) { const t = {}; for (const [k, path] of Object.entries(s.terms)) { const v = value(path, src); if (v !== undefined) t[k] = v; } if (Object.keys(t).length) p.terms = t; }
  if (typeof p.item !== "string" || !p.item || !Number.isInteger(p.amount_paise) || p.amount_paise <= 0) return null;
  return p;
}

// The decision for one purchase. waiting maps a purchase key to the check id while the user is being asked, so the
// same call goes through once they approve. Returns { allow: true, check } or { allow: false, message, wavly }.
async function gate({ wavly, mandate, agent, waiting }, name, purchase) {
  const k = key(name, purchase);
  try {
    // The same order again, after the user was asked
    if (waiting.has(k)) {
      const c = await wavly.checks.retrieve(waiting.get(k));
      const answer = c.approval?.status;
      if (answer === "approved" && c.status === "held") { waiting.delete(k); return { allow: true, check: c }; }
      if (answer === "pending") return { allow: false, message: "ASK FIRST: still waiting for the user's answer. Nothing was ordered. The approval link: " + c.approval.url, wavly: { decision: "ask", check_id: c.id, approval_url: c.approval.url || null } };
      waiting.delete(k);
      return { allow: false, message: "STOP: the user did not approve this order (" + (answer || c.status) + "). Nothing was ordered. Do not retry.", wavly: { decision: "stop", check_id: c.id } };
    }
    const c = await wavly.checks.create({ mandate, purchase, ...(agent ? { agent } : {}) });
    const why = c.results.filter(r => r.result !== "match").map(r => r.label || r.field.replace(/_paise$/, "")).join(", ");
    if (c.decision === "proceed") return { allow: true, check: c };
    if (c.decision === "ask") {
      waiting.set(k, c.id);
      return { allow: false, message: "ASK FIRST: this order goes beyond what the user approved (" + why + "). Nothing was ordered. Send the user this link to approve or decline" +
        (c.approval?.url ? ": " + c.approval.url : "") + ". Once they approve, make the same call again.", wavly: { decision: "ask", check_id: c.id, approval_url: c.approval?.url || null, amount_paise: purchase.amount_paise } };
    }
    return { allow: false, message: "STOP: this order is not what the user approved (" + why + "). Nothing was ordered. Tell the user; do not retry.", wavly: { decision: "stop", check_id: c.id } };
  } catch (e) {
    // Fail closed: no answer from TheWavly means no order
    return { allow: false, message: "TheWavly could not check this order (" + String(e.message || e).slice(0, 120) + "), so it was not placed. Try again shortly.", wavly: { decision: "error" } };
  }
}

const needMandate = (wavly, mandate) => {
  if (!wavly) throw new Error("TheWavly Guard needs a TheWavly client");
  if (!/^mdt_/.test(mandate || "")) throw new Error("TheWavly Guard needs the mandate id (mdt_…) from your configuration or WAVLY_MANDATE");
};

export function createGuard({ wavly, mandate, tools, callTool, agent }) {
  needMandate(wavly, mandate);
  const waiting = new Map(); // purchase key → check id, while the user is asked

  return {
    guards: name => Object.prototype.hasOwnProperty.call(tools || {}, name),

    // Returns { allow: true, check } or { allow: false, result } where result is the tool result to send the agent
    async before(name, args = {}) {
      const spec = tools[name];
      let resolved = null;
      if (spec.resolve) {
        const rargs = Object.fromEntries(Object.entries(spec.resolve.arguments || {}).map(([k, path]) => [k, value(path, { args })]));
        try { const r = await callTool(spec.resolve.tool, rargs); if (r?.isError) throw new Error("it returned an error"); resolved = resultData(r); }
        catch (e) { return { allow: false, result: refuse("TheWavly Guard could not read the order from " + spec.resolve.tool + " (" + (e.message || e) + "). Nothing was ordered.", { decision: "error" }) }; }
      }
      const purchase = buildPurchase(spec.purchase, { args, resolved });
      if (!purchase) return { allow: false, result: refuse("TheWavly Guard could not read the item and amount of this order. Nothing was ordered.", { decision: "error" }) };
      const g = await gate({ wavly, mandate, agent, waiting }, name, purchase);
      return g.allow ? g : { allow: false, result: refuse(g.message, g.wavly) };
    },

    // After the real tool ran: report the outcome so budgets stay right, and give the agent the receipt link
    async after(name, args, check, result) {
      const failed = !result || result.isError;
      const reference = value(tools[name].reference, { args, result: resultData(result) });
      try { await wavly.checks.reportOutcome(check.id, failed ? { status: "failed" } : { status: "paid", payment_reference: String(reference || "mcp-" + Date.now()).slice(0, 120) }); } catch {}
      if (failed || !check.verify_url) return result;
      return { ...result, content: [...(result.content || []), { type: "text", text: "Checked by TheWavly before the order. Proof for the user: " + check.verify_url }] };
    },
  };
}

// Wraps an in-process JSON-RPC handler (msg → response) so its order and payment tools are guarded
export function guardHandler(handle, options) {
  let n = 0;
  const callTool = async (name, args) => (await handle({ jsonrpc: "2.0", id: "wavly-guard-" + ++n, method: "tools/call", params: { name, arguments: args } }))?.result;
  const guard = createGuard({ ...options, callTool });
  return async msg => {
    const name = msg?.method === "tools/call" ? msg.params?.name : null;
    if (!name || !guard.guards(name)) return handle(msg);
    const args = msg.params.arguments || {};
    const gate = await guard.before(name, args);
    if (!gate.allow) return { jsonrpc: "2.0", id: msg.id, result: gate.result };
    const out = await handle(msg);
    return out?.result ? { ...out, result: await guard.after(name, args, gate.check, out.result) } : out;
  };
}

// Guards one payment or order function, for any agent framework: the function your LangChain, Vercel AI SDK or
// OpenAI Agents tool calls to pay. Wrap the function, then give the wrapped one to the framework.
//
//   const pay = guardFunction(placeOrder, { wavly, mandate: process.env.WAVLY_MANDATE,
//     purchase: async ({ cart_id }) => { const cart = await shop.cart(cart_id);       // read the real total, not the quote
//       return { item: "Food order", amount_paise: cart.total_paise, merchant: cart.store, payee: cart.upi_id }; },
//     reference: order => order.id });
//
// purchase(...args) gets the same arguments as the function and returns the purchase TheWavly checks (amount_paise, or
// amount_rupees). The function runs only when TheWavly answers proceed, or after the user approves the same purchase;
// the outcome is then reported with reference(result, ...args). Otherwise the function is not called, and the wrapper
// returns { ordered: false, decision, message, check_id, approval_url } for the agent to act on. A string result gets the
// receipt link appended; a plain-object result gets a wavly field with it. Anything unreadable fails closed.
export function guardFunction(fn, { wavly, mandate, purchase, reference, agent, name } = {}) {
  needMandate(wavly, mandate);
  if (typeof fn !== "function") throw new Error("guardFunction needs the function that pays or places the order");
  if (typeof purchase !== "function") throw new Error("guardFunction needs purchase(...args), returning the purchase to check");
  const waiting = new Map(), label = name || fn.name || "payment";
  const refusal = (message, s) => ({ ordered: false, decision: s.decision, message, ...(s.check_id ? { check_id: s.check_id } : {}), ...(s.approval_url ? { approval_url: s.approval_url } : {}) });
  return async function guarded(...args) {
    let p;
    try { p = await purchase(...args); } catch (e) { return refusal("TheWavly Guard could not read this order (" + String(e.message || e).slice(0, 120) + "). Nothing was ordered.", { decision: "error" }); }
    const spec = p && typeof p === "object" ? { ...p } : null;
    if (spec && spec.amount_paise === undefined && spec.amount_rupees !== undefined) { spec.amount_paise = Math.round(Number(spec.amount_rupees) * 100); delete spec.amount_rupees; }
    if (!spec || typeof spec.item !== "string" || !spec.item || !Number.isInteger(spec.amount_paise) || spec.amount_paise <= 0)
      return refusal("TheWavly Guard could not read the item and amount of this order. Nothing was ordered.", { decision: "error" });
    const g = await gate({ wavly, mandate, agent, waiting }, label, spec);
    if (!g.allow) return refusal(g.message, g.wavly);
    let result;
    const headers = await headersFor(wavly, g.check, agent);
    try { result = await current.run({ check: g.check, headers }, () => fn(...args)); }
    catch (e) { try { await wavly.checks.reportOutcome(g.check.id, { status: "failed" }); } catch {} throw e; }
    let ref; try { ref = reference ? await reference(result, ...args) : undefined; } catch {}
    try { await wavly.checks.reportOutcome(g.check.id, { status: "paid", payment_reference: String(ref || label + "-" + Date.now()).slice(0, 120) }); } catch {}
    const url = g.check.verify_url;
    if (!url) return result;
    if (typeof result === "string") return result + "\n\nChecked by TheWavly before payment. Proof for the user: " + url;
    if (result && Object.getPrototypeOf(result) === Object.prototype) return { ...result, wavly: { decision: "proceed", check_id: g.check.id, verify_url: url } };
    return result;
  };
}
