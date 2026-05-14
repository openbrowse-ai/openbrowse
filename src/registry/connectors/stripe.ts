import type { ConnectorDefinition, ToolResultLabel } from "./types";
import { parseToolResult } from "./types";

interface StripeListResult {
  object: "list";
  data: unknown[];
  has_more: boolean;
  url: string;
}

export const definition: ConnectorDefinition = {
  id: "stripe",
  name: "Stripe",
  icon: { light: "stripe.svg" },
  description: "Payments, subscriptions, and billing",
  category: "developer-tools",
  url: "https://mcp.stripe.com/mcp",
  auth: { type: "oauth" },
  docsUrl: "https://docs.stripe.com/mcp",
  formatLabel(toolName, result): ToolResultLabel | null {
    const parsed = parseToolResult<StripeListResult>(result);

    switch (toolName) {
      case "list_customers": {
        const count = Array.isArray(parsed?.data) ? parsed.data.length : null;
        return { pending: "Listing customers...", done: count != null ? `Listed ${count} customers` : "Listed customers" };
      }
      case "get_customer":
        return { pending: "Fetching customer...", done: "Fetched customer" };
      case "list_payments":
      case "list_payment_intents": {
        const count = Array.isArray(parsed?.data) ? parsed.data.length : null;
        return { pending: "Listing payments...", done: count != null ? `Listed ${count} payments` : "Listed payments" };
      }
      case "list_subscriptions": {
        const count = Array.isArray(parsed?.data) ? parsed.data.length : null;
        return { pending: "Listing subscriptions...", done: count != null ? `Listed ${count} subscriptions` : "Listed subscriptions" };
      }
      case "get_balance":
        return { pending: "Fetching balance...", done: "Fetched balance" };
      case "list_invoices": {
        const count = Array.isArray(parsed?.data) ? parsed.data.length : null;
        return { pending: "Listing invoices...", done: count != null ? `Listed ${count} invoices` : "Listed invoices" };
      }
      default:
        return null;
    }
  },
  details: {
    longDescription:
      "Connect Stripe to manage payments, subscriptions, and billing. Look up customers, view payment history, check subscription statuses, analyze revenue, and troubleshoot payment issues directly from the conversation.",
    developer: { name: "Stripe", url: "https://stripe.com" },
    tools: [
      "list_customers",
      "get_customer",
      "list_payments",
      "list_subscriptions",
      "get_balance",
      "list_invoices",
    ],
    links: [
      { label: "Documentation", url: "https://docs.stripe.com/mcp" },
      { label: "Privacy Policy", url: "https://stripe.com/privacy" },
    ],
  },
};
