"""Tests for thewavly.guard: the payment function runs only when TheWavly says proceed, or after the user approves.

The live tests run when WAVLY_TEST_BASE_URL and WAVLY_TEST_KEY (a test key) are set.
"""
import asyncio
import inspect
import os
import sys
import time
import unittest
import urllib.request

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from thewavly import Wavly  # noqa: E402
from thewavly.guard import guard, checkout_headers, current_check  # noqa: E402

BASE, KEY = os.environ.get("WAVLY_TEST_BASE_URL"), os.environ.get("WAVLY_TEST_KEY")
CARTS = {"c1": {"store": "Demo Kitchen", "upi_id": "demokitchen@okhdfc", "total_paise": 56100},
         "c2": {"store": "Shake Partner", "upi_id": "partner@okaxis", "total_paise": 30000}}


def from_cart(cart_id: str, **_):
    c = CARTS[cart_id]
    return {"item": "Food order", "amount_paise": c["total_paise"], "merchant": c["store"], "payee": c["upi_id"]}


class Offline(unittest.TestCase):
    def test_keeps_the_signature_and_docstring_frameworks_read(self):
        @guard(object(), mandate="mdt_x", purchase=from_cart)
        def place_order(cart_id: str, note: str = "") -> dict:
            """Place the order for a cart and pay for it."""
            return {}
        self.assertEqual(place_order.__name__, "place_order")
        self.assertEqual(place_order.__doc__, "Place the order for a cart and pay for it.")
        self.assertEqual(list(inspect.signature(place_order).parameters), ["cart_id", "note"])

    def test_needs_a_mandate_from_configuration(self):
        with self.assertRaises(ValueError):
            guard(object(), mandate="", purchase=from_cart)
        with self.assertRaises(ValueError):
            guard(None, mandate="mdt_x", purchase=from_cart)

    def test_fails_closed_without_wavly(self):
        class Down:
            class checks:
                @staticmethod
                def create(body):
                    raise ConnectionError("network down")
        orders = []

        @guard(Down(), mandate="mdt_x", purchase=from_cart)
        def place_order(cart_id: str):
            orders.append(cart_id)
        self.assertEqual(place_order("c1")["decision"], "error")
        self.assertEqual(place_order("nope")["decision"], "error")
        self.assertEqual(orders, [])


@unittest.skipUnless(BASE and KEY, "set WAVLY_TEST_BASE_URL and WAVLY_TEST_KEY to run against a live TheWavly instance")
class Live(unittest.TestCase):
    def setUp(self):
        self.wavly = Wavly(KEY, base_url=BASE)

    def mandate(self, max_rupees):
        return self.wavly.mandates.create({"instruction": "Two shakes from Demo Kitchen, up to ₹%d" % max_rupees, "approved_by": "py_guard",
                                           "rules": {"items": ["Food order"], "max_amount_paise": max_rupees * 100, "payees": ["demokitchen@okhdfc"]}})["id"]

    def test_proceed_stop_and_ask_then_approve(self):
        orders = []

        @guard(self.wavly, mandate=self.mandate(600), purchase=from_cart, reference=lambda o, *a, **k: o["id"])
        def place_order(cart_id: str) -> dict:
            orders.append(cart_id)
            return {"id": "ord_%d" % len(orders)}
        ok = place_order(cart_id="c1")
        self.assertEqual(ok["id"], "ord_1")
        self.assertIn("/verify#", ok["wavly"]["verify_url"])
        self.assertEqual(self.wavly.checks.retrieve(ok["wavly"]["check_id"])["payment_reference"], "ord_1")
        self.assertEqual(place_order("c2")["decision"], "stop")
        self.assertEqual(orders, ["c1"])

        @guard(self.wavly, mandate=self.mandate(500), purchase=from_cart)
        def pay(cart_id: str) -> str:
            orders.append(cart_id)
            return "Paid"
        ask = pay("c1")
        self.assertEqual((ask["ordered"], ask["decision"]), (False, "ask"))
        self.assertEqual(pay("c1")["decision"], "ask")
        self.assertEqual(len(orders), 1)
        req = urllib.request.Request(ask["approval_url"], data=b"decision=approve", method="POST",
                                     headers={"Content-Type": "application/x-www-form-urlencoded"})
        with urllib.request.urlopen(req) as res:
            self.assertEqual(res.status, 200)
        self.assertRegex(pay("c1"), r"^Paid\n\nChecked by TheWavly before payment\. Proof for the user: .*/verify#")
        self.assertEqual(len(orders), 2)

    def test_async_functions_and_failures(self):
        @guard(self.wavly, mandate=self.mandate(600), purchase=from_cart)
        async def place_order(cart_id: str) -> str:
            return "Ordered " + cart_id
        self.assertTrue(asyncio.run(place_order("c1")).startswith("Ordered c1\n\nChecked by TheWavly"))
        self.assertEqual(asyncio.run(place_order("c2"))["decision"], "stop")

        seen = {}
        real = self.wavly.checks.create

        def spy(body, *a, **k):
            c = real(body, *a, **k)
            seen["id"] = c["id"]
            return c
        self.wavly.checks.create = spy

        @guard(self.wavly, mandate=self.mandate(600), purchase=from_cart)
        def broken(cart_id: str):
            raise RuntimeError("gateway down")
        with self.assertRaises(RuntimeError):
            broken("c1")
        self.assertEqual(self.wavly.checks.retrieve(seen["id"])["status"], "released")

    def test_checkout_headers_inside_the_guarded_call(self):
        from test_wavly import _keypair
        handle = "py-guard-%d" % int(time.time() * 1000 % 10 ** 9)
        self.wavly.registry.register({"handle": handle, "name": "Py Guard", "website": "py-guard.in"})
        jwk = _keypair("ed25519")
        self.wavly.registry.add_key(handle, {"jwk": {k: v for k, v in jwk.items() if k != "d"}})
        agent = Wavly(KEY, base_url=BASE, agent={"id": handle, "private_key": jwk})
        seen = {}
        self.assertIsNone(checkout_headers())

        @guard(agent, mandate=self.mandate(600), purchase=from_cart)
        def place_order(cart_id: str) -> dict:
            seen["headers"], seen["check"] = checkout_headers(), current_check()
            return {"id": "ord_py"}
        place_order("c1")
        self.assertEqual(seen["headers"]["Wavly-Agent"], handle)
        self.assertTrue(seen["check"]["agent_verification"]["registry"])
        answer = Wavly.verify_order(handle, seen["headers"]["Wavly-Payment-Token"], base_url=BASE)
        self.assertTrue(answer["payment"]["valid"] or answer["payment"]["status"] == "redeemed")
        self.assertIsNone(checkout_headers(), "the headers do not leak out of the call")

        @guard(agent, mandate=self.mandate(600), purchase=from_cart)
        async def place_async(cart_id: str) -> str:
            return checkout_headers()["Wavly-Agent"]
        self.assertTrue(asyncio.run(place_async("c1")).startswith(handle))


if __name__ == "__main__":
    unittest.main()
