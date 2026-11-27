"""TheWavly Guard for any agent framework: hold a payment or order function until TheWavly answers.

A TheWavly check the agent is told to make is advisory: an agent that has been talked into something can skip it. Guard
the function your tool calls to pay instead, and give the guarded function to LangChain, CrewAI, the OpenAI Agents SDK
or your own loop. The signature, type hints and docstring are kept, so frameworks build the same tool schema.

    from thewavly import Wavly
    from thewavly.guard import guard

    wavly = Wavly(os.environ["WAVLY_API_KEY"])

    def cart_purchase(cart_id: str):                     # read the real total from the shop, not the quote
        cart = shop.cart(cart_id)
        return {"item": "Food order", "amount_paise": cart.total_paise, "merchant": cart.store, "payee": cart.upi_id}

    @guard(wavly, mandate=os.environ["WAVLY_MANDATE"], purchase=cart_purchase, reference=lambda order, *a, **k: order["id"])
    def place_order(cart_id: str) -> dict:
        \"\"\"Place the order for a cart and pay for it.\"\"\"
        return shop.place_order(cart_id)

What happens on each call:

- proceed: the function runs; the outcome is reported to TheWavly with ``reference(result, *args, **kwargs)``. A string result
  gets the receipt link appended; a dict result gets a ``wavly`` key with it.
- ask: the function is not called. The agent gets the user's approval link; the same call goes through once they approve.
- stop: the function is not called.

When the function is not called, the guarded function returns ``{"ordered": False, "decision": ..., "message": ...}``
with ``check_id`` and ``approval_url`` where there are any. The mandate comes from your code, never from the agent's
arguments. Anything the Guard cannot read or check fails closed: nothing is ordered.
"""
from __future__ import annotations

import asyncio
import contextvars
import functools
import hashlib
import inspect
import json
import re
import time
from typing import Any, Callable, Dict, Optional

__all__ = ["guard"]
JSON = Dict[str, Any]


def _refusal(message: str, decision: str, check_id: Optional[str] = None, approval_url: Optional[str] = None) -> JSON:
    out: JSON = {"ordered": False, "decision": decision, "message": message}
    if check_id:
        out["check_id"] = check_id
    if approval_url:
        out["approval_url"] = approval_url
    return out


def _normalise(p: Any) -> Optional[JSON]:
    if not isinstance(p, dict):
        return None
    spec = dict(p)
    if "amount_paise" not in spec and "amount_rupees" in spec:
        try:
            spec["amount_paise"] = int(round(float(spec.pop("amount_rupees")) * 100))
        except (TypeError, ValueError):
            return None
    amount = spec.get("amount_paise")
    if not isinstance(spec.get("item"), str) or not spec["item"] or isinstance(amount, bool) or not isinstance(amount, int) or amount <= 0:
        return None
    return spec


class _Gate:
    """The decision for one purchase, remembering purchases the user is being asked about."""

    def __init__(self, wavly: Any, mandate: str, agent: Optional[str], name: str):
        self.wavly, self.mandate, self.agent, self.name = wavly, mandate, agent, name
        self.waiting: Dict[str, str] = {}

    def decide(self, purchase: JSON):
        """Returns (check, None) to go ahead, or (None, refusal)."""
        key = hashlib.sha256((self.name + "\n" + json.dumps(purchase, sort_keys=True)).encode()).hexdigest()
        try:
            if key in self.waiting:  # the same order again, after the user was asked
                c = self.wavly.checks.retrieve(self.waiting[key])
                answer = (c.get("approval") or {}).get("status")
                if answer == "approved" and c.get("status") == "held":
                    del self.waiting[key]
                    return c, None
                if answer == "pending":
                    url = c["approval"].get("url")
                    return None, _refusal("ASK FIRST: still waiting for the user's answer. Nothing was ordered. The approval link: %s" % url, "ask", c["id"], url)
                del self.waiting[key]
                return None, _refusal("STOP: the user did not approve this order (%s). Nothing was ordered. Do not retry." % (answer or c.get("status")), "stop", c["id"])
            body: JSON = {"mandate": self.mandate, "purchase": purchase}
            if self.agent:
                body["agent"] = self.agent
            c = self.wavly.checks.create(body)
            why = ", ".join(r.get("label") or re.sub(r"_paise$", "", r.get("field", "")) for r in c.get("results", []) if r.get("result") != "match")
            if c["decision"] == "proceed":
                return c, None
            if c["decision"] == "ask":
                self.waiting[key] = c["id"]
                url = (c.get("approval") or {}).get("url")
                return None, _refusal("ASK FIRST: this order goes beyond what the user approved (%s). Nothing was ordered. Send the user this link to approve or decline%s. Once they approve, make the same call again."
                                      % (why, ": " + url if url else ""), "ask", c["id"], url)
            return None, _refusal("STOP: this order is not what the user approved (%s). Nothing was ordered. Tell the user; do not retry." % why, "stop", c["id"])
        except Exception as e:  # fail closed: no answer from TheWavly means no order
            return None, _refusal("TheWavly could not check this order (%s), so it was not placed. Try again shortly." % str(e)[:120], "error")

    def report(self, check: JSON, ok: bool, reference: Any = None) -> None:
        try:
            if ok:
                ref = str(reference or "%s-%d" % (self.name, int(time.time() * 1000)))[:120]
                self.wavly.checks.report_outcome(check["id"], {"status": "paid", "payment_reference": ref})
            else:
                self.wavly.checks.report_outcome(check["id"], {"status": "failed"})
        except Exception:
            pass


