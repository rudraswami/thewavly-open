"""TheWavly Python SDK: check every agent purchase against what the user approved.

No dependencies for the API. Verifying signed tokens offline needs the `cryptography` package
(``pip install "thewavly[verify]"``).

    from thewavly import Wavly
    wavly = Wavly(os.environ["WAVLY_API_KEY"])
    mandate = wavly.mandates.create({"instruction": "Buy Amma a saree for up to ₹2,500", "approved_by": "user_7f3",
                                     "rules": {"items": ["Saree"], "max_amount_paise": 250000}})
    check = wavly.checks.create({"mandate": mandate["id"], "purchase": {"item": "Saree", "amount_paise": 249900}},
                                idempotency_key="order-1042")
    if check["decision"] == "proceed":
        pay()
        wavly.checks.report_outcome(check["id"], {"status": "paid", "payment_reference": "RRN 4416"})

An agent in TheWavly's public registry passes its identity once; every check is then signed with its key and counts
toward its public record. At a store that takes TheWavly, send ``Wavly.checkout_headers(check, agent)`` with the order:

    wavly = Wavly(key, agent={"id": "acme-travelbot", "private_key": jwk})   # signing needs ``cryptography``
    check = wavly.checks.create({"mandate": mandate_id, "purchase": purchase})
    requests.post(store + "/checkout", headers=Wavly.checkout_headers(check, "acme-travelbot"), json=order)
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import random
import time
import uuid
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Callable, Dict, Optional

__all__ = ["Wavly", "WavlyError", "DEFAULT_BASE_URL", "canonical", "sign_check", "key_id", "__version__"]
__version__ = "0.2.0"
DEFAULT_BASE_URL = "https://thewavly.com"
JSON = Dict[str, Any]


class WavlyError(Exception):
    """An error answer from TheWavly. ``status`` is the HTTP status; ``code`` and ``field`` come from the body."""

    def __init__(self, status: int, body: Optional[JSON]):
        err = (body or {}).get("error") or {}
        super().__init__(err.get("message") or "TheWavly request failed with HTTP %d" % status)
        self.status, self.code, self.field, self.body = status, err.get("code"), err.get("field"), body
        self.request_id = err.get("request_id")


def _b64u(data: str) -> bytes:
    return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4))


def _q(params: Optional[JSON]) -> str:
    clean = {k: v for k, v in (params or {}).items() if v is not None}
    return "?" + urllib.parse.urlencode(clean) if clean else ""


def _id(value: str) -> str:
    return urllib.parse.quote(str(value), safe="")


class _Resource:
    def __init__(self, client: "Wavly"):
        self._c = client


class _Mandates(_Resource):
    def create(self, body: JSON, idempotency_key: Optional[str] = None) -> JSON:
        return self._c.request("POST", "/v1/mandates", body, idempotency_key)

    def import_(self, body: JSON, idempotency_key: Optional[str] = None) -> JSON:
        """Import an AP2 or Verifiable Intent open mandate."""
        return self._c.request("POST", "/v1/mandates/import", body, idempotency_key)

    def retrieve(self, mandate_id: str) -> JSON:
        return self._c.request("GET", "/v1/mandates/" + _id(mandate_id))

    def list(self, **params: Any) -> JSON:
        return self._c.request("GET", "/v1/mandates" + _q(params))

    def revoke(self, mandate_id: str, body: Optional[JSON] = None) -> JSON:
        return self._c.request("POST", "/v1/mandates/" + _id(mandate_id) + "/revoke", body or {})


class _Checks(_Resource):
    def create(self, body: JSON, idempotency_key: Optional[str] = None) -> JSON:
        """With an agent identity, the check names the agent and is signed with its key (unless already signed)."""
        agent = self._c.agent
        if agent and body.get("agent_signature") is None:
            body = dict(body)
            body.setdefault("agent", agent["id"])
            if agent.get("private_key"):
                body["agent_signature"] = sign_check(agent["private_key"], body["mandate"], body["purchase"])
        return self._c.request("POST", "/v1/checks", body, idempotency_key)

    def retrieve(self, check_id: str) -> JSON:
        return self._c.request("GET", "/v1/checks/" + _id(check_id))

    def list(self, **params: Any) -> JSON:
        return self._c.request("GET", "/v1/checks" + _q(params))

    def report_outcome(self, check_id: str, body: JSON, idempotency_key: Optional[str] = None) -> JSON:
        return self._c.request("POST", "/v1/checks/" + _id(check_id) + "/outcome", body, idempotency_key)

    def evidence(self, check_id: str) -> JSON:
        return self._c.request("GET", "/v1/checks/" + _id(check_id) + "/evidence")

    def report_fulfilment(self, check_id: str, status: str, idempotency_key: Optional[str] = None, **fields: Any) -> JSON:
        """Report what happened to the order: delivered, partially_delivered, not_delivered, returned, refunded (with
        amount_paise) or cancelled. Optional: party, items, amount_paise, occurred_at, carrier, tracking_reference, note."""
        return self._c.request("POST", "/v1/checks/" + _id(check_id) + "/fulfilment", {"status": status, **fields}, idempotency_key)

    def fulfilment(self, check_id: str) -> JSON:
        return self._c.request("GET", "/v1/checks/" + _id(check_id) + "/fulfilment")

    def payment_token(self, check_id: str) -> JSON:
        return self._c.request("POST", "/v1/checks/" + _id(check_id) + "/payment_token", {})

    def wait_for_approval(self, check_id: str, interval: float = 3.0, timeout: float = 900.0) -> JSON:
        """Polls until the user answers an ask, or the request expires. Prefer webhooks in production."""
        until = time.monotonic() + timeout
        while True:
            c = self.retrieve(check_id)
            if not c.get("approval") or c["approval"]["status"] != "pending" or time.monotonic() > until:
                return c
            time.sleep(interval)


class _Disputes(_Resource):
    def _p(self, dispute_id: str, action: str = "") -> str:
        return "/v1/disputes/" + _id(dispute_id) + ("/" + action if action else "")

    def create(self, body: JSON, idempotency_key: Optional[str] = None) -> JSON:
        return self._c.request("POST", "/v1/disputes", body, idempotency_key)

    def retrieve(self, dispute_id: str) -> JSON:
        return self._c.request("GET", self._p(dispute_id))

    def list(self, **params: Any) -> JSON:
        return self._c.request("GET", "/v1/disputes" + _q(params))

    def add_evidence(self, dispute_id: str, body: JSON) -> JSON:
        return self._c.request("POST", self._p(dispute_id, "evidence"), body)

    def resolve(self, dispute_id: str, body: JSON) -> JSON:
        """Retained for older clients. Deciding a finding requires a signed-in admin in the dispute desk."""
        return self._c.request("POST", self._p(dispute_id, "resolve"), body)

    def appeal(self, dispute_id: str, body: JSON) -> JSON:
        return self._c.request("POST", self._p(dispute_id, "appeal"), body)

    def assign(self, dispute_id: str, assignee: Optional[str]) -> JSON:
        """Assign to a member by id or email; ``None`` unassigns. An appeal cannot go to its first reviewer."""
        return self._c.request("POST", self._p(dispute_id, "assign"), {"assignee": assignee})

    def invite_party(self, dispute_id: str, party: str, name: str, **fields: Any) -> JSON:
        """Ask the merchant, agent operator or payment provider to respond through a link. The link is returned once.
        Optional: email, include_evidence, expires_in_days."""
        return self._c.request("POST", self._p(dispute_id, "parties"), {"party": party, "name": name, **fields})

    def parties(self, dispute_id: str) -> JSON:
        return self._c.request("GET", self._p(dispute_id, "parties"))

    def revoke_party(self, dispute_id: str, party_id: str) -> JSON:
        return self._c.request("POST", self._p(dispute_id, "parties/" + _id(party_id) + "/revoke"), {})

    def stats(self, days: int = 30) -> JSON:
        """The desk's figures: queue, hours to a finding, share within the deadline, minutes per case, appeals overturned."""
        return self._c.request("GET", "/v1/disputes/stats" + _q({"days": days}))

    def withdraw(self, dispute_id: str, body: Optional[JSON] = None) -> JSON:
        return self._c.request("POST", self._p(dispute_id, "withdraw"), body or {})

    def update_remedy(self, dispute_id: str, body: JSON) -> JSON:
        return self._c.request("POST", self._p(dispute_id, "remedy"), body)


