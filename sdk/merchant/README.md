# @thewavly/merchant

Accept an AI agent's order only when TheWavly says its user approved it. No TheWavly account is needed: the payment token the agent carries is the permission.

An agent that checks out at your store sends two headers:

| Header | Value |
|---|---|
| `Wavly-Agent` | Its handle or id in TheWavly's public registry, such as `kitchen-bot` |
| `Wavly-Payment-Token` | The single-use payment token TheWavly gave it when the purchase was checked |

```js
import { wavlyMerchant } from "@thewavly/merchant";

const wavly = wavlyMerchant({ payees: ["shop@okhdfc", "myshop.in"], merchant: "My Shop", mode: "require" });

const order = wavly.read(request.headers);                          // null for orders from people
const answer = await wavly.check(order, { amount_paise: 54900 });   // { accept, reasons, agent, payment }
if (wavly.refuse(answer)) return refuse(answer.reasons);
if (order && answer.accept) await wavly.redeem(order, { amount_paise: 54900, payment_reference: orderId }); // just before charging
```

`check` makes one call to `POST /v1/registry/verify`. It asks whether the agent is registered and has verified its website, and whether the token is valid and unused. It then adds the store's own checks:

- the order total is no more than the user approved;
- the payee the user approved is one of yours;
- the order is in rupees;
- a test token is not used on a live store, unless you set `allowTest: true`.

If TheWavly cannot be reached, the answer does not accept.

`redeem` uses the token once, for the amount you are about to charge. Repeating it with the same `payment_reference` is safe. Using the token again for another order, for a higher amount or for another payee is refused. A redeemed order counts toward the agent's public track record.

## Modes

- `require`: refuses an agent order that is not accepted.
- `label`: never refuses. Use it for the first week to see which agent orders TheWavly would have stopped.

Orders that declare no agent are never touched in either mode.

## Express or Connect

```js
app.post("/checkout", wavly.middleware({ amount: req => cartTotalPaise(req) }), async (req, res) => {
  // req.wavly: { order, accept, reasons, agent, payment, redeem(opts) }
});
```

## Razorpay and Cashfree

`agentCheckout` checks the agent, redeems its approval and tags the gateway order with the check ID. Supply a durable checkout journal so a timeout, restart or repeated checkout can find the same order. Keep one journal per gateway account and test/live environment. The journal contains bearer credentials and belongs in your private order database. Restrict access and include it in the store's encrypted backups.

```js
import { DatabaseSync } from "node:sqlite";
import { wavlyMerchant } from "@thewavly/merchant";
import { razorpayGateway, agentCheckout, recoverCheckout } from "@thewavly/merchant/gateways";
import { sqliteCheckoutStore } from "@thewavly/merchant/checkout-store";

const journal = sqliteCheckoutStore(new DatabaseSync(process.env.MERCHANT_CHECKOUT_DB));
const wavly = wavlyMerchant({ payees: ["shop@okhdfc"] });
const gateway = razorpayGateway({ keyId, keySecret, webhookSecret });
const options = { wavly, gateway, journal };

try {
  const r = await agentCheckout({ ...options, headers: req.headers, amount_paise: 56100, order_id: cart.orderId });
  if (r.refused) return res.status(403).json({ reasons: r.reasons });
  if (r.state === "paid") return res.json({ order_id: r.order_id, status: "paid" });
  return res.json({ gateway_order: r.gateway_order });
} catch (error) {
  if (error.code === "checkout_pending") return res.status(202).json({ order_id: cart.orderId, status: "pending" });
  throw error;
}
```

A recovery worker can call `recoverCheckout({ ...options, order_id })` repeatedly. It reads the existing order at the gateway. For pending records, page through `journal.pending(gateway.name, { after, limit })` and resume from the last order ID in each page. Schedule repeat sweeps from the beginning, with backoff. Use the same durable database on every request and worker. For an app running on multiple hosts, implement the same `get(gateway, orderId)`, `insert(record)` and `transition(expectedState, record)` interface on the store's shared database. Insert must claim a unique `(gateway, order_id)` atomically, and transition must atomically match the prior state. Each write returns whether it won.

| Recovery state | Merchant action |
| --- | --- |
| `retry_original_request` | Replay the stored customer order through `agentCheckout` with its original headers, total, customer details and notes. It resumes the same redemption and only one worker may submit to the gateway. |
| `closure_review` | All visible attempts on an expired order report final failure. Obtain the provider’s final unpaid closure reference before releasing. |
| `pending` | Keep the approval held and repeat the lookup. A missing order may still be in flight. |
| `paid` | Return the order confirmation. Previously observed success keeps the approval held even when a later provider snapshot is stale. |
| `created` | Use the returned gateway order and original receipt. Check its current payment status before offering payment to the buyer. |
| `released` or `redemption_rejected` | Close this checkout. A new purchase needs its own approval and merchant order ID. |

For a Razorpay `payment.failed` or Cashfree `PAYMENT_FAILED_WEBHOOK` event, verify the signature, use `gateway.failedOrderId(event)` to locate the attempt, then call `recoverCheckout` for its merchant order. `journal.orderIdForReference(gateway.name, providerOrderId)` maps a known gateway reference back to that order. Keep unmatched events for the next reconciliation sweep. A failed attempt can be followed by a successful payment on the same order.

An explicit authentication refusal before creation releases the approval. A timeout, duplicate response, server error or malformed success leaves it held. An expired Cashfree order can still receive a late success. The SDK fetches its payment attempts. A pending attempt, missing evidence or a conflicting payment retains the hold. If all visible attempts have completed as failed, the SDK requests a final closure reference from the merchant’s provider reconciliation. An open or attempted Razorpay order remains held. If creation cannot be found, suspend further submission and obtain definitive provider confirmation that it was never accepted or can no longer be paid. The merchant back office can then call `confirmUnpaidCheckout({ ...options, order_id, evidence_reference })` with the provider's closure reference. A live payable or paid gateway result prevents this action. Keep this operation under an authorised merchant role. An earlier attempt failure or a single empty lookup is insufficient.

Older integrations without a journal still receive `CheckoutPendingError` for an uncertain outcome. Their server can persist its private `error.recovery` record and pass that to `recoverCheckout` or replay `agentCheckout` with it. A journal is needed to survive a process loss before the response. Orders from people go directly to the gateway.

## Tell agents you accept TheWavly

Serve `wavly.discovery()` at `/.well-known/wavly-merchant.json`. Agents read it to learn which headers to send and which payees you use.

The WooCommerce plugin in `sdk/woocommerce` does all of this for a WordPress store.
