# TheWavly formats, version 1

This document describes every signed object TheWavly produces or accepts, so anyone can verify TheWavly's records without TheWavly. Anyone may implement these formats. No permission is needed.

A reference verifier with no dependencies is in [`sdk/verify/wavly-verify.mjs`](../sdk/verify/wavly-verify.mjs). It checks a whole evidence pack offline:

```bash
node sdk/verify/wavly-verify.mjs wavly-evidence-chk_….json
```

## 1. Keys

Each organisation signs with Ed25519 keys and publishes them, with no authentication, at:

```
GET /v1/orgs/{org}/jwks
```

The response is `{"keys": [{"kty":"OKP","crv":"Ed25519","x":"…","kid":"…","status":"active"|"retired"}]}`.

- Retired keys stay published, so old records still verify.
- Evidence packs carry a copy of the keys. A careful verifier compares that copy with the published one.

## 2. TheWavly token

```
token = base64url(UTF-8 JSON payload) "." base64url(Ed25519 signature over the first part's ASCII bytes)
```

- base64url has no padding.
- Every payload carries `org` (the organisation id) and `kid` (the signing key).
- To verify a token:
  1. Find the key whose `kid` matches.
  2. Verify the signature over the first part exactly as received.
  3. Only then trust the payload.

All hashes below are SHA-256, encoded as base64url without padding, and written `H(x)`.

### 2.1 Mandate (`typ: "mandate"`)

The mandate records what the user approved.

| Field | Meaning |
|---|---|
| `id`, `ver` | Mandate id and version. A change to what was approved makes a new version. |
| `prev` | `H(previous version's token)`, or `null` for version 1. Versions therefore form a chain that cannot be reordered. |
| `approved_by` | The organisation's own reference for the person. It is not their name or phone number. |
| `instruction` | `H(the user's words)`. The words themselves are kept separately and can be erased. |
| `rules` | Each rule is listed in the table below. |
| `nbf`, `exp`, `iat` | When the mandate starts, when it ends, and when it was signed. Unix seconds. |
| `src` | Present only on imported mandates: the format (`ap2` or `verifiable_intent`) and `H(credential as presented)`. |

The rules are:

| Rule | Type | If the purchase breaks it |
|---|---|---|
| `items` | list of names, `"*"` for any | stop |
| `max_amount_paise` | integer | ask |
| `min_amount_paise` | integer | stop |
| `max_quantity` | integer | stop |
| `budget_paise` | integer, across all purchases | ask |
| `max_purchases` | integer | ask |
| `merchants` | list | stop |
| `payees` | list of UPI addresses | stop |
| `deliver_to` | text | stop |
| `currency` | `INR` | stop |
| `require_agent_signature` | `true` | stop, if the check is unsigned |
| `conditions` | list of `{term, equals \| at_least \| at_most \| one_of}` | stop if `purchase.terms[term]` fails; ask if the agent did not send it |
| `approval_ttl_seconds` | integer | — |

Names (items, merchants, delivery text and string conditions) are compared after Unicode NFKC normalisation, trimming, collapsing spaces and lower-casing. UPI payees are compared as the payment network reads them: ASCII only, ignoring case and surrounding spaces, with no Unicode folding, so a look-alike such as `ｓｈａｒｍａ@okhdfc` never matches `sharma@okhdfc`. Payee ids from imported AP2 or Verifiable Intent mandates, which need not be UPI addresses, are compared as names. A purchase may carry `terms`: the terms the agent was shown, such as `{"refundable": true, "free_cancellation_hours": 48}`. They are part of the purchase the receipt hashes.

### 2.2 Receipt (`typ: "receipt"`)

The receipt is TheWavly's answer to one check.

| Field | Meaning |
|---|---|
| `id` | The check id. |
| `mandate`, `ver` | The mandate version that the check used. |
| `decision` | `proceed`, `ask` or `stop`. |
| `basis` | `rules`, or `user_approval` when the user approved an ask. In that case the receipt is issued again and `approval` holds the approval id. |
| `purchase` | `H(JSON of the purchase as shown in the check)`. |
| `amount_paise` | The amount checked. |
| `agent`, `agent_kid` | Present only when the check was signed by a registered agent key (section 4). |

### 2.3 Dispute finding (`typ: "finding"`)

The finding is a human reviewer's signed decision on a dispute.

| Field | Meaning |
|---|---|
| `dispute`, `check`, `mandate` | What the dispute is about. |
| `stage` | `first`, or `appeal`. |
| `finding` | `agent_operator`, `merchant`, `payment_participant`, `shared`, `no_breach`, `insufficient_evidence` or `settled`. |
| `remedy` | `{type, amount_paise, funded_by, currency}`, or `{type: "none"}`. |
| `reviewer` | The reviewer's id. New findings identify the authenticated desk reviewer. Historical findings can contain an integration-supplied label. For an open appeal against such a finding, an admin signs a fresh review (`typ: finding_confirmation`) of the original token and review note. A different admin signs the appeal with its `first_review` digest and an independence declaration. |
| `evidence` | The `digest` of every piece of evidence the reviewer had. |
| `prev` | Present only on an appeal decision: `H(first finding's token)`. |
| `rulebook` | The rulebook version applied, currently `0.2`. |