class _Agents(_Resource):
    def list(self) -> JSON:
        return self._c.request("GET", "/v1/agents")

    def score(self, agent: str) -> JSON:
        return self._c.request("GET", "/v1/agents/" + _id(agent) + "/score")

    def add_key(self, agent: str, body: JSON) -> JSON:
        """Register an agent's public key: ``{"jwk": {...public Ed25519 or P-256 JWK...}, "label": "..."}``."""
        return self._c.request("POST", "/v1/agents/" + _id(agent) + "/keys", body)

    def list_keys(self, agent: str) -> JSON:
        return self._c.request("GET", "/v1/agents/" + _id(agent) + "/keys")

    def revoke_key(self, agent: str, kid: str) -> JSON:
        return self._c.request("POST", "/v1/agents/" + _id(agent) + "/keys/" + _id(kid) + "/revoke", {})


class _Registry(_Resource):
    """TheWavly's public registry of agents: register, prove the website, add keys. Reads need no key."""

    def register(self, body: JSON) -> JSON:
        return self._c.request("POST", "/v1/registry/agents", body)

    def mine(self) -> JSON:
        return self._c.request("GET", "/v1/registry/agents?mine=true")

    def manage(self, agent: str) -> JSON:
        return self._c.request("GET", "/v1/registry/agents/" + _id(agent) + "/manage")

    def verify_domain(self, agent: str) -> JSON:
        return self._c.request("POST", "/v1/registry/agents/" + _id(agent) + "/verify", {})

    def add_key(self, agent: str, body: JSON) -> JSON:
        return self._c.request("POST", "/v1/registry/agents/" + _id(agent) + "/keys", body)

    def revoke_key(self, agent: str, kid: str) -> JSON:
        return self._c.request("POST", "/v1/registry/agents/" + _id(agent) + "/keys/" + _id(kid) + "/revoke", {})

    def retrieve(self, agent: str) -> JSON:
        return self._c.request("GET", "/v1/registry/agents/" + _id(agent))

    def directory(self) -> JSON:
        return self._c.request("GET", "/v1/registry/agents")


