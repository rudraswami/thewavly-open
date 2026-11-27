# TheWavly: open components

**Check an AI agent's purchase against what the user approved, before the money moves.**

When an AI agent pays for something, three questions matter later:
- What did the user actually approve?
- What did the agent buy?
- Did it match?

TheWavly answers them before the payment. The answer is one of three:
- **proceed**;
- **ask the user first**;
- **stop**.

It then gives everyone involved a signed record they can check without trusting TheWavly.

This repository holds the parts anyone can read, run and build on. They are licensed under Apache-2.0.

| Folder | What it is |
| --- | --- |
| [`spec/`](spec/wavly-formats-v1.md) | TheWavly formats: mandates, checks, signed receipts and evidence packs. |
| [`sdk/js`](sdk/js) | JavaScript client with no dependencies. Works on Node 20+, Deno and Bun. |
| [`sdk/go`](sdk/go) | Go client, standard library only. Go 1.21+. |
| [`sdk/java`](sdk/java) | Java client, no dependencies. Java 11+. |
| [`sdk/python`](sdk/python) | Python client with no dependencies. Python 3.9+. |
| [`sdk/mcp`](sdk/mcp) | MCP server, so any agent that speaks the Model Context Protocol checks before it pays. |
| [`sdk/guard`](sdk/guard) | TheWavly Guard: holds an MCP server's order and payment tools until TheWavly answers, so an agent cannot skip the check. |
| [`sdk/verify`](sdk/verify) | Offline verifier for evidence packs. Uses Node's built-in crypto, with no call to TheWavly. |
| [`bench/`](bench) | Purchase Bench: can an AI agent shop the way you asked? |

The hosted service (the API, dashboard, approvals and review desk) runs at [thewavly.com](https://thewavly.com). It is free in test mode, plus 1,000 live checks a month. See [pricing](https://thewavly.com/pricing).

## Download and install

The supported installation route is the SDK bundle. Download it into your application directory:

```bash
curl -fL https://thewavly.com/sdk/thewavly-open.tar.gz -o thewavly-open.tar.gz
tar -xzf thewavly-open.tar.gz
```

This README is inside the extracted `thewavly-open` directory. Run these commands from your application directory to install the clients you need:

```bash
npm install ./thewavly-open/sdk/js ./thewavly-open/sdk/guard
python3 -m pip install ./thewavly-open/sdk/python
```

For offline Python verification, install `'./thewavly-open/sdk/python[verify]'` instead. The MCP server and Guard CLI also run directly with Node 20+, without installation. Java and Go local-build instructions are in their SDK READMEs. These commands use the downloaded source rather than unpublished registry packages.

## Give your agent a check

Add this to your MCP client (Claude Desktop, Claude Code, Cursor and others), using the absolute path where you extracted the bundle:

```json
{
  "mcpServers": {
    "wavly": {
      "command": "node",
      "args": ["/absolute/path/to/thewavly-open/sdk/mcp/server.mjs"],
      "env": { "WAVLY_API_KEY": "sk_test_…" }
    }
  }
}
```

Get a free test key at [thewavly.com/app](https://thewavly.com/app). The agent then calls `wavly_check_purchase` right before paying and follows the answer.

## Or from code

```js
import { Wavly } from "@thewavly/sdk";
const wavly = new Wavly(process.env.WAVLY_API_KEY);

const mandate = await wavly.mandates.create({
  instruction: "Book a refundable hotel in Goa under ₹6,000 a night",
  approved_by: "user_7f3",
  rules: { items: ["Hotel"], max_amount_paise: 600000, conditions: [{ term: "refundable", equals: true, label: "a refundable room" }] },
});
const check = await wavly.checks.create({ mandate: mandate.id, purchase: { item: "Hotel", amount_paise: 540000, terms: { refundable: false } } });
check.decision; // "stop": the user asked for refundable
```

```python
from thewavly import Wavly
wavly = Wavly(os.environ["WAVLY_API_KEY"])
check = wavly.checks.create({"mandate": mandate_id, "purchase": {"item": "Hotel", "amount_paise": 540000}})
```

## Verify a record without trusting us

From your application directory:

```bash
node thewavly-open/sdk/verify/wavly-verify.mjs wavly-evidence-chk_123.json
```

The verifier checks each of these:
- every mandate version's signature and hash chain;
- the receipt, and the purchase it commits to;
- each dispute finding;
- the pack signature.

The exit code is 0 only when everything verifies.

## Purchase Bench

The bench has 37 everyday Indian purchases: a refundable hotel, a 3AC berth, the 128 GB variant, a Jain thali, the exact electricity bill. In each one, the cheapest or first-listed offer breaks something the user said. In four of them, no offer qualifies, and the right move is to ask.

```bash
cd thewavly-open/bench && npm install
WAVLY_API_KEY=sk_test_… node run.mjs --scripted          # scripted baselines, against the hosted API in test mode
WAVLY_API_KEY=sk_test_… ANTHROPIC_API_KEY=… node run.mjs --model claude-opus-5-5
```

Scripted baselines and what they show:

| Baseline | Correct | Wrong payments without TheWavly | With TheWavly |
| --- | --- | --- | --- |
| Cheapest offer | 3/37 | 34 | 0 |
| First listed offer | 1/37 | 36 | 0 |
| Cheapest within the price limit | 3/37 | 34 | 0 |

The baselines are labelled as scripted wherever they appear; they are not AI models. Play the bench yourself at [thewavly.com/bench](https://thewavly.com/bench). See also the public [incident tracker](https://thewavly.com/incidents).

## Contributing

New bench scenarios, incident reports with a public source, and SDK fixes are all welcome. See [CONTRIBUTING.md](CONTRIBUTING.md). To report a security problem, follow [SECURITY.md](SECURITY.md), not a public issue.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
