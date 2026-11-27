// TheWavly Guard with the Vercel AI SDK (package "ai"). The tool's execute is guarded, so the model cannot pay without a
// proceed from Wavly, whatever it was told.
import { tool } from "ai";
import { z } from "zod";
import { guardFunction } from "@thewavly/guard";
import { cartPurchase } from "./shop.mjs";

export function placeOrderTool({ wavly, mandate, shop }) {
  return tool({
    description: "Place the order for a cart and pay for it.",
    inputSchema: z.object({ cart_id: z.string().describe("The cart to order") }),
    execute: guardFunction(({ cart_id }) => shop.placeOrder(cart_id), {
      wavly, mandate, name: "place_order", purchase: cartPurchase(shop), reference: order => order.order_id,
    }),
  });
}

// Use it:  await generateText({ model, tools: { place_order: placeOrderTool({ wavly, mandate, shop }) }, stopWhen: stepCountIs(5), prompt })
