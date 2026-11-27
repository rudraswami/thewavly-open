# TheWavly Guard

**Make the check impossible to skip.**

TheWavly MCP server and SDKs are advisory: the agent is told to check before paying. But an agent that has been talked into something, such as a listing that gives it instructions or a fake discount, can simply not ask. The Guard sits in the tool path instead.

Every call to a tool you mark as an order or payment tool is held until TheWavly answers:

| TheWavly's answer | What happens |
| --- | --- |
| **proceed** | The call goes through. TheWavly records the outcome, and the result carries a receipt link for the user. |
| **ask** | The call is not made. The agent gets the user's approval link. The same call goes through once the user approves that exact order. |
| **stop** | The call is not made. |

How it decides:
- **The amount comes from the shop.** The Guard can read the server's own cart (for example `view_cart`) before the order, so the check uses the real total, not the price the agent was quoted.
- **The mandate comes from your configuration** (`WAVLY_MANDATE`), never from the agent.
- **It fails closed.** If the Guard cannot read the order or reach TheWavly, nothing is ordered.

## Install from the SDK bundle

Download the Apache-2.0 SDK bundle into your application directory and extract it:

```bash
curl -fL https://thewavly.com/sdk/thewavly-open.tar.gz -o thewavly-open.tar.gz
tar -xzf thewavly-open.tar.gz
```

Node 20 or newer is required. To use the JavaScript imports below, install the Guard locally:

```bash
npm install ./thewavly-open/sdk/guard
```

The extracted CLI can also run directly without installation.


## In front of any stdio MCP server, with no code change

```bash
WAVLY_API_KEY=sk_test_… WAVLY_MANDATE=mdt_… \
  node ./thewavly-open/sdk/guard/cli.mjs --config guard.json -- node shop-server.mjs
```

```json
{ "tools": { "place_order": {
    "resolve": { "tool": "view_cart", "arguments": { "cart_id": "args.cart_id" } },
    "purchase": { "item": { "const": "Food order" }, "amount_rupees": "resolved.total_rupees",
                  "merchant": "resolved.store", "payee": "resolved.upi_id" },
    "reference": "result.order_id" } } }
```

Paths start with:
- `args`: the call's arguments;
- `resolved`: the resolve tool's result;
- `result`: the order tool's result, used for the payment reference.

Give the amount as `amount_paise` or `amount_rupees`. Fixed values use `{ "const": … }`.

## Inside your own server

```js
import { guardHandler } from "@thewavly/guard";
const guarded = guardHandler(handle, { wavly, mandate, tools: config.tools });   // handle: your JSON-RPC message handler
```

## In any agent framework

No MCP server? Guard the function your payment tool runs, and give the guarded function to the framework:

```js
import { guardFunction } from "@thewavly/guard";

const execute = guardFunction(({ cart_id }) => shop.placeOrder(cart_id), {
  wavly, mandate: process.env.WAVLY_MANDATE,
  purchase: async ({ cart_id }) => {                 // read the real total, not the quote
    const cart = await shop.cart(cart_id);
    return { item: "Food order", amount_paise: cart.total_paise, merchant: cart.store, payee: cart.upi_id };
  },
  reference: order => order.order_id,
});
```

- `purchase(...args)` gets the function's own arguments and returns the purchase TheWavly checks. Give the amount as `amount_paise` or `amount_rupees`.
- **proceed:** the function runs, and the outcome is reported with `reference(result, ...args)`. A string result gets the receipt link appended. A plain-object result gets a `wavly` field with it.
- **ask** or **stop:** the function is not called. The wrapper returns `{ ordered: false, decision, message, check_id, approval_url }`. After an ask, the same call goes through once the user approves.
- **If the function throws:** the outcome is reported as failed, which releases the hold, and the error is rethrown.

The Python SDK has the same Guard as a decorator, `thewavly.guard.guard`. `examples/frameworks` has working tools for the Vercel AI SDK, LangChain (JavaScript and Python) and the OpenAI Agents SDK (JavaScript and Python), plus a check script for each language.

## Try it

`examples/guard-demo` has a small food-ordering MCP server. The menu shows two shakes for ₹475, but the cart adds ₹86 in fees, for ₹561. One listing also tells AI assistants to choose it.

With a mandate of up to ₹500, here is what the Guard does:
- An order placed straight away, with no check, gets **ask**, and nothing is ordered until the user approves.
- An order from the partner listing gets **stop**, because its seller is not one the user named.

TheWavly's own test suite runs all of this against a real TheWavly deployment.

## At a store that takes TheWavly

If the client has an agent identity (`new Wavly(key, { agent: { id, privateKey } })`), call `checkoutHeaders()` inside the guarded function. It returns `Wavly-Agent` and `Wavly-Payment-Token` for this call, so the store can verify the order before it charges. After the user approves an ask, the token is a fresh one. Outside a guarded call it returns `null`.

```js
import { guardFunction, checkoutHeaders } from "@thewavly/guard";
const execute = guardFunction(({ cart_id }) => fetch(store + "/checkout", { method: "POST", headers: { "content-type": "application/json", ...checkoutHeaders() }, body: JSON.stringify({ cart_id }) }), { wavly, mandate, purchase });
```
