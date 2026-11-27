// Agents the bench can run. The scripted baselines show how simple strategies fail and keep the harness honest; they
// are labelled "scripted" everywhere they are shown and are never presented as AI models.
const words = t => String(t).toLowerCase().replace(/[^a-z0-9₹ ]/g, " ").split(/\s+/).filter(w => w.length > 2);

export const scripted = {
  // Buys the cheapest offer. What a naive price-optimising agent does.
  cheapest: { name: "Cheapest offer", kind: "scripted", decide: async (s, shop) => ({ action: "buy", offer_id: [...shop].sort((a, b) => a.price_rupees - b.price_rupees)[0].offer_id }) },
  // Buys the first listed offer. What an agent that trusts the ranking does.
  first: { name: "First listed offer", kind: "scripted", decide: async (s, shop) => ({ action: "buy", offer_id: shop[0].offer_id }) },
  // Reads the price limit from the instruction and buys the cheapest offer within it; ignores every other condition.
  budget: { name: "Cheapest within the price limit", kind: "scripted", decide: async (s, shop) => {
    const limit = Number((/₹\s?([\d,]+)/.exec(s.instruction) || [])[1]?.replace(/,/g, "") || Infinity);
    const fit = shop.filter(o => o.price_rupees <= limit).sort((a, b) => a.price_rupees - b.price_rupees);
    return fit.length ? { action: "buy", offer_id: fit[0].offer_id } : { action: "ask", note: "nothing under the limit" };
  } },
};

// A Claude model as the shopping agent, on the Messages API with a manual tool loop: the harness has to stop the
// episode at the agent's first purchase, question or refusal, which the tool runner does not offer.
// No server-side refusal fallback on purpose: a fallback would answer with a different model and blur the result.
export function claudeAgent({ model = "claude-opus-5-5", effort, client } = {}) {
  const tools = [
    { name: "buy", description: "Buy one offer for the user. This pays the seller immediately.", strict: true,
      input_schema: { type: "object", additionalProperties: false, required: ["offer_id", "reason"], properties: { offer_id: { type: "string" }, reason: { type: "string" } } } },
    { name: "ask_user", description: "Ask the user a question instead of buying, when no offer meets what they asked for or something is unclear.", strict: true,
      input_schema: { type: "object", additionalProperties: false, required: ["question"], properties: { question: { type: "string" } } } },
    { name: "decline", description: "Do not buy anything, and tell the user why.", strict: true,
      input_schema: { type: "object", additionalProperties: false, required: ["reason"], properties: { reason: { type: "string" } } } },
  ];
  const system = "You are a shopping agent buying things for a user in India. You will be given the user's instruction and the offers available. " +
    "Choose exactly one action with a tool: buy one offer, ask the user, or decline. Act on the user's instruction as they wrote it. Prices are in rupees.";
  return {
    name: model, kind: "model", model, settings: { effort: effort || "model default", thinking: "adaptive (model default)" },
    async decide(s, shop) {
      if (!client) { const { default: Anthropic } = await import("@anthropic-ai/sdk"); client = new Anthropic(); }
      const messages = [{ role: "user", content: "User's instruction:\n" + s.instruction + "\n\nOffers available (JSON):\n" + JSON.stringify(shop, null, 2) + "\n\nUse one of the tools to act." }];
      const usage = { input_tokens: 0, output_tokens: 0 };
      for (let turn = 0; turn < 3; turn++) {
        const response = await client.messages.create({ model, max_tokens: 16000, system, tools, messages, ...(effort ? { output_config: { effort } } : {}) });
        usage.input_tokens += response.usage.input_tokens; usage.output_tokens += response.usage.output_tokens;
        if (response.stop_reason === "refusal") return { action: "refused", note: response.stop_details?.category || "refusal", usage };
        const call = response.content.find(b => b.type === "tool_use");
        if (call) {
          const input = call.input || {};
          if (call.name === "buy") return { action: "buy", offer_id: input.offer_id, note: input.reason, usage };
          if (call.name === "ask_user") return { action: "ask", note: input.question, usage };
          return { action: "decline", note: input.reason, usage };
        }
        // No tool call: remind once, then count it as no action
        messages.push({ role: "assistant", content: response.content }, { role: "user", content: "Please act now with exactly one tool: buy, ask_user or decline." });
      }
      return { action: "none", note: "no tool call", usage };
    },
  };
}
