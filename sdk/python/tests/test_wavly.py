"""Tests for TheWavly Python SDK.

Offline tests always run. The end-to-end test runs against a live TheWavly instance when WAVLY_TEST_BASE_URL and
WAVLY_TEST_KEY are set, for example to a local TheWavly and a test key.
"""
import hashlib
import hmac
import json
import os
import sys
import time
import unittest
import urllib.request

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from thewavly import Wavly, WavlyError  # noqa: E402

BASE, KEY = os.environ.get("WAVLY_TEST_BASE_URL"), os.environ.get("WAVLY_TEST_KEY")


class Offline(unittest.TestCase):
    def test_needs_a_secret_key(self):
        with self.assertRaises(ValueError):
            Wavly("pk_nope")

    def test_verify_webhook(self):
        body, secret, t = json.dumps({"type": "check.created"}), "whsec_test", str(int(time.time()))
        sig = "t=%s,v1=%s" % (t, hmac.new(secret.encode(), (t + "." + body).encode(), hashlib.sha256).hexdigest())
        self.assertEqual(Wavly.verify_webhook(body, sig, secret)["type"], "check.created")
        with self.assertRaises(ValueError):
            Wavly.verify_webhook(body + " ", sig, secret)
        old = str(int(time.time()) - 1000)
        stale = "t=%s,v1=%s" % (old, hmac.new(secret.encode(), (old + "." + body).encode(), hashlib.sha256).hexdigest())
        with self.assertRaises(ValueError):
            Wavly.verify_webhook(body, stale, secret)

    def test_retries_server_errors_with_the_same_idempotency_key(self):
        seen = []

        class Res:
            def __init__(self, data): self.data = data
            def read(self): return self.data
            def __enter__(self): return self
            def __exit__(self, *a): return False

        def opener(req, timeout):
            seen.append(req.get_header("Idempotency-key"))
            if len(seen) == 1:
                import io, urllib.error
                raise urllib.error.HTTPError(req.full_url, 503, "busy", {"Retry-After": "0"}, io.BytesIO(b'{"error":{"code":"server_error","message":"x"}}'))
            return Res(b'{"id":"chk_1"}')

        client = Wavly("sk_test_" + "x" * 32, base_url="https://wavly.example", opener=opener)
        self.assertEqual(client.checks.create({"mandate": "mdt_1"})["id"], "chk_1")
        self.assertEqual(len(seen), 2)
        self.assertEqual(seen[0], seen[1])


