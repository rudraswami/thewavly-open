"""TheWavly Guard with LangChain and LangGraph (langchain-core)."""
import os

from langchain_core.tools import tool
from thewavly import Wavly
from thewavly.guard import guard

import shop

wavly = Wavly(os.environ["WAVLY_API_KEY"], base_url=os.environ.get("WAVLY_BASE_URL", "https://thewavly.com"))


@tool
@guard(wavly, mandate=os.environ["WAVLY_MANDATE"], purchase=shop.cart_purchase,
       reference=lambda order, *a, **k: order["order_id"])
def place_order(cart_id: str) -> dict:
    """Place the order for a cart and pay for it."""
    return shop.place_order(cart_id)

# Use it:  create_react_agent(model, tools=[place_order])
