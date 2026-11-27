# TheWavly JavaScript SDK

Check an AI agent's purchase against what the user approved, before it pays. No dependencies. Node 20 or newer, Deno, Bun. Use secret keys only on servers.

## Install from the SDK bundle

Download the Apache-2.0 SDK bundle into your application directory and extract it:

```bash
curl -fL https://thewavly.com/sdk/thewavly-open.tar.gz -o thewavly-open.tar.gz
tar -xzf thewavly-open.tar.gz
```

Install the JavaScript client locally; no registry package is required:

```bash
npm install ./thewavly-open/sdk/js
```


```js
import { Wavly } from "@thewavly/sdk";

const wavly = new Wavly(process.env.WAVLY_API_KEY);

// When the user approves
const mandate = await wavly.mandates.create({
  instruction: "Buy Amma a saree for up to ₹2,500, at most ₹10,000 this month",
  approved_by: "user_7f3",
  rules: { items: ["Saree"], max_amount_paise: 250000, budget_paise: 1000000, payees: ["sarees@okhdfc"] },
});

// Just before paying
const check = await wavly.checks.create(
  { mandate: mandate.id, purchase: { item: "Saree", amount_paise: 249900, payee: "sarees@okhdfc" } },
  { idempotencyKey: "order-1042" },
);

if (check.decision === "proceed") {
  // pay, then
  await wavly.checks.reportOutcome(check.id, { status: "paid", payment_reference: "4416 2209" });
} else if (check.decision === "ask") {
  // send check.approval.url to the user, then wait for the webhook or:
  const answered = await wavly.checks.waitForApproval(check.id);
} // on "stop", do not pay
```

Every write carries an Idempotency-Key, which the SDK generates unless you pass one. So the SDK can retry 429, 5xx and network errors without applying a write twice.

## Verifying

```js
// Webhooks: pass the raw request body and the Wavly-Signature header
const event = await Wavly.verifyWebhook(rawBody, req.headers["wavly-signature"], process.env.WAVLY_WEBHOOK_SECRET);

// Any receipt, mandate or evidence pack, offline, against your organisation's published keys
const jwks = await (await fetch("https://thewavly.com/v1/orgs/org_…/jwks")).json();
const receipt = await Wavly.verifyToken(check.receipt, jwks);
```

## Payment tokens

When a check answers proceed, it carries `payment_token`: single use, for at most that amount, to that payee, until the hold expires. After the user approves an ask, get one with `wavly.checks.paymentToken(check.id)`. Hand it to the payment provider, which redeems it without a TheWavly key just before charging:

```js
// At the payment provider
const status = await Wavly.inspectPaymentToken(token);           // { status: "valid", max_amount_paise, payee, expires_at }
const paid = await Wavly.redeemPaymentToken(token, { amount_paise: 249900, payee: "sarees@okhdfc", payment_reference: "UPI RRN" });
```

Redeeming twice with the same reference returns the same result. TheWavly refuses another reference, a higher amount, another payee, or an expired or replaced token. The charged amount counts against the user's budget.

## Disputes, agents and personal data

```js
// A customer complains: open a dispute on the check. TheWavly suggests a finding from the records.
const d = await wavly.disputes.create({ check: check.id, reason: "limit_breached", description: "Charged more than I allowed", charged_amount_paise: 260000 });
await wavly.disputes.addEvidence(d.id, { party: "merchant", kind: "quote", text: "Quote showed ₹2,600 all-in" });
// An admin or owner signs in to the dispute desk to record the finding and any remedy.
// A different signed-in reviewer decides an appeal. Read their signed finding through the SDK.
const reviewed = await wavly.disputes.retrieve(d.id);
if (reviewed.finding) console.log(reviewed.finding.finding);

const score = await wavly.agents.score("shopbot-v2");  // { score, confidence, track_record, explanation }
await wavly.endUsers.erase({ approved_by: "user_7f3" });  // revokes and removes the person's personal data
```

## A registered agent, at checkout

Register your agent in TheWavly's [public registry](https://thewavly.com/agents) and add its public key. Then pass its identity to the client. Every check names the agent and is signed with its key, so the check counts toward its public record.

```js
const wavly = new Wavly(process.env.WAVLY_API_KEY, { agent: { id: "acme-travelbot", privateKey: jwk } });
await wavly.registry.register({ handle: "acme-travelbot", name: "Acme Travel Assistant", website: "acme.in" });
const check = await wavly.checks.create({ mandate, purchase });       // signed

if (check.decision === "proceed" && await Wavly.merchantInfo(storeUrl)) {
  await fetch(storeUrl + "/checkout", { method: "POST", headers: { ...Wavly.checkoutHeaders(check, "acme-travelbot"), "content-type": "application/json" }, body });
}
```

A store that takes TheWavly publishes `/.well-known/wavly-merchant.json`. Before it charges, it verifies the agent and the token; a store can do this with `Wavly.verifyOrder({ agent, payment_token })` or with `@thewavly/merchant`. See `examples/agent-checkout` for both sides.

## Signed checks and reconciliation

```js
// Once: register the agent's public key. Keep the private key with the agent.
await wavly.agents.addKey("shopbot-v2", { jwk: publicJwk });
// Each check: the agent signs the exact purchase it is about to pay for
const purchase = { item: "Saree", amount_paise: 249900, payee: "sarees@okhdfc" };
const agent_signature = await Wavly.signCheck({ privateKey: privateJwk, mandate: mandate.id, purchase });
const check = await wavly.checks.create({ mandate: mandate.id, purchase, agent_signature });  // check.agent_verification.status === "verified"

// From your payment provider's webhook: tie each real debit to the check that allowed it
const p = await wavly.payments.record({ payment_reference: "UPI RRN", amount_paise: 249900, payee: "sarees@okhdfc", source: "razorpay" });
// p.status: "matched", "over_amount", or "unchecked" when money moved without a check
```

Errors throw `WavlyError` with `status`, `code` and `field`. The full reference is at `/developers#v1`.