@unittest.skipUnless(BASE and KEY, "set WAVLY_TEST_BASE_URL and WAVLY_TEST_KEY to run against a live TheWavly instance")
class EndToEnd(unittest.TestCase):
    def test_whole_flow(self):
        wavly = Wavly(KEY, base_url=BASE)
        self.assertEqual(wavly.health()["status"], "ok")
        m = wavly.mandates.create({"instruction": "A saree up to ₹2,500", "approved_by": "py_user", "agent": "pybot",
                                   "rules": {"items": ["Saree"], "max_amount_paise": 250000, "payees": ["sarees@okhdfc"]}})
        c = wavly.checks.create({"mandate": m["id"], "purchase": {"item": "Saree", "amount_paise": 249900, "payee": "sarees@okhdfc"}}, idempotency_key="py-order-1")
        self.assertEqual(c["decision"], "proceed")
        self.assertEqual(wavly.checks.create({"mandate": m["id"], "purchase": {"item": "Saree", "amount_paise": 249900, "payee": "sarees@okhdfc"}}, idempotency_key="py-order-1")["id"], c["id"])
        self.assertIn("payment_token", c)
        redeemed = Wavly.redeem_payment_token(c["payment_token"]["token"], 249900, payee="sarees@okhdfc", payment_reference="RRN-PY", base_url=BASE)
        self.assertEqual(redeemed["status"], "paid")
        with self.assertRaises(WavlyError) as again:
            Wavly.redeem_payment_token(c["payment_token"]["token"], 249900, payee="sarees@okhdfc", payment_reference="RRN-PY-2", base_url=BASE)
        self.assertEqual(again.exception.status, 409)

        org = json.loads(__import__("base64").urlsafe_b64decode(c["receipt"].split(".")[0] + "==="))["org"]
        with urllib.request.urlopen(BASE + "/v1/orgs/" + org + "/jwks") as res:
            jwks = json.loads(res.read())
        self.assertEqual(Wavly.verify_token(c["receipt"], jwks)["decision"], "proceed")
        with self.assertRaises(ValueError):
            Wavly.verify_token(c["receipt"][:-4] + "AAAA", jwks)

        stop = wavly.checks.create({"mandate": m["id"], "purchase": {"item": "Laptop", "amount_paise": 100}})
        self.assertEqual(stop["decision"], "stop")

        d = wavly.disputes.create({"check": c["id"], "reason": "not_as_ordered", "description": "Wrong colour arrived."})
        self.assertEqual(d["suggestion"]["finding"], "merchant")
        d = wavly.disputes.add_evidence(d["id"], {"party": "merchant", "kind": "delivery_record", "text": "Delivered red, as ordered."})
        with self.assertRaises(WavlyError) as unsigned:
            wavly.disputes.resolve(d["id"], {"reviewer": "Priya Rao", "finding": "no_breach", "note": "The order was for red."})
        self.assertEqual((unsigned.exception.status, unsigned.exception.code), (403, "reviewer_sign_in_required"))
        self.assertEqual(wavly.disputes.retrieve(d["id"])["status"], "open")
        # The isolated test harness supplies a real dashboard session for the human decision.
        if os.environ.get("WAVLY_TEST_REVIEW_COOKIE"):
            request = urllib.request.Request(BASE + "/console/api/disputes/" + d["id"] + "/resolve",
                data=json.dumps({"finding": "no_breach", "note": "The order was for red."}).encode(),
                headers={"Content-Type": "application/json", "Origin": BASE, "X-Wavly-Console": "1",
                         "Cookie": os.environ["WAVLY_TEST_REVIEW_COOKIE"]})
            with urllib.request.urlopen(request) as response:
                self.assertEqual(response.status, 200)
            d = wavly.disputes.retrieve(d["id"])
            self.assertEqual(d["status"], "resolved")
            self.assertEqual(Wavly.verify_token(d["finding"]["token"], jwks)["typ"], "finding")
        score = wavly.agents.score("pybot")
        self.assertEqual(score["track_record"]["checks"], 2)
        # An agent signs its own check with its key (Ed25519, then P-256)
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
        from cryptography.hazmat.primitives.asymmetric import ec
        from cryptography.hazmat.primitives import serialization
        b64 = lambda b: __import__("base64").urlsafe_b64encode(b).rstrip(b"=").decode()
        sk = Ed25519PrivateKey.generate()
        raw = lambda k: k.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
        priv = {"kty": "OKP", "crv": "Ed25519", "x": b64(raw(sk)), "d": b64(sk.private_bytes(serialization.Encoding.Raw, serialization.PrivateFormat.Raw, serialization.NoEncryption()))}
        key = wavly.agents.add_key("pybot", {"jwk": {k: v for k, v in priv.items() if k != "d"}})
        purchase = {"item": "Saree", "amount_paise": 100000, "payee": "sarees@okhdfc"}
        signed = wavly.checks.create({"mandate": m["id"], "purchase": purchase, "agent_signature": Wavly.sign_check(priv, m["id"], purchase)})
        self.assertEqual(signed["agent_verification"]["status"], "verified")
        self.assertEqual(signed["agent_verification"]["kid"], key["kid"])
        eck = ec.generate_private_key(ec.SECP256R1()); n = eck.public_key().public_numbers()
        epriv = {"kty": "EC", "crv": "P-256", "x": b64(n.x.to_bytes(32, "big")), "y": b64(n.y.to_bytes(32, "big")), "d": b64(eck.private_numbers().private_value.to_bytes(32, "big"))}
        wavly.agents.add_key("pybot", {"jwk": {k: v for k, v in epriv.items() if k != "d"}})
        signed2 = wavly.checks.create({"mandate": m["id"], "purchase": purchase, "agent_signature": Wavly.sign_check(epriv, m["id"], purchase)})
        self.assertEqual(signed2["agent_verification"]["status"], "verified")

        # Reconciliation: the debit for the signed check matches; an unknown one is flagged
        self.assertEqual(wavly.payments.record({"payment_reference": "PY-RRN-9", "amount_paise": 100000, "payee": "sarees@okhdfc", "source": "razorpay"})["status"], "matched")
        self.assertEqual(wavly.payments.record({"payment_reference": "PY-RRN-10", "amount_paise": 500, "payee": "x@okaxis"})["status"], "unchecked")
        self.assertEqual(wavly.payments.list(status="unchecked")["summary"]["unchecked"]["count"], 1)

        erased = wavly.end_users.erase({"approved_by": "py_user"})
        self.assertEqual(erased["mandates"], 1)
        self.assertEqual(wavly.mandates.retrieve(m["id"])["instruction"], "[erased]")


