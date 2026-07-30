import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

// Mandatory GDPR compliance webhooks - Shopify requires all three
// (customers/data_request, customers/redact, shop/redact) to share a single
// endpoint, declared via compliance_topics in shopify.app.toml. We hold no
// customer PII, so the customer topics are pure acknowledgements; SHOP_REDACT
// is the one that actually deletes our shop-level data.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  if (topic === "SHOP_REDACT") {
    await db.depositTier.deleteMany({ where: { shop } });
    await db.shopConfig.deleteMany({ where: { shop } });
  }

  return new Response();
};
