#!/usr/bin/env node
// TheWavly MCP server: lets an AI agent check a purchase against what the user approved before it pays.
// Speaks the Model Context Protocol over stdio. Configure with WAVLY_API_KEY (and WAVLY_BASE_URL if self-hosted).
//
//   { "mcpServers": { "wavly": { "command": "node", "args": ["/path/to/sdk/mcp/server.mjs"], "env": { "WAVLY_API_KEY": "sk_test_…" } } } }
import { createInterface } from "node:readline";
import { realpathSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Wavly, WavlyError } from "./wavly-client.mjs";

const paise = rupees => Math.round(Number(rupees) * 100);
const rupees = p => "₹" + (p / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 });

export const TOOLS = [
  { name: "wavly_create_mandate", description: "Record what the user approved before shopping for them: which items, the most per purchase, an optional total budget and the UPI payees allowed. Returns a mandate id to use with wavly_check_purchase.",
    inputSchema: { type: "object", required: ["instruction", "approved_by", "items", "max_amount_rupees"], properties: {
      instruction: { type: "string", description: "The user's words, verbatim" }, approved_by: { type: "string", description: "Your reference for the user (not their phone number or name)" },
      items: { type: "array", items: { type: "string" }, description: "Items the user allowed" }, max_amount_rupees: { type: "number" }, budget_rupees: { type: "number" },
      payees: { type: "array", items: { type: "string" }, description: "UPI addresses allowed, such as shop@okhdfc" }, deliver_to: { type: "string" } } } },
  { name: "wavly_check_purchase", description: "Call this immediately before paying. It compares the purchase with what the user approved. Pay only if the decision is proceed. If it is ask, give the user the approval link and wait for their answer with wavly_get_check. If it is stop, do not pay and tell the user why.",
    inputSchema: { type: "object", required: ["mandate_id", "item", "amount_rupees"], properties: {
      mandate_id: { type: "string" }, item: { type: "string" }, amount_rupees: { type: "number" }, payee: { type: "string", description: "UPI address being paid" },
      merchant: { type: "string" }, deliver_to: { type: "string" }, order_reference: { type: "string", description: "Your order id; makes a repeated call safe" },
      terms: { type: "object", description: "The terms you were shown, such as {\"refundable\": true, \"free_cancellation_hours\": 48}. Send exactly what the seller showed." } } } },
  { name: "wavly_get_check", description: "Look up a check, for example to see whether the user has approved an ask.",
    inputSchema: { type: "object", required: ["check_id"], properties: { check_id: { type: "string" } } } },
  { name: "wavly_report_payment", description: "After paying (or giving up), record what happened so the user's budget stays correct.",
    inputSchema: { type: "object", required: ["check_id", "status"], properties: { check_id: { type: "string" }, status: { type: "string", enum: ["paid", "failed", "cancelled"] }, payment_reference: { type: "string", description: "UPI reference number when paid" } } } },
];

function explain(c, agent) {
  const failed = c.results.filter(r => r.result !== "match").map(r => r.field.replace(/_paise$/, "") + " (" + r.result + ")");
  const head = { proceed: "PROCEED. The purchase matches what the user approved. You may pay now" + (c.payment_token ? ". Give the payment provider this single-use payment token, valid for at most " + rupees(c.payment_token.max_amount_paise) + ": " + c.payment_token.token + " . If the provider does not take TheWavly tokens, pay and then call wavly_report_payment." : ", then call wavly_report_payment."),
    ask: "ASK FIRST. Do not pay yet. The purchase goes beyond what the user approved: " + failed.join(", ") + ". " + (c.approval?.url ? "Send the user this link to approve or decline: " + c.approval.url + " . " : "") + "Then call wavly_get_check until approval.status is approved or declined.",
    stop: "STOP. Do not pay. This is not what the user approved: " + failed.join(", ") + ". Tell the user." }[c.decision];
  // On proceed, the agent can show the user proof that the purchase was checked
  // At a store that takes TheWavly, the agent sends its identity and the token with the order
  const headers = c.decision === "proceed" && c.payment_token && agent ? "\n\nIf the store takes TheWavly (it serves /.well-known/wavly-merchant.json, or its checkout asks for these), send these HTTP headers with the order: Wavly-Agent: " + agent + " and Wavly-Payment-Token: " + c.payment_token.token + " . The token pays once, for at most " + rupees(c.payment_token.max_amount_paise) + "." : "";
  const proof = c.decision === "proceed" && c.verify_url ? "\n\nAfter paying, you can give the user this link, which proves the purchase was checked against what they approved: " + c.verify_url : "";
  return head + headers + proof + "\n\n" + JSON.stringify({ check_id: c.id, decision: c.decision, status: c.status, amount: rupees(c.purchase.amount_paise), approval: c.approval || null, verify_url: c.verify_url || null }, null, 2);
}

