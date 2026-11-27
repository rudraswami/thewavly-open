// TheWavly Guard with LangChain.js and LangGraph (@langchain/core)
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { guardFunction } from "@thewavly/guard";
import { cartPurchase } from "./shop.mjs";

export function placeOrderTool({ wavly, mandate, shop }) {
  const pay = guardFunction(({ cart_id }) => shop.placeOrder(cart_id), {
    wavly, mandate, name: "place_order", purchase: cartPurchase(shop), reference: order => order.order_id,
  });
  // LangChain tools return text to the model, so the guarded result is sent as JSON
  return tool(async input => JSON.stringify(await pay(input)), {
    name: "place_order",
    description: "Place the order for a cart and pay for it.",
    schema: z.object({ cart_id: z.string().describe("The cart to order") }),
  });
}

// Use it:  createReactAgent({ llm, tools: [placeOrderTool({ wavly, mandate, shop })] })
