// A tiny shop for the framework examples. The menu says two shakes cost ₹475, but the cart adds ₹86 of fees, for ₹561.
// The partner listing pays a UPI ID the user never named.
export function createShop() {
  const carts = {
    cart_1: { store: "Demo Kitchen", upi_id: "demokitchen@okhdfc", items: "2 × Oreo shake", quoted_paise: 47500, total_paise: 56100 },
    cart_2: { store: "Shake Partner", upi_id: "shakepartner@okaxis", items: "2 × Oreo shake", quoted_paise: 39900, total_paise: 39900 },
  };
  const orders = [];
  return {
    carts, orders,
    async cart(cartId) { const c = carts[cartId]; if (!c) throw new Error("no cart " + cartId); return c; },
    async placeOrder(cartId) { await this.cart(cartId); const o = { order_id: "ord_" + (orders.length + 1), cart_id: cartId, status: "placed" }; orders.push(o); return o; },
  };
}

// What TheWavly checks: read from the shop's own cart, never from what the agent says it saw
export const cartPurchase = shop => async ({ cart_id }) => {
  const c = await shop.cart(cart_id);
  return { item: "Food order", amount_paise: c.total_paise, merchant: c.store, payee: c.upi_id };
};
