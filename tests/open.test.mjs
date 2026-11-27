// Checks the open components work on their own, with no TheWavly account and no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { verifyToken } from "../sdk/verify/wavly-verify.mjs";
import { SCENARIOS } from "../bench/scenarios.mjs";
import { scripted } from "../bench/agents.mjs";
import { shopView, purchaseOf } from "../bench/harness.mjs";

test("the MCP server starts and lists its tools", async () => {
  const child = spawn(process.execPath, [new URL("../sdk/mcp/server.mjs", import.meta.url).pathname], { env: { ...process.env, WAVLY_API_KEY: "sk_test_offline" } });
  let out = "";
  child.stdout.on("data", d => { out += d; });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }) + "\n");
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
  for (let i = 0; i < 50 && out.split("\n").filter(Boolean).length < 2; i++) await new Promise(r => setTimeout(r, 100));
  child.kill();
  const [init, list] = out.split("\n").filter(Boolean).map(l => JSON.parse(l));
  assert.equal(init.result.serverInfo.name, "wavly");
  assert.deepEqual(list.result.tools.map(t => t.name).sort(), ["wavly_check_purchase", "wavly_create_mandate", "wavly_get_check", "wavly_report_payment"]);
});

test("the verifier accepts a genuine token and rejects a changed one", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const keys = [{ ...publicKey.export({ format: "jwk" }), kid: "k1" }];
  const body = Buffer.from(JSON.stringify({ kid: "k1", id: "chk_1", amount_paise: 50000 })).toString("base64url");
  const token = body + "." + sign(null, Buffer.from(body), privateKey).toString("base64url");
  assert.equal(verifyToken(token, keys).amount_paise, 50000);
  const forged = Buffer.from(JSON.stringify({ kid: "k1", id: "chk_1", amount_paise: 5000000 })).toString("base64url") + "." + token.split(".")[1];
  assert.throws(() => verifyToken(forged, keys), /signature/);
});

test("bench scenarios are well formed and every scripted baseline can run its shop view", async () => {
  assert.ok(SCENARIOS.length >= 30);
  for (const s of SCENARIOS) {
    assert.equal(s.offers.length, 4, s.id);
    for (const id of s.acceptable) assert.ok(s.offers.some(o => o.id === id), s.id + " acceptable " + id);
    for (const o of s.offers) assert.ok(purchaseOf(o).amount_paise > 0);
    for (const agent of Object.values(scripted)) {
      const act = await agent.decide(s, shopView(s));
      assert.ok(["buy", "ask"].includes(act.action));
    }
  }
});

test("TheWavly Guard blocks an order it cannot check (no TheWavly reachable): fail closed", async () => {
  const { guardHandler } = await import("../sdk/guard/guard.mjs");
  const { createShop } = await import("../examples/guard-demo/shop-server.mjs");
  const { Wavly } = await import("../sdk/guard/wavly-client.mjs");
  const shop = createShop(), wavly = new Wavly("sk_test_offline", { baseUrl: "https://wavly.invalid", fetch: async () => { throw new Error("offline"); }, maxRetries: 0 });
  const config = JSON.parse((await import("node:fs")).readFileSync(new URL("../examples/guard-demo/guard.json", import.meta.url), "utf8"));
  const g = guardHandler(shop.handle, { wavly, mandate: "mdt_example", tools: config.tools });
  const call = (name, args) => g({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }).then(r => r.result);
  await call("add_to_cart", { product_id: "p1", quantity: 2 });
  assert.equal((await call("place_order", { cart_id: "cart_1" })).isError, true);
  assert.equal(shop.orders.length, 0);
});