def _b64u_enc(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _b64u_dec(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def key_id(jwk: JSON) -> str:
    """The key id TheWavly uses: the RFC 7638 thumbprint of the public key."""
    pub = {"crv": jwk["crv"], "kty": jwk["kty"], "x": jwk["x"]}
    if jwk["kty"] == "EC":
        pub["y"] = jwk["y"]
    return _b64u_enc(hashlib.sha256(json.dumps(pub, separators=(",", ":")).encode()).digest())


def sign_check(private_jwk: JSON, mandate: str, purchase: JSON, iat: Optional[int] = None, jti: Optional[str] = None) -> str:
    """Signs a check with the agent's private key (an Ed25519 or P-256 JWK whose public half is registered).
    Pass the result as ``agent_signature`` with exactly the same purchase. Needs the ``cryptography`` package."""
    try:
        from cryptography.hazmat.primitives import hashes
        from cryptography.hazmat.primitives.asymmetric import ec, ed25519
        from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature
    except ImportError:  # pragma: no cover
        raise ImportError('Signing checks needs the cryptography package: pip install "thewavly[verify]"') from None
    if not private_jwk.get("d"):
        raise ValueError("Sign with the agent's private key: this JWK has no 'd'")
    alg = "EdDSA" if private_jwk.get("kty") == "OKP" and private_jwk.get("crv") == "Ed25519" else "ES256" if private_jwk.get("crv") == "P-256" else None
    if not alg:
        raise ValueError("The agent's key must be Ed25519 (OKP) or P-256 (EC)")
    header = {"alg": alg, "kid": key_id(private_jwk), "typ": "wavly-check+jws"}
    payload = {"mandate": mandate, "purchase": _b64u_enc(hashlib.sha256(canonical(purchase).encode()).digest()),
               "iat": int(time.time()) if iat is None else iat, "jti": jti or uuid.uuid4().hex}
    signing_input = (_b64u_enc(json.dumps(header, separators=(",", ":")).encode()) + "." +
                     _b64u_enc(json.dumps(payload, separators=(",", ":")).encode())).encode()
    d = _b64u_dec(private_jwk["d"])
    if alg == "EdDSA":
        sig = ed25519.Ed25519PrivateKey.from_private_bytes(d).sign(signing_input)
    else:
        der = ec.derive_private_key(int.from_bytes(d, "big"), ec.SECP256R1()).sign(signing_input, ec.ECDSA(hashes.SHA256()))
        r, s = decode_dss_signature(der)
        sig = r.to_bytes(32, "big") + s.to_bytes(32, "big")
    return signing_input.decode() + "." + _b64u_enc(sig)


class _Payments(_Resource):
    def record(self, body: JSON, idempotency_key: Optional[str] = None) -> JSON:
        """Report a real debit; TheWavly matches it to the check that allowed it, or flags it."""
        return self._c.request("POST", "/v1/payments", body, idempotency_key)

    def list(self, **params: Any) -> JSON:
        return self._c.request("GET", "/v1/payments" + _q(params))


def canonical(value: Any) -> str:
    """JSON with object keys sorted, as TheWavly hashes a purchase for agent signatures."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


class _Simple(_Resource):
    def __init__(self, client: "Wavly", **routes: Callable[..., JSON]):
        super().__init__(client)
        for name, fn in routes.items():
            setattr(self, name, fn)


class Wavly:
    """A client for one TheWavly organisation, authenticated with a secret key (``sk_test_…`` or ``sk_live_…``)."""

    def __init__(self, api_key: str, base_url: str = DEFAULT_BASE_URL, timeout: float = 15.0, max_retries: int = 2,
                 opener: Optional[Callable[..., Any]] = None, agent: Optional[JSON] = None):
        if not str(api_key or "").startswith(("sk_test_", "sk_live_")):
            raise ValueError("TheWavly needs a secret key that starts with sk_test_ or sk_live_")
        if agent is not None and (not isinstance(agent, dict) or not agent.get("id")):
            raise ValueError('agent must be {"id": handle_or_id, "private_key": jwk}')
        self.agent = agent
        self.api_key, self.base_url, self.timeout, self.max_retries = api_key, base_url.rstrip("/"), timeout, max_retries
        self._open = opener or urllib.request.urlopen
        r = self.request
        self.mandates = _Mandates(self)
        self.checks = _Checks(self)
        self.disputes = _Disputes(self)
        self.agents = _Agents(self)
        self.registry = _Registry(self)
        self.payments = _Payments(self)
        self.approvals = _Simple(self, retrieve=lambda i: r("GET", "/v1/approvals/" + _id(i)))
        self.webhook_endpoints = _Simple(self, create=lambda b: r("POST", "/v1/webhook_endpoints", b),
                                         list=lambda: r("GET", "/v1/webhook_endpoints"),
                                         delete=lambda i: r("DELETE", "/v1/webhook_endpoints/" + _id(i)))
        self.events = _Simple(self, list=lambda **p: r("GET", "/v1/events" + _q(p)))
        self.end_users = _Simple(self, erase=lambda b: r("POST", "/v1/end_users/erase", b))

    def health(self) -> JSON:
        return self.request("GET", "/v1/health")

    def request(self, method: str, path: str, body: Optional[JSON] = None, idempotency_key: Optional[str] = None) -> JSON:
        """Sends one request. Writes carry an Idempotency-Key (generated unless given), so a retried write never applies twice."""
        headers = {"Authorization": "Bearer " + self.api_key, "User-Agent": "wavly-python/" + __version__, "Accept": "application/json"}
        data = None
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        if method == "POST":
            headers["Idempotency-Key"] = idempotency_key or str(uuid.uuid4())
        attempt = 0
        while True:
            req = urllib.request.Request(self.base_url + path, data=data, method=method, headers=headers)
            try:
                with self._open(req, timeout=self.timeout) as res:
                    raw = res.read()
                    return json.loads(raw) if raw else {}
            except urllib.error.HTTPError as e:
                raw = e.read()
                try:
                    parsed = json.loads(raw) if raw else None
                except ValueError:
                    parsed = None
                code = ((parsed or {}).get("error") or {}).get("code")
                retryable = e.code == 429 or e.code >= 500 or (e.code == 409 and code == "busy")
                if retryable and attempt < self.max_retries:
                    wait = max(float(e.headers.get("Retry-After") or 0), 0.4 * 2 ** attempt)
                    time.sleep(min(wait, 30) + random.random() * 0.1)
                    attempt += 1
                    continue
                raise WavlyError(e.code, parsed) from None
            except (urllib.error.URLError, TimeoutError, ConnectionError):
                if attempt < self.max_retries:
                    time.sleep(0.4 * 2 ** attempt)
                    attempt += 1
                    continue
                raise

    # ---- for agents at checkout ----------------------------------------------------------------------------------------
    @staticmethod
    def checkout_headers(check: JSON, agent: str) -> Dict[str, str]:
        """The headers a store that takes TheWavly reads: the agent's identity and the single-use payment token."""
        token = (check.get("payment_token") or {}).get("token")
        if not token:
            raise ValueError("This check has no payment token: it may be paid only once its decision is proceed, or after the user approves")
        if not agent:
            raise ValueError("checkout_headers needs the agent's registry handle or id")
        return {"Wavly-Agent": agent, "Wavly-Payment-Token": token}

    @staticmethod
    def merchant_info(store_url: str, opener: Optional[Callable[..., Any]] = None, timeout: float = 5.0) -> Optional[JSON]:
        """Whether a store takes TheWavly payment tokens: its /.well-known/wavly-merchant.json, or None."""
        req = urllib.request.Request(urllib.parse.urljoin(store_url, "/.well-known/wavly-merchant.json"),
                                     headers={"Accept": "application/json", "User-Agent": "wavly-python/" + __version__})
        try:
            with (opener or urllib.request.urlopen)(req, timeout=timeout) as res:
                info = json.loads(res.read())
        except (urllib.error.URLError, ValueError, TimeoutError, ConnectionError):
            return None
        return info if isinstance(info, dict) and "wavly-payment-token" in (info.get("accepts") or []) else None

    @staticmethod
    def verify_order(agent: str, payment_token: Optional[str] = None, base_url: str = DEFAULT_BASE_URL,
                     opener: Optional[Callable[..., Any]] = None) -> JSON:
        """For merchants, no key needed: is this agent verified, and did its user approve this payment?"""
        body: JSON = {"agent": agent}
        if payment_token:
            body["payment_token"] = payment_token
        return Wavly._public("/v1/registry/verify", body, base_url, opener)

    # ---- for payment providers, who need no TheWavly key: the token is the permission ---------------------------------
    @staticmethod
    def _public(path: str, body: JSON, base_url: str, opener: Optional[Callable[..., Any]] = None) -> JSON:
        req = urllib.request.Request(base_url.rstrip("/") + path, data=json.dumps(body).encode(), method="POST",
                                     headers={"Content-Type": "application/json", "User-Agent": "wavly-python/" + __version__})
        try:
            with (opener or urllib.request.urlopen)(req, timeout=15) as res:
                return json.loads(res.read())
        except urllib.error.HTTPError as e:
            raw = e.read()
            raise WavlyError(e.code, json.loads(raw) if raw else None) from None

    @staticmethod
    def inspect_payment_token(token: str, base_url: str = DEFAULT_BASE_URL, opener: Optional[Callable[..., Any]] = None) -> JSON:
        return Wavly._public("/v1/payment_tokens/inspect", {"token": token}, base_url, opener)

    @staticmethod
    def release_payment_token(token: str, release_key: str, reason: Optional[str] = None, base_url: str = DEFAULT_BASE_URL,
                              opener: Optional[Callable[..., Any]] = None) -> JSON:
        """The charge failed after redemption: give the user's approval back, with the ``release_key`` the redemption
        returned. Needs no TheWavly key; safe to repeat."""
        body: JSON = {"token": token, "release_key": release_key}
        if reason:
            body["reason"] = reason
        return Wavly._public("/v1/payment_tokens/release", body, base_url, opener)

    @staticmethod
    def report_fulfilment(token: str, release_key: str, status: str, base_url: str = DEFAULT_BASE_URL,
                          opener: Optional[Callable[..., Any]] = None, **fields: Any) -> JSON:
        """For the store or provider that redeemed the token: report what happened to the order, proven with the
        ``release_key`` the redemption returned. Needs no TheWavly key."""
        return Wavly._public("/v1/payment_tokens/fulfilment", {"token": token, "release_key": release_key, "status": status, **fields}, base_url, opener)

    @staticmethod
    def redeem_payment_token(token: str, amount_paise: int, payee: Optional[str] = None, merchant: Optional[str] = None,
                             payment_reference: Optional[str] = None, currency: str = "INR", base_url: str = DEFAULT_BASE_URL,
                             opener: Optional[Callable[..., Any]] = None) -> JSON:
        """Redeem exactly once, just before charging. TheWavly refuses a second use, a higher amount or another payee."""
        body = {"token": token, "amount_paise": amount_paise, "payee": payee, "merchant": merchant, "payment_reference": payment_reference, "currency": currency}
        return Wavly._public("/v1/payment_tokens/redeem", {k: v for k, v in body.items() if v is not None}, base_url, opener)

    @staticmethod
    def sign_check(private_jwk: JSON, mandate: str, purchase: JSON, jti: Optional[str] = None, iat: Optional[int] = None) -> str:
        """For agents: sign a check with the agent's private key (Ed25519 or P-256 JWK). Pass the result as ``agent_signature``."""
        from cryptography.hazmat.primitives import hashes
        from cryptography.hazmat.primitives.asymmetric import ec
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
        from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature

        def b64(data: bytes) -> str:
            return base64.urlsafe_b64encode(data).rstrip(b"=").decode()

        okp = private_jwk.get("kty") == "OKP"
        pub = {"crv": private_jwk["crv"], "kty": "OKP", "x": private_jwk["x"]} if okp else {"crv": private_jwk["crv"], "kty": "EC", "x": private_jwk["x"], "y": private_jwk["y"]}
        header = {"alg": "EdDSA" if okp else "ES256", "kid": b64(hashlib.sha256(json.dumps(pub, separators=(",", ":")).encode()).digest()), "typ": "wavly-check+jws"}
        payload = {"mandate": mandate, "purchase": b64(hashlib.sha256(canonical(purchase).encode()).digest()),
                   "iat": int(iat if iat is not None else time.time()), "jti": jti or uuid.uuid4().hex}
        signing_input = (b64(json.dumps(header, separators=(",", ":")).encode()) + "." + b64(json.dumps(payload, separators=(",", ":")).encode())).encode()
        if okp:
            sig = Ed25519PrivateKey.from_private_bytes(_b64u(private_jwk["d"])).sign(signing_input)
        else:
            key = ec.derive_private_key(int.from_bytes(_b64u(private_jwk["d"]), "big"), ec.SECP256R1())
            r, s_ = decode_dss_signature(key.sign(signing_input, ec.ECDSA(hashes.SHA256())))
            sig = r.to_bytes(32, "big") + s_.to_bytes(32, "big")
        return signing_input.decode() + "." + b64(sig)

    # ---- offline checks ---------------------------------------------------------------------------------------------
    @staticmethod
    def verify_webhook(raw_body: bytes | str, signature_header: str, secret: str, tolerance_seconds: int = 300) -> JSON:
        """Checks a webhook's Wavly-Signature header and returns the event. Raises ValueError if it does not match or is too old."""
        body = raw_body.decode("utf-8") if isinstance(raw_body, bytes) else raw_body
        parts = dict(p.split("=", 1) for p in (signature_header or "").split(",") if "=" in p)
        if not parts.get("t", "").isdigit() or len(parts.get("v1", "")) != 64:
            raise ValueError("Missing or malformed Wavly-Signature header")
        if abs(time.time() - int(parts["t"])) > tolerance_seconds:
            raise ValueError("Webhook timestamp is outside the allowed window")
        want = hmac.new(secret.encode(), (parts["t"] + "." + body).encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(want, parts["v1"]):
            raise ValueError("Webhook signature does not match")
        return json.loads(body)

    @staticmethod
    def verify_token(token: str, jwks: JSON | list) -> JSON:
        """Verifies a TheWavly token (mandate, receipt, finding, evidence pack signature) against a JWKS. Returns its payload."""
        try:
            from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
            from cryptography.exceptions import InvalidSignature
        except ImportError as e:  # pragma: no cover
            raise ImportError('Verifying tokens needs the cryptography package: pip install "thewavly[verify]"') from e
        body, _, sig = str(token).partition(".")
        payload = json.loads(_b64u(body))
        keys = jwks.get("keys", []) if isinstance(jwks, dict) else jwks
        jwk = next((k for k in keys if k.get("kid") == payload.get("kid")), None)
        if not jwk:
            raise ValueError("No published key matches this token")
        try:
            Ed25519PublicKey.from_public_bytes(_b64u(jwk["x"])).verify(_b64u(sig), body.encode())
        except InvalidSignature:
            raise ValueError("Signature does not match") from None
        return payload
