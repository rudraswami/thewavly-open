# An agent buys from a store that takes TheWavly

This example shows both sides of an agent's purchase.

- **`agent.mjs`** is the agent. It:
  1. reads the store's catalogue;
  2. checks the purchase against what the user approved, with a check signed by its registered key;
  3. on *proceed*, places the order with two headers, `Wavly-Agent` and `Wavly-Payment-Token`.
- **`store.mjs`** is the store. It publishes `/.well-known/wavly-merchant.json`. Before charging, it asks TheWavly whether the agent is verified and whether its user approved this payment. It then redeems the token once, for the order total. It refuses anything TheWavly does not verify.

```js
import { Wavly } from "../../sdk/js/index.mjs";
import { buy } from "./agent.mjs";

const wavly = new Wavly(process.env.WAVLY_API_KEY, { agent: { id: "your-agent-handle", privateKey: JSON.parse(process.env.WAVLY_AGENT_KEY) } });
const result = await buy({ wavly, mandate: "mdt_…", store: "http://localhost:4000", product: "dosa-kit" });
```

## The agent must be verified first

1. Register the agent at https://thewavly.com/app, under Agents → Register in the public registry.
2. Prove its website by publishing `/.well-known/wavly-agents.json`.
3. Add its public key.

Until the agent is verified, a store in `require` mode refuses its orders. Run the store with `mode: "label"` to watch what it would do without refusing anything.

TheWavly's own test suite runs this example end to end on every change.
