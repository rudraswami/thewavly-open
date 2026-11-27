# TheWavly Purchase Bench

**Can an AI agent shop the way you asked?** 37 everyday Indian purchases are covered: a refundable hotel in Goa, a 3AC berth, the 128 GB phone variant, a Jain thali, the exact BESCOM bill. In each one, the cheapest or first option breaks something the user said out loud. In four of them, no offer qualifies, and the right move is to ask.

The agent sees what a shopper sees: the user's words and four offers with their terms. It acts once: buy, ask the user, or decline. The bench then asks a real TheWavly what it would have answered before the payment. By default, TheWavly runs in-process from this repository. With `WAVLY_API_KEY` set to a test key, it asks the hosted API instead; test mode is free.

## What it measures

| Measure | Meaning |
|---|---|
| Agent accuracy | The agent bought an offer that meets everything the user asked for, or asked or declined when none did. |
| Wrong payments without TheWavly | Purchases the agent would have paid for that break the user's instruction. |
| Wrong payments with TheWavly | The same purchases, where TheWavly answered proceed anyway. This is the number that matters. |
| Good purchases blocked | Correct purchases TheWavly stopped. TheWavly's false alarms. |

**What it does not measure:** unstated preferences. Every condition here is something the user said. TheWavly catches a broken condition only when that condition is recorded in the mandate, and each scenario's mandate is written from the user's own words. TheWavly's own test suite checks that it answers proceed for exactly the offers marked acceptable, across all 148 offers.

## Run it

```bash
cd bench && npm install
export WAVLY_API_KEY=sk_test_…                # free test key from thewavly.com/app
node run.mjs --scripted                       # three scripted baselines
ANTHROPIC_API_KEY=… node run.mjs --model claude-opus-5-5
node run.mjs --model claude-sonnet-5-5 --effort low
```

Results go to `results/<agent>.json`, one row per scenario, with the agent's action, its reason, TheWavly's answer and token usage.

**About the model runs:**
- They use Claude through the official SDK, at the model's default effort unless `--effort` is given.
- There is no refusal fallback, so a refusal counts against the model that refused, not a substitute.
- The scripted baselines (cheapest offer, first listed offer, cheapest within the price limit) are labelled as scripted wherever they appear. They are not AI models.

## Add a scenario

Add it to `scenarios.mjs` with:
- the user's words;
- the mandate those words become;
- four offers;
- the acceptable offer IDs.

Run the scripted baselines. If TheWavly disagrees with your acceptable list, the mandate usually doesn't say what the user said.
