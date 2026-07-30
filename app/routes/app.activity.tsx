import { authenticate } from "app/shopify.server";
import { LoaderFunctionArgs } from "react-router";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};
export default function Tiers() {
  return (
    <s-page heading="Deposit amounts">
      <s-section>
        <s-paragraph>Coming soon.</s-paragraph>
      </s-section>
    </s-page>
  );
}
