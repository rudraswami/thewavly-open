# TheWavly Guard in agent frameworks

The agent's model decides when to call a tool. A TheWavly check the model is *told* to make can be skipped by a model that has been talked into something. So guard the function the payment tool runs, not the prompt. The guarded function asks TheWavly first, every time:

| TheWavly's answer | What the tool does |
| --- | --- |
| **proceed** | Runs. The outcome is reported to TheWavly, and the result carries the receipt link for the user. |
| **ask** | Does not run. The model gets the user's approval link. The same call goes through once the user approves. |
| **stop** | Does not run. |

Two rules make this hold:
- **The purchase is read from your systems**, here the shop's own cart (₹561), never from what the model says it saw (₹475).
- **The mandate comes from your code**, never from the tool's arguments.

Anything the Guard can't read or check fails closed: nothing is ordered.

## JavaScript: `guardFunction` from `@thewavly/guard`

```js
import { guardFunction } from "@thewavly/guard";

const execute = guardFunction(({ cart_id }) => shop.placeOrder(cart_id), {
  wavly,                                        // new Wavly(process.env.WAVLY_API_KEY)
  mandate: process.env.WAVLY_MANDATE,           // the user's approval, from your side
  purchase: async ({ cart_id }) => {            // what TheWavly checks
    const cart = await shop.cart(cart_id);
    return { item: "Food order", amount_paise: cart.total_paise, merchant: cart.store, payee: cart.upi_id };
  },
  reference: order => order.order_id,           // recorded with the outcome
});
```

Give `execute` to the framework's tool:

| Framework | File |
| --- | --- |
| Vercel AI SDK (`ai`) | [`vercel-ai.mjs`](vercel-ai.mjs) |
| LangChain.js and LangGraph (`@langchain/core`) | [`langchain.mjs`](langchain.mjs) |
| OpenAI Agents SDK (`@openai/agents`) | [`openai-agents.mjs`](openai-agents.mjs) |

## Python: `thewavly.guard.guard`

```python
from thewavly.guard import guard

@tool                       # or @function_tool, or no decorator for your own loop
@guard(wavly, mandate=os.environ["WAVLY_MANDATE"], purchase=shop.cart_purchase,
       reference=lambda order, *a, **k: order["order_id"])
def place_order(cart_id: str) -> dict:
    """Place the order for a cart and pay for it."""
    return shop.place_order(cart_id)
```

Put `@guard` under the framework's decorator. It keeps the function's signature, type hints and docstring, so the framework builds the same tool schema. It works on sync and async functions.

| Framework | File |
| --- | --- |
| LangChain and LangGraph (`langchain-core`) | [`langchain_tool.py`](langchain_tool.py) |
| OpenAI Agents SDK (`openai-agents`) | [`openai_agents_tool.py`](openai_agents_tool.py) |

## Check it yourself

`check.mjs` and `check.py` call each guarded tool the way its framework does, without a model. Each one:
1. tries the partner listing, which TheWavly stops;
2. tries the ₹561 cart, which TheWavly holds for the user;
3. approves on the user's behalf;
4. makes the same call again, which places the order.

They use a test key and refuse live ones.

```bash
npm install && WAVLY_API_KEY=sk_test_… node check.mjs
```

```bash
python -m venv .venv && .venv/bin/pip install -r requirements.txt && WAVLY_API_KEY=sk_test_… .venv/bin/python check.py
```

Last run on 23 November 2026, with the versions pinned in `package.json` and `requirements.txt`. All five passed.
