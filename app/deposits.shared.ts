// Pure deposit-domain helpers with no server-only dependencies (no Prisma,
// no admin API client) - safe to import from client components. Anything
// that touches Prisma or the Shopify admin API belongs in deposits.server.ts
// instead.

/** Formats a minor-unit (cents) amount as a display string, e.g. 8 -> "€0.08". */
export function formatAmount(amount: number, currency: string = "EUR") {
  return new Intl.NumberFormat("de-DE", {
    style: "currency",
    currency,
  }).format(amount / 100);
}

/** Extracts the numeric id from a Shopify GID, e.g. "gid://shopify/Product/123" -> "123". */
export function idFromGid(gid: string) {
  return gid.split("/").pop()!;
}
