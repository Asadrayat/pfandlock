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

/** Formats a past Date as a short relative label, e.g. "11 min ago", "2 h ago", "Yesterday". */
export function formatRelativeTime(date: Date, now: Date = new Date()) {
  const diffMinutes = Math.round((now.getTime() - date.getTime()) / 60_000);
  if (diffMinutes < 1) return "Just now";
  if (diffMinutes < 60) return `${diffMinutes} min ago`;

  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours} h ago`;

  const diffDays = Math.round(diffHours / 24);
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return `${diffDays} days ago`;

  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" }).format(date);
}
