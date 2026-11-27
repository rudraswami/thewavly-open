// A small store that takes orders from AI agents through TheWavly. One product, one checkout endpoint:
//   GET  /.well-known/wavly-merchant.json   tells agents the store takes TheWavly payment tokens
//   GET  /products                          the catalogue, with the store's UPI payee
//   POST /checkout { product, quantity }    an agent's order; refused unless TheWavly verifies it
// Orders that carry no Wavly-Agent header are treated as orders from people and go through as usual.
import { createServer } from "node:http";
import { wavlyMerchant } from "../../sdk/merchant/merchant.mjs";

export const PRODUCTS = [{ id: "dosa-kit", name: "Masala dosa kit", price_paise: 56100 }, { id: "filter-coffee", name: "Filter coffee, 500 g", price_paise: 42000 }];
export const PAYEE = "demokitchen@okhdfc";

export function createStore({ wavlyBaseUrl, mode = "require", allowTest = true, fetch } = {}) {
  const wavly = wavlyMerchant({ baseUrl: wavlyBaseUrl, payees: [PAYEE], merchant: "Demo Kitchen", mode, allowTest, ...(fetch ? { fetch } : {}) });
  const orders = [];
  const send = (res, status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  const server = createServer(async (req, res) => {
    try {
      const path = new URL(req.url, "http://store").pathname;
      if (req.method === "GET" && path === "/.well-known/wavly-merchant.json") return send(res, 200, wavly.discovery());
      if (req.method === "GET" && path === "/products") return send(res, 200, { merchant: "Demo Kitchen", payee: PAYEE, products: PRODUCTS });
      if (req.method !== "POST" || path !== "/checkout") return send(res, 404, { error: "not found" });
      let raw = ""; for await (const c of req) raw += c;
      const { product, quantity = 1 } = JSON.parse(raw || "{}");
      const p = PRODUCTS.find(x => x.id === product);
      if (!p || !Number.isInteger(quantity) || quantity < 1 || quantity > 10) return send(res, 422, { error: "unknown product or quantity" });
      const total = p.price_paise * quantity, id = "ord_" + (orders.length + 1001);
      // The store's question, before it charges: is this agent verified, and did its user approve this payment?
      const order = wavly.read(req.headers);
      const answer = await wavly.check(order, { amount_paise: total });
      if (wavly.refuse(answer)) return send(res, 403, { error: "agent_order_refused", reasons: answer.reasons });
      let wavlyCheck = null, proof = null;
      if (order && answer.accept) { const paid = await wavly.redeem(order, { amount_paise: total, payment_reference: id }); wavlyCheck = paid.check; proof = paid.verify_url || null; }
      // …charge the customer here, for exactly `total`…
      const placed = { id, product: p.id, quantity, total_paise: total, agent: answer.agent?.handle || null, wavly_check: wavlyCheck, approval_proof: proof, verified: !!(order && answer.accept) };
      orders.push(placed);
      return send(res, 200, placed);
    } catch (e) { return send(res, 500, { error: String(e.message || e) }); }
  });
  return { server, orders };
}
