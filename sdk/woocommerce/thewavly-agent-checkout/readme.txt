=== TheWavly Agent Checkout ===
Contributors: thewavly
Tags: ai agents, agentic commerce, checkout, upi, fraud
Requires at least: 6.3
Tested up to: 6.8
Requires PHP: 7.4
Stable tag: 0.2.0
License: Apache-2.0
License URI: https://www.apache.org/licenses/LICENSE-2.0

Accept orders from AI agents only when TheWavly verifies the agent and the user's approval. Each approval pays once.

== Description ==

AI agents are starting to buy on behalf of people. This plugin lets your store accept their orders safely.

An agent that checks out sends two headers: Wavly-Agent, its handle in TheWavly's public registry, and Wavly-Payment-Token, the single-use token TheWavly gave it when it checked the purchase against what its user approved.

Before payment is taken, the plugin asks TheWavly two questions:

* Is the agent registered and verified?
* Is the approval valid and still unused?

It then checks that the order total is no more than the user approved and that the payee is yours. If everything passes, it uses the approval once and notes the agent and the TheWavly check on the order.

Each accepted order keeps TheWavly's signed receipt and a link that verifies it. It shows the person's approval of that purchase and amount, as recorded by the agent's operator, and you can keep it as evidence if the payment is disputed. Orders from people are never touched. Start in Record only mode, which logs a failed verification, and switch to Require once you have seen the notes.

This plugin calls TheWavly (https://thewavly.com) only for orders that carry the Wavly-Agent or Wavly-Payment-Token header. It sends the agent's handle, the payment token, the order total, the order number and your payee identifier. Terms: https://thewavly.com/terms. Privacy: https://thewavly.com/privacy.

== Installation ==

1. Upload the zip from Plugins → Add New → Upload Plugin, then activate it.
2. Open WooCommerce → Settings → TheWavly.
3. Add your UPI IDs or domain under "Your payee identifiers".
4. Leave Agent orders on Record only for the first week.

A failed attempt can still be paid on another try. A gateway connector should invoke the private `thewavly_gateway_order_closed_unpaid` action with the WooCommerce order ID and provider closure reference after verifying the gateway has closed the order unpaid.

The plugin stores a private recovery capability before sending a redemption request. If the confirmation is interrupted, retry the same order. Both checkout modes pause a redemption already in progress until its outcome is known. The background worker can recover a confirmed receipt and cannot charge an order.

== Changelog ==

= 0.2.0 =
* Optional "Your TheWavly key": redemptions are recorded as made by an independent store, and each paid order's debit is confirmed to TheWavly. This lets the agent companies you sell to show a publicly verifiable assurance level.
* If TheWavly refuses the key (revoked, rotated, restricted), the order still goes ahead without it, with a note on the order.

= 0.1.2 =
* Recover a lost redemption confirmation on the same order in classic, block, and pay-for-order checkout.

= 0.1.1 =
* Preserve the approval while the gateway can retry an order. Release only with a confirmed unpaid closure.

= 0.1.0 =
* First release: classic checkout, block checkout and the Store API; Record only and Require modes; discovery at /.well-known/wavly-merchant.json.