_current: "contextvars.ContextVar[Optional[JSON]]" = contextvars.ContextVar("wavly_guard_current", default=None)


def checkout_headers() -> Optional[Dict[str, str]]:
    """Inside a guarded function: the headers to send a store that takes TheWavly (Wavly-Agent and Wavly-Payment-Token),
    or None when the client has no agent identity or the check carries no payment token."""
    cur = _current.get()
    return dict(cur["headers"]) if cur and cur.get("headers") else None


def current_check() -> Optional[JSON]:
    """Inside a guarded function: the TheWavly check that allowed this call."""
    cur = _current.get()
    return cur["check"] if cur else None


def _headers_for(wavly: Any, check: JSON, agent: Optional[str]) -> Optional[Dict[str, str]]:
    ident = (getattr(wavly, "agent", None) or {}).get("id") or agent
    if not ident:
        return None
    token = (check.get("payment_token") or {}).get("token")
    if not token:
        try:
            token = wavly.checks.payment_token(check["id"])["token"]
        except Exception:
            token = None
    return {"Wavly-Agent": ident, "Wavly-Payment-Token": token} if token else None


def _with_receipt(result: Any, check: JSON) -> Any:
    url = check.get("verify_url")
    if not url:
        return result
    if isinstance(result, str):
        return result + "\n\nChecked by TheWavly before payment. Proof for the user: " + url
    if type(result) is dict:
        return {**result, "wavly": {"decision": "proceed", "check_id": check["id"], "verify_url": url}}
    return result


def guard(wavly: Any, *, mandate: str, purchase: Callable[..., Any], reference: Optional[Callable[..., Any]] = None,
          agent: Optional[str] = None, name: Optional[str] = None) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
    """A decorator that holds a payment or order function until TheWavly answers. Works on sync and async functions.

    ``purchase(*args, **kwargs)`` receives the function's own arguments and returns the purchase to check: ``item`` and
    ``amount_paise`` (or ``amount_rupees``), and ideally ``merchant``, ``payee`` and ``terms``. Read it from your own
    systems where you can, so the check uses the real total rather than what the agent was quoted.
    """
    if wavly is None:
        raise ValueError("TheWavly Guard needs a TheWavly client")
    if not str(mandate or "").startswith("mdt_"):
        raise ValueError("TheWavly Guard needs the mandate id (mdt_…) from your configuration, never from the agent")
    if not callable(purchase):
        raise ValueError("TheWavly Guard needs purchase(*args, **kwargs), returning the purchase to check")

    def wrap(fn: Callable[..., Any]) -> Callable[..., Any]:
        gate = _Gate(wavly, mandate, agent, name or getattr(fn, "__name__", "payment"))

        def read(args: tuple, kwargs: dict) -> Any:
            try:
                return purchase(*args, **kwargs)
            except Exception as e:
                return _refusal("TheWavly Guard could not read this order (%s). Nothing was ordered." % str(e)[:120], "error")

        def unreadable() -> JSON:
            return _refusal("TheWavly Guard could not read the item and amount of this order. Nothing was ordered.", "error")

        def ref(result: Any, args: tuple, kwargs: dict) -> Any:
            try:
                return reference(result, *args, **kwargs) if reference else None
            except Exception:
                return None

        if inspect.iscoroutinefunction(fn):
            @functools.wraps(fn)
            async def guarded_async(*args: Any, **kwargs: Any) -> Any:
                raw = read(args, kwargs)
                if inspect.isawaitable(raw):
                    try:
                        raw = await raw
                    except Exception as e:
                        raw = _refusal("TheWavly Guard could not read this order (%s). Nothing was ordered." % str(e)[:120], "error")
                if isinstance(raw, dict) and raw.get("ordered") is False:
                    return raw
                spec = _normalise(raw)
                if spec is None:
                    return unreadable()
                check, refusal = await asyncio.to_thread(gate.decide, spec)
                if refusal:
                    return refusal
                headers = await asyncio.to_thread(_headers_for, wavly, check, agent)
                token = _current.set({"check": check, "headers": headers})
                try:
                    result = await fn(*args, **kwargs)
                except BaseException:
                    _current.reset(token)
                    await asyncio.to_thread(gate.report, check, False)
                    raise
                _current.reset(token)
                await asyncio.to_thread(gate.report, check, True, ref(result, args, kwargs))
                return _with_receipt(result, check)
            return guarded_async

        @functools.wraps(fn)
        def guarded(*args: Any, **kwargs: Any) -> Any:
            raw = read(args, kwargs)
            if isinstance(raw, dict) and raw.get("ordered") is False:
                return raw
            spec = _normalise(raw)
            if spec is None:
                return unreadable()
            check, refusal = gate.decide(spec)
            if refusal:
                return refusal
            token = _current.set({"check": check, "headers": _headers_for(wavly, check, agent)})
            try:
                result = fn(*args, **kwargs)
            except BaseException:
                gate.report(check, False)
                raise
            finally:
                _current.reset(token)
            gate.report(check, True, ref(result, args, kwargs))
            return _with_receipt(result, check)
        return guarded

    return wrap
