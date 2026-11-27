# TheWavly Agent Checkout for WooCommerce

A WordPress plugin that accepts an AI agent's order only when TheWavly verifies two things: who the agent is, and that its user approved this payment. Each approval pays once, for no more than the user approved. Orders from people are never touched.

## Install

1. Download [thewavly-agent-checkout.zip](https://thewavly.com/sdk/thewavly-agent-checkout.zip).
2. In WordPress, go to **Plugins → Add New → Upload Plugin**, upload the zip and activate it.
3. Open **WooCommerce → Settings → TheWavly** and fill in:
   - **Agent orders:**
     - start with *Record only*, which records verification results for agent orders;
     - switch to *Require TheWavly* once you have seen the notes.
   - **Your payee identifiers:** the UPI IDs and domain you want agents to pay. An approval for anyone else is refused.
   - **Test tokens:** keep this off on a live store.

## What happens at checkout

It works with the classic checkout, the block checkout and the Store API (`/wp-json/wc/store/v1/checkout`). Agents mostly use the Store API.

1. The agent sends `Wavly-Agent` and `Wavly-Payment-Token` headers with the checkout request.
2. Before payment is taken, the plugin asks TheWavly whether the agent is registered and verified, and whether the token is valid and unused. It then checks:
   - the order total is no more than the user approved;
   - the payee is one of yours;
   - the order is in rupees.
3. If the order is accepted, the plugin redeems the token for the order total. It adds an order note naming the agent and the TheWavly check, with a link that verifies TheWavly's signed receipt. Keep it as evidence of the approval if the payment is disputed.
4. If it is not accepted:
   - in *Require* mode the checkout fails with the reasons;
   - in *Record only* mode the reasons go in an order note.

The plugin also serves `/.well-known/wavly-merchant.json`, so agents can tell that the store accepts TheWavly payment tokens.

The plugin reserves a private release key and binds it to the order, token, currency and amount before the redemption request. Only the key's hash goes to the redemption endpoint. If the reply is lost, checkout asks the buyer to retry the same order and the Store API returns `503 thewavly_redemption_pending`. A same-order retry can reconstruct the receipt and use the original capability. A retry with changed details is rejected. Action Scheduler can recover a receipt after a server restart when TheWavly confirms that redemption already happened. It never initiates a gateway charge.

The reservation is a private, non-autoloaded WordPress option for the lifetime of the order. Restrict access to the database and backups. The private reservation supplies the release key for fulfilment and confirmed unpaid closure. New order metadata and notes contain no release key or payment token. It is compatible with HPOS (custom order tables) and the cart and checkout blocks.

A failed payment attempt or locally cancelled order keeps its approval. The gateway can still accept a payment. When the store’s gateway connector verifies the final order is closed unpaid, have it call this private WordPress action with the gateway closure reference:

```php
do_action( 'thewavly_gateway_order_closed_unpaid', $order_id, $provider_closure_reference );
```

The plugin records the reference, closes the WooCommerce payment path and returns the approval. It retries temporary release failures through WooCommerce Action Scheduler. A paid order retains its approval. The next purchase after a release needs a new approval.

## Tests

`tests/run.php` loads the plugin with stand-ins for WordPress and WooCommerce and runs the following against a real TheWavly:

- classic and Store API checkouts, including a lost response after redemption, recovery on the same order and subsequent release;
- a reused token and a forged token;
- an order total above the approval;
- *Record only* and *Off* modes;
- discovery.

It is not a substitute for trying the plugin in a staging store.