if __name__ == "__main__":
    unittest.main()


def _keypair(kind):
    """A fresh private JWK (Ed25519 or P-256), made with cryptography."""
    import base64 as b
    from cryptography.hazmat.primitives.asymmetric import ec, ed25519
    from cryptography.hazmat.primitives import serialization as s
    enc = lambda x: b.urlsafe_b64encode(x).rstrip(b"=").decode()  # noqa: E731
    if kind == "ed25519":
        k = ed25519.Ed25519PrivateKey.generate()
        return {"kty": "OKP", "crv": "Ed25519", "x": enc(k.public_key().public_bytes(s.Encoding.Raw, s.PublicFormat.Raw)),
                "d": enc(k.private_bytes(s.Encoding.Raw, s.PrivateFormat.Raw, s.NoEncryption()))}
    k = ec.generate_private_key(ec.SECP256R1())
    n = k.private_numbers()
    return {"kty": "EC", "crv": "P-256", "x": enc(n.public_numbers.x.to_bytes(32, "big")), "y": enc(n.public_numbers.y.to_bytes(32, "big")),
            "d": enc(n.private_value.to_bytes(32, "big"))}


@unittest.skipUnless(BASE and KEY, "set WAVLY_TEST_BASE_URL and WAVLY_TEST_KEY to run against a live TheWavly instance")
class RegisteredAgent(unittest.TestCase):
    def test_registry_signing_and_checkout_headers(self):
        admin = Wavly(KEY, base_url=BASE)
        handle = "py-agent-%d" % int(time.time() * 1000 % 10 ** 9)
        a = admin.registry.register({"handle": handle, "name": "Py Agent", "website": "py-agent.in"})
        self.assertEqual(a["status"], "registered")
        self.assertTrue(any(x["handle"] == handle for x in admin.registry.mine()["data"]))
        mandate = admin.mandates.create({"instruction": "A kit up to ₹600", "approved_by": "py_user",
                                         "rules": {"items": ["Masala dosa kit"], "max_amount_paise": 60000}})["id"]
        purchase = {"item": "Masala dosa kit", "amount_paise": 56100, "payee": "demokitchen@okhdfc", "terms": {"veg": True}}
        for kind in ("ed25519", "p256"):
            jwk = _keypair(kind)
            pub = {k: v for k, v in jwk.items() if k != "d"}
            added = admin.registry.add_key(handle, {"jwk": pub})
            from thewavly import key_id
            self.assertEqual(added["kid"], key_id(jwk), "the SDK computes the same key id as TheWavly")
            wavly = Wavly(KEY, base_url=BASE, agent={"id": handle, "private_key": jwk})
            c = wavly.checks.create({"mandate": mandate, "purchase": purchase})
            self.assertEqual(c["decision"], "proceed")
            self.assertEqual(c["agent_verification"]["status"], "verified", kind)
            self.assertTrue(c["agent_verification"]["registry"])
            h = Wavly.checkout_headers(c, handle)
            self.assertEqual(h["Wavly-Agent"], handle)
            answer = Wavly.verify_order(handle, h["Wavly-Payment-Token"], base_url=BASE)
            self.assertFalse(answer["accept"])
            self.assertTrue(any("has not verified its website" in r for r in answer["reasons"]))
            self.assertTrue(answer["payment"]["valid"])
        with self.assertRaises(ValueError):
            Wavly.checkout_headers({"payment_token": None}, handle)
        self.assertIsNone(Wavly.merchant_info(BASE))
        self.assertEqual(admin.registry.retrieve(handle)["record"]["test"]["checks"], 2)
