// TheWavly Guard with the OpenAI Agents SDK for JavaScript (@openai/agents)
import { tool } from "@openai/agents";
import { z } from "zod";
import { guardFunction } from "@thewavly/guard";
import { cartPurchase } from "./shop.mjs";

export function placeOrderTool({ wavly, mandate, shop }) {
  return tool({
    name: "place_order",
    description: "Place the order for a cart and pay for it.",
    parameters: z.object({ cart_id: z.string() }),
    execute: guardFunction(({ cart_id }) => shop.placeOrder(cart_id), {
      wavly, mandate, name: "place_order", purchase: cartPurchase(shop), reference: order => order.order_id,
    }),
  });
}

// Use it:  new Agent({ name: "Shopper", tools: [placeOrderTool({ wavly, mandate, shop })] })
