// Runs each framework's guarded tool the way the framework calls it, without a model: a payee the user never named is
// stopped, the ₹561 cart (quoted ₹475) is held for the user, and once they approve the same call places the order.
//   npm install && WAVLY_API_KEY=sk_test_… node check.mjs
// It approves on the user's behalf, so it refuses live keys.
import assert from "node:assert/strict";
import { Wavly } from "../../sdk/js/index.mjs";
import { RunContext } from "@openai/agents";
import { createShop } from "./shop.mjs";
import * as vercel from "./vercel-ai.mjs";
import * as lc from "./langchain.mjs";
import * as oa from "./openai-agents.mjs";
if (!/^sk_test_/.test(process.env.WAVLY_API_KEY || "")) { console.error("Set WAVLY_API_KEY to a test key (sk_test_…)"); process.exit(2); }
const wavly = new Wavly(process.env.WAVLY_API_KEY, { baseUrl: process.env.WAVLY_BASE_URL || undefined });
const mandate = async () => (await wavly.mandates.create({ instruction: "Two Oreo shakes from Demo Kitchen, up to ₹500", approved_by: "u1", rules: { items: ["Food order"], max_amount_paise: 50000, payees: ["demokitchen@okhdfc"] } })).id;
const approve = url => fetch(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "decision=approve" });
const runners = {
  "Vercel AI SDK": async ctx => { const t = vercel.placeOrderTool(ctx); return a => t.execute(a, { toolCallId: "c1", messages: [] }); },
  "LangChain.js": async ctx => { const t = lc.placeOrderTool(ctx); return async a => JSON.parse(await t.invoke(a)); },
  "OpenAI Agents JS": async ctx => { const t = oa.placeOrderTool(ctx); return async a => { const r = await t.invoke(new RunContext(), JSON.stringify(a)); return typeof r === "string" ? JSON.parse(r) : r; }; },
};
for (const [name, make] of Object.entries(runners)) {
  const shop = createShop(), call = await make({ wavly, mandate: await mandate(), shop });
  const stop = await call({ cart_id: "cart_2" });
  assert.equal(stop.decision, "stop", name);
  const ask = await call({ cart_id: "cart_1" });
  assert.equal(ask.decision, "ask", name); assert.equal(shop.orders.length, 0, name);
  await approve(ask.approval_url);
  const done = await call({ cart_id: "cart_1" });
  assert.equal(done.order_id, "ord_1", name + " " + JSON.stringify(done)); assert.match(done.wavly.verify_url, /\/verify#/);
  assert.equal(shop.orders.length, 1, name);
  console.log("ok  " + name.padEnd(17) + " stop → ask → approved → ordered  receipt " + done.wavly.check_id);
}