### 2.4 Fulfilment report (`typ: "fulfilment"`)

A fulfilment report records what happened to the order after payment. It is reported by the merchant or payment provider that redeemed the payment token (proving it with the release key), or by the organisation through its API.

| Field | Meaning |
|---|---|
| `id`, `check` | The report id and the check it is about. |
| `party` | Who the report speaks for: `merchant`, `payment_participant`, `agent_operator` or `organisation`. |
| `via` | `payment_token` (the redeemer) or `api` (the organisation). |
| `status` | `delivered`, `partially_delivered`, `not_delivered`, `returned`, `refunded` or `cancelled`. |
| `items` | `H(JSON of the items list)`, or `null`. |
| `amount_paise` | The amount refunded or delivered, or `null`. |
| `occurred_at` | When it happened, as reported. Unix seconds. |
| `tracking`, `note` | `H(carrier + "|" + tracking reference)` and `H(note)`, or `null`. The plain values can be erased; the hashes stay. |
| `prev` | `H(previous report's token)` for the same check, or `null` for the first, so reports cannot be reordered or dropped from the middle. |

### 2.5 Evidence pack signature (`typ: "evidence_pack"`)

The pack is signed once, as a whole:

- `digest = H(JSON of the pack without its pack_signature field)`, serialised with the key order as delivered.
- To verify it, parse the file, remove `pack_signature`, serialise the rest with `JSON.stringify`, hash it, and compare the result with `digest`.

## 3. JWS formats

These objects are standard compact JWS (`header.payload.signature`), so any JOSE library can verify them.

- **AP2 Mandate Receipt.**
  - Header: `alg: EdDSA`, `typ: JWT`, `kid`.
  - Claims: `iss`, `iat`, `jti` (the check id), and `result` (`success` or `error`).
  - `reference` is the hash of the mandate as received.
  - `wavly` holds `{check, mandate, version, decision, basis}`.
  - Verify it against the organisation's JWKS.
- **Payment token.**
  - Header: `alg: EdDSA`.
  - Claims: `typ: wavly_payment`, `iss`, `jti`, `iat`, `exp`, the check, the most it allows in paise, `currency`, and the payee or merchant it is bound to.
  - Single use. Payment providers redeem it with `POST /v1/payment_tokens/redeem`.

## 4. Agent signature on a check

An agent proves which agent asked by signing each check with its own key. The organisation registers the agent's public key with:

```
POST /v1/agents/{agent}/keys {"jwk": {...}}
```

- The key is an Ed25519 (`OKP`) or P-256 (`EC`) JWK.
- Its `kid` is the RFC 7638 thumbprint.
- Ed25519 is also the key type agents publish for HTTP Message Signatures, so the same key can be reused.

```
agent_signature = compact JWS
  header  {"alg": "EdDSA" | "ES256", "kid": <thumbprint>, "typ": "wavly-check+jws"}
  payload {"mandate": <mandate id>, "purchase": H(canonical(purchase)), "iat": <unix seconds>, "jti": <8–100 chars>}
```

- `canonical(x)` is JSON with object keys sorted at every level, no extra whitespace, and non-ASCII left as is. It is the same as Python's `json.dumps(x, sort_keys=True, separators=(",", ":"), ensure_ascii=False)`.
- The purchase hashed is the exact `purchase` object sent in the check.
- TheWavly rejects a signature in any of these cases, and the check answers stop:
  - the key is unknown, or belongs to another agent;
  - the key has been revoked;
  - the signature is more than 300 seconds old;
  - the `jti` has been used before;
  - the signature is for another mandate or another purchase.

## 5. Evidence pack

`GET /v1/checks/{id}/evidence` returns everything needed to show what was approved, what was checked and what happened:

- `organisation` and `keys`;
- the `instruction` and `rules`;
- the mandate `chain` up to the version used;
- the `check` with its `purchase`, `results` and `receipt`;
- the user's `approval`, if any;
- every `fulfilment` report, in order;
- every `dispute`, with its evidence digests and signed decisions;
- the audit `events`;
- `pack_signature`.

When a person's data is erased, each of their mandate tokens is replaced by `"erased:" + H(token)`. That value is exactly what the next version's `prev` already commits to, so the chain still verifies while the personal data is gone.

## 6. Webhooks

Each delivery carries `Wavly-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, t + "." + raw body)>`. Reject deliveries more than five minutes old.

## Versioning

Fields may be added to any payload. A verifier must ignore fields it does not know. A change that alters the meaning of an existing field will get a new `typ` or a version 2 of this document.