export function createHandlers(client) {
  const call = {
    async wavly_create_mandate(a) {
      const m = await client.mandates.create({ instruction: a.instruction, approved_by: a.approved_by, rules: { items: a.items, max_amount_paise: paise(a.max_amount_rupees),
        ...(a.budget_rupees ? { budget_paise: paise(a.budget_rupees) } : {}), ...(a.payees?.length ? { payees: a.payees } : {}), ...(a.deliver_to ? { deliver_to: a.deliver_to } : {}) } });
      return "Mandate recorded. Use mandate_id " + m.id + " when checking purchases.\n\n" + JSON.stringify({ mandate_id: m.id, version: m.version, expires_at: new Date(m.expires_at * 1000).toISOString(), rules: m.rules }, null, 2);
    },
    async wavly_check_purchase(a) {
      const c = await client.checks.create({ mandate: a.mandate_id, purchase: { item: a.item, amount_paise: paise(a.amount_rupees), ...(a.payee ? { payee: a.payee } : {}), ...(a.merchant ? { merchant: a.merchant } : {}), ...(a.deliver_to ? { deliver_to: a.deliver_to } : {}), ...(a.order_reference ? { reference: a.order_reference } : {}), ...(a.terms ? { terms: a.terms } : {}) } },
        a.order_reference ? { idempotencyKey: "mcp:" + a.mandate_id + ":" + a.order_reference } : {});
      return explain(c, client.agent?.id);
    },
    async wavly_get_check(a) {
      const c = await client.checks.retrieve(a.check_id);
      if (c.approval?.status === "approved" && c.status === "held") {
        // A fresh single-use token for the approved purchase, for a store or payment provider that takes TheWavly
        let token = null; try { token = await client.checks.paymentToken(c.id); } catch { token = null; }
        const agent = client.agent?.id;
        const send = token ? (agent ? " If the store takes TheWavly, send these HTTP headers with the order: Wavly-Agent: " + agent + " and Wavly-Payment-Token: " + token.token + " ." : " Give the payment provider this single-use payment token: " + token.token + " .") : "";
        return "The user APPROVED. You may pay now, then call wavly_report_payment." + send + "\n\n" + JSON.stringify({ ...c, payment_token: token || c.payment_token || null }, null, 2);
      }
      return (c.approval?.status === "declined" ? "The user DECLINED. Do not pay.\n\n" : "") + JSON.stringify(c, null, 2);
    },
    async wavly_report_payment(a) { const c = await client.checks.reportOutcome(a.check_id, { status: a.status, ...(a.payment_reference ? { payment_reference: a.payment_reference } : {}) }); return "Recorded as " + c.status + "."; },
  };
  return async function handle(msg) {
    const reply = result => ({ jsonrpc: "2.0", id: msg.id, result });
    if (msg.method === "initialize") return reply({ protocolVersion: msg.params?.protocolVersion || "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "wavly", version: "0.2.0" },
      instructions: "Before paying for anything on the user's behalf, call wavly_check_purchase and follow its decision." });
    if (msg.method === "ping") return reply({});
    if (msg.method === "tools/list") return reply({ tools: TOOLS });
    if (msg.method === "tools/call") {
      const fn = call[msg.params?.name];
      if (!fn) return { jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "Unknown tool: " + msg.params?.name } };
      try { return reply({ content: [{ type: "text", text: await fn(msg.params.arguments || {}) }] }); }
      catch (e) { return reply({ isError: true, content: [{ type: "text", text: (e instanceof WavlyError ? "TheWavly said: " : "Error: ") + e.message }] }); }
    }
    if (msg.id === undefined) return null; // a notification
    return { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found: " + msg.method } };
  };
}

// The agent's identity in TheWavly's registry: WAVLY_AGENT (handle or id) and its private key, as a JWK in WAVLY_AGENT_KEY
// or in the file WAVLY_AGENT_KEY_FILE. With them every check is signed and counts toward the agent's public record.
export function agentFromEnv(env) {
  if (!env.WAVLY_AGENT) return null;
  const text = env.WAVLY_AGENT_KEY || (env.WAVLY_AGENT_KEY_FILE ? readFileSync(env.WAVLY_AGENT_KEY_FILE, "utf8") : null);
  let privateKey = null;
  if (text) { try { privateKey = JSON.parse(text); } catch { throw new Error("WAVLY_AGENT_KEY must be the agent's private key as a JWK (JSON)"); } }
  if (privateKey && !privateKey.d) throw new Error("WAVLY_AGENT_KEY is a public key; the agent signs with its private key");
  return { id: env.WAVLY_AGENT, privateKey };
}

// Local npm installs and command shims may invoke this file through a symlink.
function isMain() {
  try { return !!process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; }
  catch { return false; }
}
if (isMain()) {
  const client = new Wavly(process.env.WAVLY_API_KEY, { ...(process.env.WAVLY_BASE_URL ? { baseUrl: process.env.WAVLY_BASE_URL } : {}), agent: agentFromEnv(process.env) });
  const handle = createHandlers(client);
  createInterface({ input: process.stdin }).on("line", async line => {
    if (!line.trim()) return;
    let msg; try { msg = JSON.parse(line); } catch { return process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }) + "\n"); }
    const out = await handle(msg);
    if (out) process.stdout.write(JSON.stringify(out) + "\n");
  });
}
