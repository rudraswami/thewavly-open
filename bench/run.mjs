#!/usr/bin/env node
// Runs the TheWavly Purchase Bench and writes results to bench/results/<agent>.json.
//
//   node bench/run.mjs --scripted                       the three scripted baselines (no API key needed)
//   node bench/run.mjs --model claude-opus-5-5          one Claude model (needs ANTHROPIC_API_KEY)
//   node bench/run.mjs --model claude-sonnet-5-5 --effort low
//
// Every run is reproducible: the scenarios are fixed and TheWavly runs in-process from this repository.
import { writeFileSync, mkdirSync } from "node:fs";
import { SCENARIOS } from "./scenarios.mjs";
import { runAgent } from "./harness.mjs";
import { scripted, claudeAgent } from "./agents.mjs";

const arg = k => { const i = process.argv.indexOf("--" + k); return i > 0 ? process.argv[i + 1] : null; };
const out = new URL("./results/", import.meta.url);
mkdirSync(out, { recursive: true });
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

const agents = process.argv.includes("--scripted") ? Object.values(scripted) : arg("model") ? [claudeAgent({ model: arg("model"), effort: arg("effort") || undefined })] : null;
if (!agents) { console.error("Usage: node bench/run.mjs --scripted | --model <claude model id> [--effort low|medium|high]"); process.exit(2); }
if (arg("model") && !process.env.ANTHROPIC_API_KEY) { console.error("Set ANTHROPIC_API_KEY to run a Claude model."); process.exit(2); }

for (const agent of agents) {
  console.log("\n== " + agent.name + " (" + agent.kind + ")");
  const result = await runAgent(agent, SCENARIOS, { log: line => console.log("  " + line) });
  const file = new URL(slug(agent.name + (agent.settings?.effort && agent.kind === "model" && agent.settings.effort !== "model default" ? "-" + agent.settings.effort : "")) + ".json", out);
  writeFileSync(file, JSON.stringify(result, null, 2) + "\n");
  const s = result.summary;
  console.log(`  correct ${s.agent_correct}/${s.scenarios} (${s.agent_accuracy}%) · wrong payments without TheWavly ${s.wrong_payments_without_wavly}, with TheWavly ${s.wrong_payments_with_wavly} · good purchases blocked ${s.good_purchases_blocked}`);
}
