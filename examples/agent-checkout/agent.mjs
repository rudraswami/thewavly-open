// The agent's side: before buying from a store, check the purchase against what the user approved. At a store that
// takes TheWavly, send the agent's identity and the single-use payment token with the order.
import { Wavly } from "../../sdk/js/index.mjs";

// wavly: a Wavly client created with { agent: { id, privateKey } }, so every check is signed by the registered agent
export async function buy({ wavly, mandate, store, product, quantity = 1, fetch = globalThis.fetch }) {
  const merchant = await Wavly.merchantInfo(store, { fetch });
  const catalogue = await (await fetch(new URL("/products", store))).json();
  const p = catalogue.products.find(x => x.id === product);
  if (!p) return { ordered: false, reason: "The store does not sell " + product + "." };
  const purchase = { item: p.name, amount_paise: p.price_paise * quantity, quantity, merchant: catalogue.merchant, payee: catalogue.payee };
  const check = await wavly.checks.create({ mandate, purchase });
  if (check.decision !== "proceed") return { ordered: false, decision: check.decision, check, approval_url: check.approval?.url || null };
  const headers = { "content-type": "application/json", ...(merchant ? Wavly.checkoutHeaders(check, wavly.agent.id) : {}) };
  const res = await fetch(new URL("/checkout", store), { method: "POST", headers, body: JSON.stringify({ product, quantity }) });
  const order = await res.json();
  if (!res.ok) return { ordered: false, decision: "proceed", refused_by_store: order, check };
  // A store that redeemed the token has already marked the check paid; otherwise report the payment ourselves
  if (!order.wavly_check) await wavly.checks.reportOutcome(check.id, { status: "paid", payment_reference: order.id });
  return { ordered: true, order, check, verify_url: check.verify_url };
}
