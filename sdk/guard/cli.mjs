#!/usr/bin/env node
// wavly-guard: put TheWavly in front of any stdio MCP server, with no change to the server.
//
//   WAVLY_API_KEY=sk_… WAVLY_MANDATE=mdt_… wavly-guard --config guard.json -- node shop-server.mjs
//
// Your MCP client starts wavly-guard instead of the server. Every message passes through untouched, except calls to the
// tools named in guard.json, which are held until TheWavly answers (see guard.mjs).
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { Wavly } from "./wavly-client.mjs";
import { createGuard } from "./guard.mjs";

const argv = process.argv.slice(2), sep = argv.indexOf("--");
const opt = k => { const i = argv.indexOf("--" + k); return i >= 0 && (sep < 0 || i < sep) ? argv[i + 1] : null; };
const command = sep >= 0 ? argv.slice(sep + 1) : [];
if (!opt("config") || !command.length) { console.error("Usage: wavly-guard --config guard.json -- <command that starts your MCP server>"); process.exit(2); }
const config = JSON.parse(readFileSync(opt("config"), "utf8"));
const wavly = new Wavly(process.env.WAVLY_API_KEY, process.env.WAVLY_BASE_URL ? { baseUrl: process.env.WAVLY_BASE_URL } : {});

const child = spawn(command[0], command.slice(1), { stdio: ["pipe", "pipe", "inherit"] });
child.on("exit", code => process.exit(code ?? 0));
const toServer = msg => child.stdin.write(JSON.stringify(msg) + "\n");
const toClient = msg => process.stdout.write(JSON.stringify(msg) + "\n");

// The Guard's own requests to the server (to read the cart), and the client's guarded calls awaiting the server
let n = 0;
const own = new Map(), held = new Map();
const callTool = (name, args) => new Promise((resolve, reject) => {
  const id = "wavly-guard-" + ++n;
  own.set(id, { resolve, reject });
  setTimeout(() => { if (own.delete(id)) reject(new Error("no answer from the server")); }, 15000);
  toServer({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
});
const guard = createGuard({ wavly, mandate: config.mandate || process.env.WAVLY_MANDATE, tools: config.tools || {}, agent: config.agent, callTool });

createInterface({ input: child.stdout }).on("line", async line => {
  let msg; try { msg = JSON.parse(line); } catch { return process.stdout.write(line + "\n"); }
  if (msg.id !== undefined && own.has(msg.id)) { const p = own.get(msg.id); own.delete(msg.id); return msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result); }
  if (msg.id !== undefined && held.has(msg.id)) {
    const h = held.get(msg.id); held.delete(msg.id);
    return toClient(msg.result ? { ...msg, result: await guard.after(h.name, h.args, h.check, msg.result) } : msg);
  }
  process.stdout.write(line + "\n");
});

createInterface({ input: process.stdin }).on("line", async line => {
  let msg; try { msg = JSON.parse(line); } catch { return child.stdin.write(line + "\n"); }
  const name = msg?.method === "tools/call" ? msg.params?.name : null;
  if (!name || !guard.guards(name)) return child.stdin.write(line + "\n");
  const args = msg.params.arguments || {};
  const gate = await guard.before(name, args);
  if (!gate.allow) return toClient({ jsonrpc: "2.0", id: msg.id, result: gate.result });
  held.set(msg.id, { name, args, check: gate.check });
  toServer(msg);
}).on("close", () => child.stdin.end());
