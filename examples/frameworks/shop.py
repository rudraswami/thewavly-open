"""A tiny shop for the Python framework examples: the menu says ₹475, the cart totals ₹561."""

CARTS = {
    "cart_1": {"store": "Demo Kitchen", "upi_id": "demokitchen@okhdfc", "quoted_paise": 47500, "total_paise": 56100},
    "cart_2": {"store": "Shake Partner", "upi_id": "shakepartner@okaxis", "quoted_paise": 39900, "total_paise": 39900},
}
ORDERS = []


def place_order(cart_id: str) -> dict:
    if cart_id not in CARTS:
        raise ValueError("no cart " + cart_id)
    order = {"order_id": "ord_%d" % (len(ORDERS) + 1), "cart_id": cart_id, "status": "placed"}
    ORDERS.append(order)
    return order


def cart_purchase(cart_id: str, **_) -> dict:
    """What TheWavly checks: read from the shop's own cart, never from what the agent says it saw."""
    c = CARTS[cart_id]
    return {"item": "Food order", "amount_paise": c["total_paise"], "merchant": c["store"], "payee": c["upi_id"]}
