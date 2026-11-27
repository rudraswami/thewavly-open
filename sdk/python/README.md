# TheWavly Python SDK

Check an AI agent's purchase against what the user approved, before it pays. Python 3.9 or newer, no dependencies for the API. Verifying signed tokens offline needs the optional `cryptography` extra. Use secret keys only on servers.

## Install from the SDK bundle

Download the Apache-2.0 SDK bundle into your application directory and extract it:

```bash
curl -fL https://thewavly.com/sdk/thewavly-open.tar.gz -o thewavly-open.tar.gz
tar -xzf thewavly-open.tar.gz
```

Install the API client, or include the optional offline verification dependency:

```bash
python3 -m pip install ./thewavly-open/sdk/python
# Optional: verify signed records offline
python3 -m pip install './thewavly-open/sdk/python[verify]'
```


```python
import os
from thewavly import Wavly, WavlyError

wavly = Wavly(os.environ["WAVLY_API_KEY"])

# When the user approves
mandate = wavly.mandates.create({
    "instruction": "Buy Amma a saree for up to ₹2,500, at most ₹10,000 this month",
    "approved_by": "user_7f3",
    "agent": "shopbot-v2",
    "rules": {"items": ["Saree"], "max_amount_paise": 250000, "budget_paise": 1000000, "payees": ["sarees@okhdfc"]},
})

# Just before paying
check = wavly.checks.create(
    {"mandate": mandate["id"], "purchase": {"item": "Saree", "amount_paise": 249900, "payee": "sarees@okhdfc"}},
    idempotency_key="order-1042",
)
if check["decision"] == "proceed":
    # pay, or hand check["payment_token"]["token"] to the payment provider, then
    wavly.checks.report_outcome(check["id"], {"status": "paid", "payment_reference": "4416 2209"})
elif check["decision"] == "ask":
    # send check["approval"]["url"] to the user, then wait for the webhook or:
    answered = wavly.checks.wait_for_approval(check["id"])
# on "stop", do not pay
```

Every write carries an Idempotency-Key, generated unless you pass one, so the SDK retries 429, 5xx and network errors without applying a write twice. Errors raise `WavlyError` with `status`, `code` and `field`.

## Make the check impossible to skip: `thewavly.guard`

An agent that has been told to check can skip the check. Guard the function your payment tool runs instead:

```python
from thewavly.guard import guard

@tool                                  # LangChain; or @function_tool (OpenAI Agents SDK), or none
@guard(wavly, mandate=os.environ["WAVLY_MANDATE"], purchase=cart_purchase,
       reference=lambda order, *a, **k: order["order_id"])
def place_order(cart_id: str) -> dict:
    """Place the order for a cart and pay for it."""
    return shop.place_order(cart_id)
```

- `cart_purchase(cart_id)` reads the purchase from your own systems: `item`, `amount_paise` (or `amount_rupees`), `merchant`, `payee`.
- **proceed:** the function runs, and the outcome is reported to TheWavly.
- **ask** or **stop:** it doesn't run. The tool returns `{"ordered": False, "decision": ..., "message": ..., "approval_url": ...}`. After an ask, the same call goes through once the user approves.
- **Mandate:** it comes from your code, never from the agent's arguments.
- **Fails closed:** anything unreadable means nothing is ordered.
- **Framework compatibility:** signature, type hints and docstring are kept, so frameworks build the same tool schema. Sync and async functions both work.

Working examples are in `examples/frameworks`.

Inside a guarded function, `thewavly.guard.checkout_headers()` returns the `Wavly-Agent` and `Wavly-Payment-Token` headers for a store that takes TheWavly. It needs a client created with `agent=`. `current_check()` returns the check that allowed the call.

## Disputes, agents and personal data

```python
d = wavly.disputes.create({"check": check["id"], "reason": "not_as_ordered", "description": "Arrived torn"})
print(d["suggestion"]["finding"], d["suggestion"]["explanation"])
wavly.disputes.add_evidence(d["id"], {"party": "merchant", "kind": "delivery_record", "text": "Courier photo"})
# An admin or owner records the finding in the dispute desk. A different person decides an appeal.
reviewed = wavly.disputes.retrieve(d["id"])
if reviewed["finding"]:
    print(reviewed["finding"]["finding"])

wavly.agents.score("shopbot-v2")                    # score, confidence and the track record behind it
wavly.end_users.erase({"approved_by": "user_7f3"})  # revokes and removes the person's personal data
```

## A registered agent, at checkout

Register your agent in TheWavly's [public registry](https://thewavly.com/agents) and add its public key. Then pass its identity to the client. Every check is then signed with its key, which needs `cryptography`, and counts toward its public record.

```python
wavly = Wavly(os.environ["WAVLY_API_KEY"], agent={"id": "acme-travelbot", "private_key": jwk})
check = wavly.checks.create({"mandate": mandate_id, "purchase": purchase})   # signed
if check["decision"] == "proceed" and Wavly.merchant_info(store_url):
    headers = Wavly.checkout_headers(check, "acme-travelbot")   # Wavly-Agent and Wavly-Payment-Token
```

A store that takes TheWavly publishes `/.well-known/wavly-merchant.json`. Before it charges, it calls `Wavly.verify_order(agent, payment_token)` and then `Wavly.redeem_payment_token(...)`. `wavly.registry` registers agents, proves their website and manages their keys. `thewavly.sign_check` and `thewavly.key_id` are there if you sign checks yourself.

## Signed checks and reconciliation

```python
wavly.agents.add_key("shopbot-v2", {"jwk": public_jwk})          # once; the private key stays with the agent
purchase = {"item": "Saree", "amount_paise": 249900, "payee": "sarees@okhdfc"}
check = wavly.checks.create({"mandate": mandate["id"], "purchase": purchase,
                             "agent_signature": Wavly.sign_check(private_jwk, mandate["id"], purchase)})

wavly.payments.record({"payment_reference": "UPI RRN", "amount_paise": 249900, "payee": "sarees@okhdfc", "source": "razorpay"})
```

## Verifying and payment providers

```python
event = Wavly.verify_webhook(raw_body, headers["Wavly-Signature"], os.environ["WAVLY_WEBHOOK_SECRET"])
payload = Wavly.verify_token(check["receipt"], jwks)   # jwks from /v1/orgs/<org>/jwks

# At the payment provider, with no API key: the token is the permission
Wavly.inspect_payment_token(token)
Wavly.redeem_payment_token(token, 249900, payee="sarees@okhdfc", payment_reference="UPI RRN")
```

Tests: `python -m unittest discover -s tests`. Set `WAVLY_TEST_BASE_URL` and `WAVLY_TEST_KEY` to run the end-to-end test against a live TheWavly deployment.
