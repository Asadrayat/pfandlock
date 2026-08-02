# Pfandlock — Pre-Production Blueprint

**Revision 2 — verified against the working tree on 2026-08-03.** Target: fully functional, honest, demo-ready on `asad-app-dev`. Billing and hosting deferred.

**On line references:** every path and line range below was read in the tree at revision time. Where a task moves code, downstream references drift — trust the symbol name over the number.

**Effort totals:** P0 ≈ 3.5h · P1 ≈ 17h · P2 ≈ 16.5h · P3 ≈ 8h · Extras ≈ 11h. **≈ 56h ≈ 7–8 working days.**

---

## 0. What revision 1 got wrong

Revision 1 was written from a read-only audit and carried nine unverified assumptions. Seven have now been checked against the code, the Shopify schemas committed in this repo, and shopify.dev. The corrections change the priority order, so they come first.

| Rev 1 claim | Verified result | Effect |
|---|---|---|
| "Every non-EUR customer is blocked at checkout. Sev-1." | **False.** The validation function's currency comparison is between two *stored* values — the product's `$app:pfand` metafield and the tier's `currency` (`cart_validations_generate_run.ts:45`). Neither is presentment-converted. A USD shopper on a EUR store hits no mismatch. | The Sev-1 disappears. P1 is a correctness-and-merchant-experience phase, not an outage response. |
| "Validation does a per-unit required-vs-actual money comparison." | **False.** No money comparison exists anywhere in that function. It does orphan detection plus a cart-global deposit *count* balance (`:63-69`). | The task "replace the money backstop" had no target. Replaced by §6.7, which hardens a real (smaller) hole. |
| "The cart transform may pass a `price` override into `lineExpand`." | **No override.** `cart_transform_run.ts:51-59` sends only `merchandiseId` and `quantity`. The schema does expose `ExpandedItem.price` (`schema.graphql:2932`), and the code correctly declines it, so the deposit variant's own price applies and Markets converts it. | The multi-currency charge premise holds. Gating question resolved: proceed. |
| "`deposit_tiers` probably lacks `variantId`." | **Already present.** `syncDepositTiersMetafield` writes `{amount, currency, variantId}` (`deposits.server.ts:200-205`), and both functions read it. | P1-2 shrinks to `version`, root `currency`, and `active`. |
| "Commit `da9c902 'single currency'` conflicts with the code." | The message is the inverse of the change. It **added** multi-currency: `ShopConfig.supportedCurrencies`, `detectSupportedCurrencies`, and the tier form's currency `<s-select>`. | Open question 3 closed. The feature it added is the thing P1 removes — see §6.1. |
| "`read_orders` may already be in scope." | **Not in scope.** `shopify.app.toml:15` is `write_products,write_cart_transforms`. | P2-2 forces a scope re-grant and reinstall on the dev store. Confirmed, not conditional. |
| "The migration truncation flag may not reach the UI." | **It reaches it.** `app.migration.tsx:166` renders a warning banner for the export, `:273` for the import preview. | P3-3 drops from a task to a copy tweak. |
| "The storefront notice states the amount only." | **It already says refundable** and already routes through a translation key: `deposit_notice.text` = "Includes a {{ amount }} refundable Pfand deposit, charged at checkout." | X-4 shrinks to the German default plus block settings. |
| "The Activity page shows hardcoded blocked/recovered metrics." | **Mostly already honest.** Blocked and recovered render `—` with the platform-limitation caption (`app.activity.tsx:43-57`), and the unobservability note is already on the page (`:114-121`). Only the Errors tile hardcodes `0` (`:76`). | P0-4 shrinks from 1h to 15 minutes. |

Two things revision 1 missed entirely are now P1-2 and P1-3. Both are merchant-facing.

---

## 1. Verified baseline

Everything below was run in this tree, under bash, at revision time.

| Gate | Command | Result |
|---|---|---|
| App unit tests | `npx vitest run` | **173 pass** (164 domain + 9 theme-block contract) |
| Cart transform | `pnpm run test:extensions` | **21 pass** (13 unit + 8 wasm fixtures) |
| Checkout validation | `pnpm run test:extensions` | **28 pass** (17 unit + 11 wasm fixtures) |
| Types | `npx tsc --noEmit` | **clean** |
| Lint | `npx eslint --ignore-path .gitignore .` | **clean** |
| CI | `.github/workflows/test.yml` | present; runs all five gates on push to `main` and on PRs |

So the "run the suites, they haven't executed this session" item in revision 1's P0-1 is done. What remains of P0-1 is the commit itself.

**Working tree:** two files modified and uncommitted — `extensions/deposit-notice/blocks/deposit-notice.liquid` and its test. Both hold the `$app` namespace fix and are one `git checkout` from loss.

**Bundling defect confirmed:** `.shopify/dev-bundle/edcc817c…/tests/deposit-notice.test.ts` exists. Test source is being uploaded to storefronts today.

---

## 2. The currency model — what is actually true

This section replaces revision 1's Branch A / Branch B framing. The branch mattered only because of the phantom outage; with that gone, the platform rules decide the architecture regardless of how `asad-app-dev` is configured.

### 2.1 Three platform facts

1. **A `money` metafield's currency must be the store's currency.** shopify.dev, list of metafield data types: *"A numeric amount, with a currency code that matches the store's currency."* The `$app:pfand` field is declared `type = "money"` in `shopify.app.toml:18`, so Shopify validates every write against it.
2. **Variant prices are denominated in the store's currency.** Markets converts to presentment at read time. There is no way to give one variant a price in a currency other than the store's base.
3. **Metafields are market-localizable** (`MarketLocalizableResourceType.METAFIELD`), so a merchant *can* register a per-market override for `$app:pfand` through the Translate & Adapt app. Whether a Function's input query returns the market-localized value or the base value is not documented — see open question 1.

### 2.2 The defect these facts expose

`da9c902` added a currency dropdown to the tier form (`app.tiers.tsx:280-293`), populated from `enabledPresentmentCurrencies`. A merchant on a EUR store with USD enabled can therefore create a "USD 0.08" tier. What happens:

- `createDepositTier` prices the backing variant `(amount / 100).toFixed(2)` with no currency (`deposits.server.ts:304, 310`) — so the variant is priced **€0.08**, not $0.08 (fact 2).
- The variant's option value is `formatAmount(8, "USD")` → **`0,08 $`**. The merchant now has a variant labelled in dollars, priced in euros.
- The merchant then tries to assign it to a product. `setProductDeposit` writes `currency_code: "USD"` into a `money` metafield on a EUR store (`deposits.server.ts:776-779`) — **Shopify rejects it** (fact 1). The assign page surfaces Shopify's raw validation error.

So the currency selector leads the merchant to build a tier that is mispriced, mislabelled, and impossible to use, and the failure surfaces two pages later in Shopify's words rather than the app's. Nothing is charged wrongly — no product can ever carry a non-base amount, which is exactly why the phantom "non-EUR block" cannot occur — but the merchant experience is a dead end with a confusing error at the end of it.

**The fix is to delete the choice, not to validate it.** German Pfand is statutory in euros; a per-market deposit amount is a legally wrong deposit. One denomination per shop, always the shop's own. That is §6.4 and §6.5.

### 2.3 What multi-market shops still get

Everything that matters, without the merchant configuring anything:

- The deposit variant is priced in base currency; Markets converts it for the shopper.
- The checkout validation matches on **variant identity**, which is currency-invariant.
- The storefront notice renders the amount through Liquid's `money` filter, which formats in the shopper's presentment currency.

A USD shopper on a EUR store is charged the converted equivalent of €0.25 and sees it in dollars. That is the correct behaviour and it needs no per-market data.

---

## 3. Metafield contract (canonical — referenced everywhere downstream)

### 3.1 Product metafield — `$app:pfand`

**Unchanged.** Type `money`, declared in `shopify.app.toml:17-25`, always in the shop's base currency (forced by §2.1 fact 1).

```json
{ "amount": "0.08", "currency_code": "EUR" }
```

One product carries exactly one deposit. No per-market amount, deliberately.

### 3.2 Shop metafield — `$app:deposit_tiers`

**Changed.** `variantId` is already there; three things are missing.

**Current (v1, verified at `deposits.server.ts:199-205`):**
```json
[ { "amount": 8, "currency": "EUR", "variantId": "gid://shopify/ProductVariant/44011" } ]
```

**Target (v2):**
```json
{
  "version": 2,
  "currency": "EUR",
  "tiers": [
    { "amount": 8,  "variantId": "gid://shopify/ProductVariant/44011", "active": true  },
    { "amount": 25, "variantId": "gid://shopify/ProductVariant/44012", "active": false }
  ]
}
```

**Rules:**

- `amount` — integer, minor units, base currency. `8` = €0.08.
- `currency` — the shop's base currency, once at the payload root. Not per tier. Kept for readability and for a future base-currency-change detector; no code branches on it.
- `variantId` — full GID of the backing variant. **The identity key both Functions match on.**
- `active` — replaces the current behaviour of omitting inactive tiers entirely. See §3.3; this is the substantive change.
- `version` — Functions read it and fail closed on an unknown value rather than mis-parsing.

### 3.3 Why deactivated tiers must stay in the payload

`syncDepositTiersMetafield` calls `listDepositTiers`, which filters `active: true` (`deposits.server.ts:42-47, 171`). Deactivating a tier therefore removes its `variantId` from the Functions' view of the world. Trace what a live cart does next:

1. Shopper has product A (`pfand` = €0.25) in the cart, expanded with deposit variant V25.
2. Merchant deactivates the €0.25 tier.
3. Validation runs. V25 is no longer in `depositVariantIds`, so the deposit line falls through to the product branch, finds no `pfand` metafield, and is skipped — it does not count toward `actualDeposits`.
4. Product A still has its metafield, still finds no matching tier, and raises the orphan error.
5. Checkout is blocked, with a message telling the shopper to contact the store.

The app tells the merchant this will happen (`app.tiers.tsx:239-248`), so it is documented rather than hidden. It is still the wrong shape: a routine admin action silently breaks checkout for every cart holding that amount, across the whole store, with no undo prompt and no count of what it will affect.

**The v2 design splits the two readers:**

| Reader | Reads | Rationale |
|---|---|---|
| Cart transform | `active: true` only | A deactivated deposit must stop being charged on *new* carts — that is what deactivation means. |
| Checkout validation, deposit-variant recognition | **all** tiers | A deposit line already in a cart must still be recognised as a deposit, so a shopper mid-checkout is not blocked by a change they had no part in. |
| Checkout validation, orphan detection | `active: true` only | A product still assigned a retired amount genuinely is misconfigured, and must be caught. |

That combination lets a live cart complete while still flagging the merchant's real configuration problem. It does not on its own stop the merchant from creating that problem — §6.3 does.

### 3.4 Consequence for validation

Money comparison — which never existed — is not what changes. What changes is that tier lookup and deposit-line recognition both key on `variantId` rather than on `amount + currency`, which makes them currency-invariant by construction and closes the substitution hole in §6.7.

---

## 4. `DepositEvent` schema + webhook topics

### 4.1 Prisma model

```prisma
enum DepositEventType {
  CHARGED
  REFUNDED
  CANCELLED
}

model DepositEvent {
  id                     String           @id @default(cuid())
  shop                   String
  type                   DepositEventType

  orderId                String           // numeric portion of the order GID
  orderName              String?          // "#1001" — display only
  lineItemId             String?

  depositTierId          String?          // nullable so history survives tier deletion
  variantId              String           // deposit variant GID — the join key to a tier

  amountMinor            Int              // per-unit, base currency, minor units
  currency               String           // base currency at time of event
  quantity               Int

  presentmentAmountMinor Int?             // per-unit as actually charged
  presentmentCurrency    String?

  webhookId              String           @unique   // X-Shopify-Webhook-Id — idempotency
  occurredAt             DateTime                   // from payload, not receipt time
  createdAt              DateTime         @default(now())

  @@index([shop, occurredAt])
  @@index([shop, type])
  @@index([shop, variantId])
  @@index([shop, orderId])
}
```

**Design notes:**

- **No customer identifiers.** No email, no customer ID, no address. Keeps `customers/redact` a genuine no-op and confines GDPR to `shop/redact`. `orderId` is weakly linkable — accepted, and documented in the handler.
- `webhookId @unique` is the idempotency guard. Shopify redelivers; the insert collides and is swallowed.
- Both base and presentment amounts stored. Merchant reporting uses base (comparable across markets); support questions use presentment (what the shopper actually paid). Under §2 the base amount is the only one the merchant configured, so it is the honest reporting unit.
- `depositTierId` nullable, `variantId` always present — reporting joins on `variantId`, so history survives tier churn.
- Totals are **derived by aggregation**, never stored as counters. No drift.

### 4.2 Webhook topics

| Topic | Handler does | Emits | Notes |
|---|---|---|---|
| `orders/create` | Scan line items for variant IDs present in `deposit_tiers` (§3.2). One row per matched line. | `CHARGED` | Primary write path. |
| `refunds/create` | `refund_line_items[]` carries `line_item.variant_id` and `quantity`. Match deposit variants. | `REFUNDED` | Fires for manual and API refunds alike — this is what makes the manual path (§8) observable. |
| `orders/cancelled` | Emit per deposit line regardless of whether the cancellation refunded. | `CANCELLED` | Prevents cancelled orders inflating "collected". |
| `orders/updated` | **Not subscribed.** | — | Noisy; order edits are rare and out of scope (§11). |
| `app/uninstalled`, `app/scopes_update` | Existing (`shopify.app.toml:39-45`). | — | Unchanged. |
| `shop/redact` | Existing (`webhooks.compliance.tsx:16-19`) **+ add** `DepositEvent.deleteMany({shop})`. | — | Task P2-9. |
| `customers/redact`, `customers/data_request` | Existing. | — | No-op by design; no customer PII stored. |

### 4.3 The scope gate — verified

`shopify.app.toml:15` is `scopes = "write_products,write_cart_transforms"`. `read_orders` is absent, so P2-2 triggers a scope re-grant: the merchant must reauthorize, and on `asad-app-dev` that means reinstalling. Do it at the start of P2, not the end.

`read_orders` also brings the app under Shopify's **protected customer data** requirements. Per shopify.dev: development stores need no approval, so P2 is fully buildable and testable now; approval is required only when the app is submitted for distribution. If it were ever denied, unapproved *fields* are redacted (null, with an error in the `errors` hash) — whole webhooks are not withheld. Since `DepositEvent` stores no customer fields at all, this app requests Level 1 and the redaction risk is nil. Note it in the App Store checklist; it does not block pre-production.

---

## 5. Phase 0 — Stop lying

### P0-1 · Land the `$app` namespace fix

**Goal:** get the tree clean; the storefront notice fix is uncommitted.

**Files:** `extensions/deposit-notice/blocks/deposit-notice.liquid`, `extensions/deposit-notice/tests/deposit-notice.test.ts`

**Change:** commit as-is. The fix replaces `metafields.app.pfand` with `metafields["$app"].pfand` (`deposit-notice.liquid:13`). Dot syntax resolves a namespace literally named `"app"`, which does not exist — the declarative `[product.metafields.app.pfand]` block declares the field under the reserved `$app` namespace. The old form was always `nil` and the notice silently never rendered on any product. Both Functions already used `namespace: "$app"` correctly.

**Acceptance:** `git status` clean. All five gates already verified green (§1) — re-run after the commit to confirm nothing drifted.

**Test:** on `asad-app-dev`, open a product with an assigned deposit → notice renders. Open one without → block absent, no Liquid error.

**Effort:** 0.5h · **Risk:** none · **Blocks:** everything · **Depends on:** —

---

### P0-2 · Move theme-extension tests out of the extension root

**Goal:** stop uploading test source to merchant storefronts.

**Files:** `extensions/deposit-notice/tests/` → `extensions/deposit-notice.tests/` (sibling, outside the extension root). Update `vitest.config.ts:16` (`include`) and the test's relative path constants.

**Change:** theme app extensions permit exactly four directories — `assets/`, `blocks/`, `snippets/`, `locales/`. `tests/` is none of them and is confirmed bundled: `.shopify/dev-bundle/edcc817c-0c35-78e0-a7ad-0637c6b35d519e1a4812/tests/deposit-notice.test.ts`.

**Acceptance:** `pnpm run dev`, then inspect the fresh bundle directory — no `tests/`. The 9 contract tests still run and pass under `npx vitest run`.

**Effort:** 0.5h · **Risk:** low — path config only · **Depends on:** P0-1

---

### P0-3 · Replace the hardcoded dashboard tiles

**Goal:** the dashboard asserts four numbers it does not have.

**Files:** `app/routes/app._index.tsx:63` (`€0.00` collected), `:71` (`0` units), `:81` (`€0.00` refunded), `:90` (`0` blocked)

**Change:** replace the four-tile grid with one bordered empty state until P2-6 lands.

The blocked-checkouts tile is the worst of the four and needs different handling from the other three: `0` is not "no data yet", it is an assertion about something Shopify structurally never reports (`deposits.server.ts:1368-1378`). Do not carry it forward into the empty state as "coming soon" — it is not coming. Point at the Activity page, which already words this correctly (`app.activity.tsx:114-121`).

> **EN:** "Reporting isn't available yet. Deposit charges and refunds will appear here once order tracking is switched on. Blocked checkouts can't be counted — Shopify doesn't report checkout validation outcomes back to apps."
> **DE:** "Auswertungen sind noch nicht verfügbar. Pfandbuchungen und Erstattungen erscheinen hier, sobald die Auftragsverfolgung aktiviert ist. Blockierte Bestellvorgänge können nicht gezählt werden — Shopify meldet Ergebnisse der Checkout-Prüfung nicht an Apps zurück."

Config and coverage on this page are real — **leave them.** The "Deposits collected" section at `:98-103` and the "Recent activity" aside at `:188-193` are already honest empty states; leave those too.

**Acceptance:** no monetary or count figure on the dashboard that isn't derived from real data. Place a test order with a deposit → still the empty state, not a wrong number.

**Effort:** 1h · **Risk:** none · **Depends on:** — · **Superseded by:** P2-6

---

### P0-4 · Fix the Activity errors tile

**Goal:** the one remaining literal on an otherwise honest page.

**Files:** `app/routes/app.activity.tsx:76`

**Change:** blocked (`:43`) and recovered (`:54`) already render `—` with correct captions, and the platform-limitation note is already in the aside (`:114-121`). Only Errors hardcodes `0` under "No errors logged yet" — which reads as "we checked", when nothing is logged anywhere. Change the value to `—` and the caption to "Not tracked yet". Becomes real in P2-8.

**Keep** the unobservability note verbatim. It is the most valuable copy on the page.

**Acceptance:** no metric on the page is a hardcoded literal. The note stays visible, not tucked in a tooltip.

**Effort:** 0.25h · **Risk:** none · **Depends on:** — · **Partially superseded by:** P2-8

---

### P0-5 · Drop the placeholder tier columns

**Goal:** three of the tier table's five columns are em-dashes on every row.

**Files:** `app/routes/app._index.tsx:116-118` (headers), `:134-142` (cells)

**Change:** remove Units / Collected / Refunded until P2-7. A two-column table of real data beats a five-column table that is 60% placeholder.

**Acceptance:** the tier table contains only columns backed by real data (amount + label, applies-to count).

**Effort:** 0.5h · **Risk:** none · **Depends on:** — · **Superseded by:** P2-7

---

### P0-6 · Correct stale in-repo documentation

**Goal:** three comments describe a system that no longer exists. They will mislead the next reader, and one of them is in the schema.

**Files:** `prisma/schema.prisma:68` (says product assignment lives on `custom.pfand`; it is `$app:pfand`), `app/routes/app.products._index.tsx:22-23` (commented-out `console.log` and stray blank lines), `app/routes/app._index.tsx:1-8` (header comment references a `pfand-app-ui.html` design file not present in the repo — either restore the file or drop the reference).

**Effort:** 0.5h · **Risk:** none · **Depends on:** —

---

## 6. Phase 1 — Currency model and tier lifecycle

Rationale in §2. This phase makes the deposit model match what the platform actually permits, and fixes the two merchant-facing lifecycle problems the audit missed.

### P1-1 · Store-side verification

**Goal:** three questions that only `asad-app-dev` can answer. Everything the code could answer has been answered (§0).

**Files:** read-only — Shopify admin.

| # | Question | Why it matters |
|---|---|---|
| 1 | How many presentment currencies are enabled? (Settings → Markets) | Decides whether X-3b's per-market warning ships at all, and whether the USD-presentment checkout test in §10 is runnable. |
| 2 | Does a `lineExpand` succeed against a variant on a `DRAFT` product? | X-3a hinges on it. If not, fall back to ACTIVE-but-unpublished. |
| 3 | Does the current theme expose a cart-line block target? | Decides whether X-4's cart placement is buildable or product-page-only. |
| 4 | How many products are on the store? | Under 50, P3-1 and P3-2 can't be meaningfully verified without seeding a catalogue. |

**Acceptance:** written answers to all four. No code changed.

**Effort:** 1h · **Risk:** none · **Depends on:** P0-1

---

### P1-2 · Metafield payload v2

**Goal:** give both Functions a versioned contract that distinguishes active from retired tiers. Shape in **§3.2**, reader split in **§3.3**.

**Files:** `deposits.server.ts:170-218` (`syncDepositTiersMetafield` — must read `listAllDepositTiers`, not `listDepositTiers`); the `DepositTierConfig` interface in **both** `extensions/*/src/*.ts`; all 19 wasm fixtures.

**Change:** four things move together or the Functions break — the writer, both reader interfaces, and every fixture. Do this task alone; get all suites green before starting P1-3.

Failure behaviour on an unrecognised `version`:

- **Checkout validation** — fail closed. Block with the generic misconfiguration message. Never let an unparseable config wave a cart through.
- **Cart transform** — expand nothing and return `NO_CHANGES`. It must not throw: `cartTransformCreate` is registered with `blockOnFailure: true` (`app.settings.tsx:31`), so an exception blocks every checkout on the store, not just deposit-bearing ones. Expanding nothing produces an orphan, which validation then catches with a message the shopper can act on.

**Verified:** only `asad-app-dev` holds data and the app has never been deployed publicly, so a one-off resync covers migration and no v1 fallback reader is needed. If another shop installs before this ships, add the fallback instead.

**Acceptance:**
- The `deposit_tiers` metafield on the dev store matches §3.2 exactly, deactivated tiers included with `active: false`.
- All 19 fixtures updated and passing.
- A hand-edited `version: 99` payload → checkout blocks, transform expands nothing, no exception in Function logs.

**Test:** `pnpm run test:extensions`; then edit the shop metafield in admin to bump `version`, attempt checkout, restore.

**Effort:** 2.5h · **Risk:** 🔴 **High.** A malformed payload orphans every product store-wide, and `blockOnFailure: true` means a transform exception blocks all checkouts. Verify the written payload in admin before touching checkout. · **Depends on:** P1-1

---

### P1-3 · Guard tier deactivation against in-use amounts

**Goal:** stop a routine admin action from silently blocking checkout store-wide. Mechanism in **§3.3**.

**Files:** `deposits.server.ts:478-498` (`setDepositTierActive`), `app/routes/app.tiers.tsx:83-106` (the deactivate intent) and `:239-248` (the warning that currently substitutes for a guard)

**Change:** before deactivating, count the products still carrying that amount — the same `$app:pfand` scan `getDashboardSummary` already runs (`deposits.server.ts:687`). Then:

- **Zero products** — deactivate immediately, no friction. This is the common case and must stay one click.
- **One or more** — do not deactivate. Return the count and a link to a filtered product list, and say plainly what deactivating would do.

> **EN:** "{n} products still use this deposit amount. Deactivating it now would block checkout for every cart containing them. Reassign those products first."
> **DE:** "{n} Produkte verwenden diesen Pfandbetrag noch. Eine Deaktivierung würde den Checkout für alle Warenkörbe mit diesen Produkten blockieren. Weisen Sie diesen Produkten zuerst einen anderen Betrag zu."

Deliberately a hard block, not a confirmation dialog. The consequence is invisible to the merchant (it manifests in shoppers' carts, and §0 confirms the app cannot observe blocked checkouts) so a merchant who clicks through gets no feedback that anything broke. When there is no way to detect the mistake, do not allow it.

Product counts here come from the same capped scan as the dashboard — see P3-2. Until that is fixed, label the count as covering the first 250 products, and let the guard fire on a non-zero count rather than trusting it to be exhaustive.

**Acceptance:** deactivating an unused amount still takes one click. Deactivating an amount used by 3 products is refused with the count and a working link. Reassigning all 3 then makes deactivation succeed. A direct POST bypassing the UI is refused identically — the guard lives in `setDepositTierActive`, not the route.

**Effort:** 3h · **Risk:** medium — changes an existing merchant flow; needs a clear path out, not just a wall · **Depends on:** P1-2

---

### P1-4 · Remove the currency selector

**Goal:** delete the dead end documented in **§2.2**.

**Files:** `app/routes/app.tiers.tsx:280-293` (the `<s-select>`), `:113-116` (form parsing), `:156-170` (the `currency` state and its DOM listener), `:186` and `:203` (the Currency table column); `deposits.server.ts:249-271` (`createDepositTier`'s `currency` parameter and the `supportedCurrencies` check)

**Change:** replace the select with static text stating the shop's currency. Server-side, derive the currency from the shop rather than the form, and reject a submitted currency instead of honouring it — the action is reachable by direct POST.

> **EN:** "Deposits are charged in {EUR}, your store's currency. Customers in other markets see the converted amount automatically."
> **DE:** "Das Pfand wird in {EUR} berechnet, der Währung Ihres Shops. Kundinnen und Kunden in anderen Märkten sehen automatisch den umgerechneten Betrag."

`detectSupportedCurrencies` and `ShopConfig.supportedCurrencies` stay: the *first* entry is the shop's own currency (`deposits.server.ts:117`), which is exactly what this task needs, and the rest drives X-3b. Reduce the tier-creation check from "is this currency in the list" to "is this currency the shop's currency", and keep the graceful degradation already in the loader (`app.tiers.tsx:36-52`) — if Shopify can't be reached, fall back to the stored value rather than taking the page down.

**Acceptance:** no currency control on the page. A forged POST with `currency=USD` either creates a EUR tier or 400s — never a USD tier. An existing non-base-currency tier, if any exists on the dev store, still renders in the table and can still be deactivated.

**Effort:** 1.5h · **Risk:** low · **Depends on:** P1-2

---

### P1-5 · Collapse the tier unique key

**Goal:** one denomination per shop; `[shop, amount, currency]` → `[shop, amount]`.

**Files:** `prisma/schema.prisma:97`, new migration; `deposits.server.ts:222-235` (the `isUniqueConstraintError` comment), `:286-295` (the duplicate pre-check), `:511-526` (`resolveDepositStatus`), `:946` (`tierKey`), `:1065-1090` (migration import keying)

**Change:** drop `currency` from the composite unique. **Keep the column**, populated with base currency — dropping a column is a one-way door and the value is worth retaining for audit. Back up the dev DB first.

If the dev store holds two tiers at the same `amount` under different currencies, the migration will fail on the new index. Dedupe first: keep the base-currency row, soft-deactivate the rest. Check before writing the migration:

```sql
SELECT shop, amount, count(*) FROM "DepositTier" GROUP BY shop, amount HAVING count(*) > 1;
```

Simplify `resolveDepositStatus` and `tierKey` to key on `amount` alone once the constraint allows it — leaving the currency in the comparison keeps the fiction alive in three more places.

**Migration export compatibility:** the export payload is `version: 1` and carries a per-tier `currency` (`deposits.server.ts:799-811`). Keep reading and writing that field — bumping the export version is not worth it — but on import, validate each tier's currency against the destination shop's currency and refuse a cross-currency import with a clear message rather than creating tiers that cannot be assigned.

**Acceptance:** `pnpm exec prisma migrate dev` clean. Creating two tiers at the same amount → P2002 → the existing friendly duplicate message still appears. Importing a EUR configuration into a EUR store still works; importing it into a USD store is refused with an explanation.

**Effort:** 1.5h · **Risk:** medium — schema migration · **Depends on:** P1-4

---

### P1-6 · Fix hardcoded locales in the shared formatters

**Goal:** every money and date string in the admin is rendered in German regardless of who is looking.

**Files:** `app/deposits.shared.ts:9` (`Intl.NumberFormat("de-DE", …)`), `:32` (`Intl.DateTimeFormat("en-GB", …)`)

**Change:** format with the merchant's admin locale and the shop's base currency code. The two hardcodes disagree with each other today — money is German, dates are British — so whichever locale a merchant is actually in, at least one is wrong.

`Session.locale` exists on the Prisma model (`schema.prisma:29`) and is populated by the Shopify session for online tokens. Confirm it is present for this app's session type before relying on it; if it is empty, fall back to `shop.primaryLocale` from the Admin API, and only then to the locale implied by the base currency. Do not leave a hard pin.

**Careful with the blast radius:** `formatAmount` is also used to generate deposit **variant option values** (`deposits.server.ts:281, 306, 350`). Those strings are persisted on Shopify and are matched by exact string to find the newly created variant (`:368-370`). If the admin locale changes between two tier creations, that lookup breaks and `createdVariant` is `undefined`. Split the concerns: a locale-aware `formatAmount` for display, and a separate stable formatter for the variant option value. X-2 replaces that string anyway — do the split here and let X-2 choose the final form.

**Acceptance:** EUR tier, German admin → `0,08 €`. Same shop, English admin → `€0.08`. Relative timestamps follow the same locale. Creating a tier from an English admin session and then another from a German one produces two working tiers, both found correctly by the variant read-back.

**Effort:** 1.5h · **Risk:** medium — the variant-lookup coupling is the trap, not the formatting · **Depends on:** P1-5

---

### P1-7 · Per-line variant identity in checkout validation

**Goal:** close the deposit-substitution hole. Honest framing: this is hardening, not an outage fix.

**Files:** `extensions/deposit-checkout-validation/src/cart_validations_generate_run.ts`, `src/cart_validations_generate_run.graphql`

**The actual weakness.** Validation balances deposit units **cart-wide** (`:63-69`): total deposit-variant quantity versus total deposit-requiring quantity. It never checks *which* deposit belongs to *which* product. A cart holding a €0.25 product plus a €0.08 deposit variant balances at 1 = 1 and passes, having paid €0.08 for a €0.25 obligation.

**How reachable is it, honestly.** The cart transform re-derives the expansion from the parent line on every cart read, so a component the client strips is normally re-added server-side. This is defense-in-depth against a state the platform should not produce — a transform that has not yet run, a bug, or an Ajax Cart API sequence that desyncs. The existing code comment (`:57-62`) says as much. It is worth fixing because the fix is small, permanent, and removes a whole class of reasoning about whether the platform guarantee holds; it is not worth treating as an incident.

**The change.** The input schema exposes the nested-line relationship: `CartLine.parentRelationship: CartLineParentRelationship` → `parent: CartLine` (`schema.graphql:404, 454-459`). Add it to the input query, then for each deposit-variant line resolve its parent, read the parent's `$app:pfand`, look up the tier by amount, and assert the deposit line's merchandise ID equals that tier's `variantId` and its quantity matches the parent's.

```ts
// today — cart-global
if (actualDeposits !== requiredDeposits) block();

// target — per line
const tier = tiersByAmount.get(parentAmountMinor);
if (!tier) blockOrphan();
else if (depositLine.merchandise.id !== tier.variantId) blockMismatch();
else if (depositLine.quantity !== parent.quantity) blockQuantity();
```

Keep the cart-global count as a fallback for deposit lines with no `parentRelationship` — the shape after a `lineExpand` must be confirmed against a real dev-store cart before the fixtures are written (open question 2). If it turns out the relationship is not populated, the global count is the best the platform allows; say so in a comment and keep the rest of the task.

Deposit-variant recognition reads **all** tiers per §3.3; orphan detection reads active ones only.

**User-facing block messages** — shoppers read these at checkout:

| Case | EN | DE |
|---|---|---|
| Orphan | "A deposit on an item in your cart isn't set up correctly. Please contact the store." | "Für einen Artikel in Ihrem Warenkorb ist das Pfand nicht korrekt hinterlegt. Bitte kontaktieren Sie den Shop." |
| Wrong deposit variant | "The deposit on your cart doesn't match this item. Please remove the item and add it again." | "Das Pfand in Ihrem Warenkorb passt nicht zu diesem Artikel. Bitte entfernen Sie den Artikel und legen Sie ihn erneut in den Warenkorb." |
| Quantity mismatch | "The deposit quantity doesn't match your item quantity. Please refresh your cart." | "Die Pfandmenge stimmt nicht mit der Artikelmenge überein. Bitte aktualisieren Sie Ihren Warenkorb." |

All three are actionable by the shopper without knowing what a Pfand tier is. The current generic message (`:65-68`) stays as the fallback for the un-parented case.

**Acceptance:**
- Correct cart → passes, in EUR and (if question 1 says multi-market) in a converted presentment currency.
- Deposit variant swapped for a cheaper tier's → blocked with the mismatch message.
- Line qty 3, deposit qty 2 → blocked with the quantity message.
- Product amount with no active tier → blocked with the orphan message.
- Deactivated tier's variant already in a cart, product reassigned → passes.

**Effort:** 3h · **Risk:** 🔴 High — this function gates every checkout on the store · **Depends on:** P1-2

---

### P1-8 · New wasm fixtures

**Goal:** prove all of the above, permanently.

**Files:** `extensions/deposit-checkout-validation/tests/fixtures/`, plus cart-transform fixtures for the active/inactive split

**Fixtures to add:**

| Fixture | Setup | Expect |
|---|---|---|
| Unknown `version` | `version: 99` | Validation blocks (fail closed); transform returns no operations, no throw |
| Deactivated tier still in cart | `active: false`, deposit variant matches, product reassigned | **Pass** — live carts survive deactivation (§3.3) |
| Deactivated tier, product still assigned | `active: false`, product still carries the amount | Block, orphan message |
| Substituted deposit variant | Deposit component is another tier's variant | Block, mismatch message |
| Quantity mismatch | Parent qty 3, deposit qty 2 | Block, quantity message |
| Deposit line with no parent relationship | Un-parented deposit variant | Falls back to the cart-global count, does not crash |
| Transform: inactive tier | Product assigned an inactive tier's amount | No expansion |

**Rewrite, don't just add:** `currency-mismatch-blocks.json` and `currency-mismatch-skipped.json` encode the pre-P1-4 world where a product can carry a non-base currency. §2.1 says it cannot. Repurpose them as base-currency-mismatch cases (a hand-edited metafield) rather than deleting the coverage.

**Acceptance:** validation fixtures rise from 11 to ~17, cart-transform from 8 to ~10. All green.

**Effort:** 3h · **Risk:** none · **Depends on:** P1-7

---

### 6.1 Invariants — do not break during Phase 1

- **`productSet` deletes omitted variants.** Every call re-sends every tier including deactivated ones (`deposits.server.ts:278, 302-307`). Sending only active tiers destroys live carts. Highest-consequence rule in the repo.
- **The variant read-back matches on option-value string** (`deposits.server.ts:368-370`). Any change to how that string is generated must keep write and read in step — see P1-6.
- **Money is minor units everywhere.** `amount = 8` is €0.08.
- **Functions cannot reach Postgres.** The shop metafield mirror is the only channel.
- **Tiers are soft-deleted, never hard-deleted.** Products carry an amount, not a tier reference.
- **`blockOnFailure: true` on the cart transform** (`app.settings.tsx:31`). A thrown exception in that function blocks every checkout on the store. It must always return, never throw.

---

## 7. Phase 2 — Order and refund webhooks

Schema and topics in **§4**.

### P2-1 · `DepositEvent` model and migration

**Files:** `prisma/schema.prisma`, new migration. **Change:** exactly §4.1.

**Acceptance:** `prisma migrate dev` clean; indexes present in the generated SQL; a hand-inserted duplicate `webhookId` is rejected.

**Effort:** 1.5h · **Risk:** low · **Depends on:** P1-5 (batch the migrations; back up the dev DB once)

---

### P2-2 · Subscribe webhook topics and take the scope hit

**Files:** `shopify.app.toml:15` (scopes), `:39-54` (subscriptions); new routes under `app/routes/`

**Change:** add `read_orders` to the scope string and declare three subscriptions — `orders/create`, `refunds/create`, `orders/cancelled` — following the existing `[[webhooks.subscriptions]]` pattern. Ship stub handlers that authenticate, log, and return 200.

The scope change forces a re-grant; the merchant must reauthorize. On `asad-app-dev` that means reinstalling. Do it first in P2 so every later task tests against the final scope set. See §4.3 on protected customer data — no blocker for a dev store.

`app/routes/webhooks.app.scopes_update.tsx` already exists and will fire; confirm it does something sensible with the new scope set rather than only logging.

**Acceptance:** `shopify app deploy` succeeds; the Partner dashboard lists all three topics; a test order produces a 200 in dev logs.

**Effort:** 1h · **Risk:** medium — reauthorization on the dev store · **Depends on:** P2-1

---

### P2-3 · `orders/create` handler → `CHARGED`

**Files:** new `app/routes/webhooks.orders.create.tsx`; helper in `deposits.server.ts`

**Change:** read `deposit_tiers` (§3.2), build a variant-GID set from **all** tiers (an order may contain a deposit whose tier was retired between checkout and payment), scan `line_items` for matches, insert one `CHARGED` row per matched line with base and presentment amounts, `quantity`, `webhookId`, and `occurredAt` from the payload. Non-deposit orders insert nothing and return 200.

Idempotency is the `webhookId` unique collision — catch it and return 200. Never 500 on a duplicate; Shopify retries indefinitely.

**Acceptance:** a dev-store order with 2× a €0.25-deposit product → exactly one row, `quantity: 2`, `amountMinor: 25`, type `CHARGED`. Replay the same delivery → still one row, 200. Order with no deposits → zero rows, 200.

**Test:** Partner dashboard webhook replay, plus real dev-store orders.

**Effort:** 3h · **Risk:** medium — a handler that 500s causes retry storms · **Depends on:** P2-2

---

### P2-4 · `refunds/create` handler → `REFUNDED`

**Files:** new `app/routes/webhooks.refunds.create.tsx`

**Change:** `refund_line_items[]` carries `line_item.variant_id` and `quantity`. Match against the deposit variant set; insert `REFUNDED` rows. Partial refunds are normal — store the refunded quantity, not the original.

**Acceptance:** refund only the Pfand line of a test order in admin → one `REFUNDED` row with the right quantity. Refund 1 of 2 units → `quantity: 1`. Refund the product but not the deposit → zero rows.

**Effort:** 3h · **Risk:** medium — partial-refund quantity maths is the easy thing to get wrong · **Depends on:** P2-3

---

### P2-5 · `orders/cancelled` handler → `CANCELLED`

**Files:** new `app/routes/webhooks.orders.cancelled.tsx`

**Change:** emit `CANCELLED` for each deposit line. If the cancellation also refunded, `refunds/create` fires separately — dedupe at **read** time (an order with any `CANCELLED` row is void) rather than trying to suppress one webhook from the other.

**Acceptance:** cancel a test order with a refund → both rows exist; dashboard "collected" excludes that order exactly once.

**Effort:** 1.5h · **Risk:** low · **Depends on:** P2-4

---

### P2-6 · Wire the dashboard tiles to real data

**Files:** `app/routes/app._index.tsx` (P0-3's empty state); new aggregation in `deposits.server.ts`

**Change:** four tiles, all derived by aggregation, none stored:

| Tile | Definition |
|---|---|
| Deposits collected | Σ `amountMinor × quantity` where `CHARGED`, excluding cancelled orders |
| Deposits refunded | Σ `amountMinor × quantity` where `REFUNDED` |
| Outstanding | collected − refunded |
| Orders with deposits | distinct `orderId` where `CHARGED`, excluding cancelled |

All in base currency, which after P1-4 is the only currency any tier has. Keep the note: **EN** "Amounts shown in {EUR}, your store's currency." / **DE** "Beträge in {EUR}, der Währung Ihres Shops."

The blocked-checkouts tile does **not** come back. Keep P0-3's sentence about why.

**Acceptance:** place 3 test orders, refund one deposit → tiles match hand-computed values. Cancel an order → collected drops by exactly that order.

**Effort:** 2h · **Risk:** low · **Depends on:** P2-3, P2-4 · **Supersedes:** P0-3

---

### P2-7 · Restore per-tier columns with real data

**Files:** `app/routes/app._index.tsx`

**Change:** Units / Collected / Refunded per tier, grouped by `variantId` — not `depositTierId`, so the figures survive tier churn.

**Acceptance:** two tiers, orders against both → per-row figures sum to the dashboard totals.

**Effort:** 1.5h · **Risk:** low · **Depends on:** P2-6 · **Supersedes:** P0-5

---

### P2-8 · Rebuild the Activity feed

**Files:** `app/routes/app.activity.tsx`, `deposits.server.ts:1379-1395` (`getActivitySummary`)

**Change:** merge `DepositEvent` rows with `DepositTier` timestamp changes into one reverse-chronological feed: charges, refunds, cancellations, tier created/deactivated. The Errors tile becomes real — count handler failures over 7 days. That needs somewhere to record them: add a small `WebhookFailure` table rather than a `failedAt`/`error` column on `DepositEvent`, which keeps the event table one thing.

**Keep** the blocked-checkout unobservability note (`:114-121`). It does not change and it is the honest core of this page.

**Acceptance:** the feed shows the last 50 events, correctly ordered and typed. The note is still visible.

**Effort:** 2h · **Risk:** low · **Depends on:** P2-7 · **Partially supersedes:** P0-4

---

### P2-9 · GDPR: extend `shop/redact`

**Files:** `app/routes/webhooks.compliance.tsx:16-19`

**Change:** add `DepositEvent.deleteMany({ where: { shop } })` alongside the existing `depositTier` and `shopConfig` deletes, plus `WebhookFailure` if P2-8 added it. `customers/redact` and `customers/data_request` stay no-ops — no customer PII is stored (§4.1). The handler comment already explains this; extend it to say that `DepositEvent.orderId` is the only weakly linkable field and that it carries no customer reference.

**Acceptance:** replay a `shop/redact` delivery → zero `DepositEvent` rows for that shop, 200 response.

**Effort:** 1h · **Risk:** low · **Depends on:** P2-3

---

## 8. Manual refund path (v1) — merchant flow and copy

Automated refunds are v2 (§11). But an app that charges a refundable deposit and says nothing about returning it is half a product, and it is the first question every merchant asks. v1 answers it in the app, honestly.

### X-5 · Manual refund guidance surface

**Files:** `app/routes/app._index.tsx` (dashboard card), `app/routes/app.onboarding.tsx` (the "Test before you go live" section at `:172` is the natural home)

**The merchant flow — exact steps as they will appear:**

> **EN — "Refunding deposits"**
> Deposits are charged as a separate line item on the order, so they're refunded like any other line.
> 1. Open the order in Shopify admin.
> 2. Click **Refund**.
> 3. Set the quantity on the **Pfand** line to the number of containers returned. Leave the product line at 0 if the customer is keeping the product.
> 4. Click **Refund**.
> Refunded deposits appear on your dashboard within a minute.
> *Automatic refunds on return aren't available yet.*

> **DE — „Pfand erstatten"**
> Das Pfand wird als separate Position auf der Bestellung berechnet und wie jede andere Position erstattet.
> 1. Öffnen Sie die Bestellung im Shopify-Admin.
> 2. Klicken Sie auf **Erstatten**.
> 3. Setzen Sie die Menge in der Zeile **Pfand** auf die Anzahl der zurückgegebenen Behälter. Lassen Sie die Produktzeile auf 0, wenn die Kundschaft das Produkt behält.
> 4. Klicken Sie auf **Erstatten**.
> Erstattete Pfandbeträge erscheinen innerhalb einer Minute in Ihrem Dashboard.
> *Automatische Erstattungen bei Rückgabe sind noch nicht verfügbar.*

The "appear on your dashboard" line is only true once **P2-4** ships. Before that, omit it — do not promise it.

The step-3 wording depends on X-2: it names the cart line **Pfand**, which is what the merchant will see in the refund UI only after the product is renamed. Ship X-2 first or word the step against the current title.

**Acceptance:** the card is visible on the dashboard without scrolling past the fold on a 1440×900 admin window; following the four steps end to end on the dev store produces a `REFUNDED` row and a dashboard delta.

**Effort:** 2h · **Risk:** none · **Depends on:** P2-4, X-2

---

## 9. Extras

### X-1 · German localization

**Goal:** a German-statute app for German merchants and German shoppers is currently English-only.

**Files:** `extensions/deposit-notice/locales/de.default.json` (new) and `en.json` (rename of the current `en.default.json`); `deposit-notice.liquid:21-28` (schema strings); admin route strings

**Change:** smaller than revision 1 assumed. The block body **already** uses a translation key (`deposit-notice.liquid:17` → `deposit_notice.text`), and `en.default.json` already holds it. What is missing:

**Storefront (must have).** Add `de.default.json` and demote English to `en.json`, so German is the fallback — the shopper-facing string is the one that matters, and this app's shoppers are German. Convert the block schema's `name` and setting `label` to `t:` keys so the *merchant* sees German in the theme editor too. Both files must carry every key: a missing key renders the key name on a live storefront.

**Admin (should have).** Polaris web components do not localize for you, and the admin hardcodes English JSX throughout. Extract to a flat key map keyed off the locale P1-6 resolves, defaulting to English. Full i18n tooling is overkill for one extra language.

Prioritise in this order: shopper-facing checkout block messages (P1-7) → storefront notice → merchant-facing error and guard messages (P1-3, P1-4) → the rest of the admin. A shopper blocked at checkout by an English message is a lost sale; an English column header is not.

**Acceptance:** theme editor in German → block name and settings in German. Storefront on `?locale=de` → German notice; `?locale=en` → English. Admin in German → German nav, page titles, and all block/guard messages.

**Effort:** 4h · **Risk:** low · **Depends on:** P0-2 (move the tests first, so locale files land in a clean extension), P1-6 (locale resolution)

---

### X-2 · Deliberate cart line label

**Goal:** the most-seen string this app produces is currently a side effect of internal naming.

**Files:** `deposits.server.ts:30` (`DEPOSIT_PRODUCT_TITLE`), `:32` (`DEPOSIT_OPTION_NAME`), `:281, 306, 350` (option values), `:343-354` (the `productSet` input)

**Before:** product title `"Pfand (Deposit)"`; variant option values from `formatAmount` → `0,08 €`. The cart line reads `Pfand (Deposit) - 0,08 €`.
**After:** product title **`Pfand`**; variant option value **`0,25 €`** formatted with a fixed German convention (comma decimal, non-breaking space, symbol), independent of admin locale.

German shoppers expect exactly `Pfand`. The parenthetical English gloss reads as an untranslated app artifact.

Keep the option value locale-independent even after P1-6 makes display formatting locale-aware — it is persisted data matched by exact string (§6.1), not a display string. P1-6 splits the two formatters; this task fixes the persisted one.

**Multi-market note:** the variant *title* is a static base-currency string while the *price* converts. A USD shopper sees `0,25 €` charged at `$0.27`. Defensible — the Pfand is legally €0.25 and the title states the statutory amount — but confusing enough to be worth seeing before committing. If it reads badly in a real presentment checkout, drop the amount from the option value and let the price column carry it. Decide from the screenshot, not in advance.

**Risk:** renaming variants on a product with live orders is safe (orders snapshot titles), but the rename **must go through `productSet` with the complete variant list** or omitted variants are deleted (§6.1). One-off backfill for the existing dev-store product.

**Acceptance:** add a deposit product to cart → line reads `Pfand · 0,25 €`. Complete checkout → the order confirmation email shows the same. Existing test orders unchanged. Creating a new tier afterwards still finds its variant on read-back.

**Effort:** 2h · **Risk:** 🟠 medium — touches `productSet` and the variant read-back · **Depends on:** P1-6

---

### X-3a · Make the deposit product unreachable

**Goal:** a shopper who adds a bare deposit is blocked with a message that reads as nonsense to them. The better fix is that they cannot.

**Files:** `deposits.server.ts:343-354` — the product is created `status: "ACTIVE"` (`:345`) with no publication control.

**Change:** set `status: "DRAFT"`, or keep ACTIVE and unpublish from all sales channels. DRAFT is the cleaner intent — the cart transform references the variant by ID and should not need storefront publication — but this is **unverified against a live cart** and is open question 2. Test expansion immediately after changing status; if `lineExpand` fails against a draft variant, fall back to ACTIVE-but-unpublished, which definitely works.

Whichever wins, do it in the same `productSet` call that already re-sends the variant list, and make the setting explicit in the input rather than relying on a default.

**Acceptance:**
- Storefront search for `Pfand` and `Deposit` → no result
- Direct URL to the deposit product handle → 404
- `/cart/add` with a deposit variant ID → rejected, or if it succeeds, checkout blocks with P1-7's mismatch message
- A normal deposit-bearing product still expands and checks out correctly

**Effort:** 1.5h · **Risk:** 🔴 high if DRAFT breaks expansion — test expansion in the same sitting · **Depends on:** P1-1 (question 2)

---

### X-3b · Fixed per-market price warning

**Goal:** Shopify Markets lets a merchant set a fixed per-market price on any variant, including the deposit variant. Doing so on a Pfand variant produces a deposit that is legally wrong in euro terms.

**Files:** `app/routes/app.settings.tsx`

**Change:** a warning banner, shown only when `ShopConfig.supportedCurrencies` holds more than one entry — the list P1-4 keeps for exactly this. Variant-identity validation (§3.4) keeps working correctly under fixed pricing; this is a legal-correctness caution, not a technical one.

> **EN:** "If you set fixed prices per market, check that deposit amounts still convert to the statutory Pfand in euros. Pfand amounts are set by German law and don't change by market."
> **DE:** "Wenn Sie feste Preise pro Markt festlegen, prüfen Sie, ob die Pfandbeträge weiterhin dem gesetzlichen Pfand in Euro entsprechen. Pfandbeträge sind gesetzlich festgelegt und ändern sich nicht je Markt."

**Acceptance:** the banner appears only when more than one presentment currency is enabled, and disappears when markets are reduced to one.

**Effort:** 0.75h · **Risk:** none · **Depends on:** P1-4 · **Skip if P1-1 question 1 finds a single currency**

---

### X-4 · Notice copy and placement settings

**Goal:** a surprise line item at checkout is the top cart-abandonment complaint.

**Files:** `extensions/deposit-notice/blocks/deposit-notice.liquid`, `locales/*.json`

**Change:** smaller than revision 1 assumed — the current copy **already states refundability**: "Includes a {{ amount }} refundable Pfand deposit, charged at checkout." What is missing is the German default and merchant control over placement.

> **DE (default):** „Zzgl. **{{ amount }}** Pfand. Das Pfand wird bei Rückgabe erstattet."
> **EN:** "Plus **{{ amount }}** deposit. Refunded when you return the container."

Add to the block schema: **show in cart** (default on), **custom text override** (optional, must still interpolate `{{ amount }}`). The block already takes a `product` setting with `autofill: true`, so product-page placement needs nothing new. Defaults matter more than the settings — most merchants never open them.

Cart placement depends on the theme exposing a cart-line block target — open question 3. If Dawn-style cart blocks are unavailable on `asad-app-dev`'s theme, product page plus the checkout-visible line label from X-2 is sufficient for pre-production; ship the setting anyway so a theme that supports it works.

**Acceptance:** product page shows amount and refundability in the storefront locale. Toggling each setting works. A custom override replaces the default and still interpolates the amount. `{{ amount }}` renders in the shopper's presentment currency via the `money` filter (`deposit-notice.liquid:15`).

**Effort:** 1h · **Risk:** low · **Depends on:** X-1

---

## 10. Phase 3 — Reachability

### P3-1 · Product list pagination, search, and filter

**Goal:** the merchant cannot reach most of their own catalogue.

**Files:** `app/routes/app.products._index.tsx:19-21` (hardcoded `first: 25`, no cursor), `deposits.server.ts:540-599` (`listProductsWithDepositStatus`)

**Change:** cursor-based pagination — Shopify GraphQL is cursor-native, do not offset-paginate — at 50/page with next/previous, plus a search field over title and SKU, plus a **has deposit / no deposit / orphaned** filter. That filter is what a merchant assigning deposits across a beverage catalogue actually needs, and P1-3's guard links into it.

**Acceptance:** a store with >50 products → page 2 reachable, search returns matches beyond page 1, filter narrows correctly, deposit assignment still works from any page.

**Effort:** 4h · **Risk:** low · **Depends on:** P1-1 (question 4 — may need seeding to verify)

---

### P3-2 · Fix the dashboard coverage scan cap

**Goal:** the coverage percentage is silently wrong beyond 250 products, and P1-3's guard now depends on the same scan.

**Files:** `app/deposits.server.ts:687` (`first: 250`), `:674-724` (`getDashboardSummary`)

**Change:** count via filtered queries rather than scanning a page of products — the counts needed are "products with a `$app:pfand` value" and "products per amount", both of which a metafield-filtered `productsCount` can answer without walking the catalogue. If a full scan stays necessary, cap explicitly and **label the number as approximate** rather than presenting a wrong percentage as fact.

> **EN:** "Based on your first 250 products." / **DE:** „Basierend auf Ihren ersten 250 Produkten."

P1-3's deactivation guard must stay safe under either outcome: it blocks on a non-zero count, so an undercount can only fail toward "allow", which is why the guard must also be re-checked after this task.

**Acceptance:** a >250-product store → coverage is either correct or visibly qualified, never silently wrong. Deactivation guard still fires for a product beyond position 250.

**Effort:** 2h · **Risk:** low — watch page-load time if you fully paginate · **Depends on:** P1-3

---

### P3-3 · Name the migration scan limit

**Goal:** small copy fix. The truncation warning already renders (`app.migration.tsx:166`, `:273`) — it just doesn't say how many.

**Change:** put the number in the banner so a merchant can tell whether it affects them.

> **EN:** "Only the first 5,000 products were scanned. Products beyond this limit aren't included in the export." / **DE:** „Es wurden nur die ersten 5.000 Produkte erfasst. Darüber hinausgehende Produkte sind nicht im Export enthalten."

**Effort:** 0.25h · **Risk:** none · **Depends on:** —

---

### P3-4 · Replace the README

**Goal:** `README.md` is the stock Shopify React Router template for 237 lines with `# pfandlock` appended at line 238.

**Change:** what the app does; the three-way state split (product metafield / Postgres / shop metafield mirror) and why Functions force it; local setup; how to run the three suites; the §6.1 invariants; the known gaps. Write it for the next developer — plausibly you in three months.

**Acceptance:** a developer with repo access can run the app locally from the README alone.

**Effort:** 1.5h · **Risk:** none · **Depends on:** —

---

## 11. Execution order

```
P0-1 ──┬─> P0-2 ──> X-1
       └─> P1-1 ──┬─> P1-2 ──┬─> P1-3 ──> P3-2
                  │          └─> P1-7 ──> P1-8
                  │          └─> P1-4 ──> P1-5 ──> P1-6 ──> X-2 ──> X-5
                  └─> X-3a
P0-3, P0-4, P0-5, P0-6, P3-3, P3-4   (independent — any time)

P1-5 ──> P2-1 ──> P2-2 ──> P2-3 ──┬─> P2-4 ──> P2-5 ──> P2-6 ──> P2-7 ──> P2-8
                                   └─> P2-9
P1-4 ──> X-3b
P1-1 ──> P3-1
X-1 ──> X-4
```

**Recommended serial order:**

1. **P0-1** — unblocks everything, prevents loss of uncommitted work
2. **P0-3, P0-4, P0-5, P0-6, P3-3** — honesty and hygiene; cheap, no dependencies
3. **P0-2** — stop shipping test files to storefronts
4. **P1-1** — the four store-side answers
5. **P1-2** — the metafield contract, alone, all suites green before moving on
6. **P1-3** — the deactivation guard; the highest merchant-experience return in the plan
7. **P1-4 → P1-5 → P1-6** — collapse the currency fiction
8. **P1-7 → P1-8** — validation hardening and its fixtures
9. **P2-2 first within P2** — take the reauthorization hit early, then P2-1 → P2-3 → P2-4 → P2-5 → P2-9
10. **P2-6 → P2-7 → P2-8** — replace P0's empty states with real data
11. **X-1 → X-2 → X-4 → X-5** — localization, cart label, notice, refund guidance
12. **X-3a, X-3b** — deposit product visibility and the market warning
13. **P3-1 → P3-2 → P3-4** — reachability and docs

**Do not reorder:** P1-2 before everything else in P1 (both Functions read the contract it defines), P1-6 before X-2 (the variant read-back coupling), and P0-1 before anything (dirty tree).

---

## 12. Definition of pre-production ready

### Correctness
- [ ] Working tree clean; all commits pushed
- [ ] `npx vitest run` green (173+)
- [ ] `pnpm run test:extensions` green — ~17 validation fixtures and ~10 transform fixtures, including unknown-version, deactivated-tier-in-cart, and substituted-variant
- [ ] `npx tsc --noEmit` clean
- [ ] `pnpm run lint` clean, **verified under bash** — PowerShell's stderr wrapping can turn a real failure into a false green
- [ ] CI green on `main`

### Honesty
- [ ] No hardcoded metric anywhere in the admin UI
- [ ] Every displayed figure is derived from `DepositEvent` or live Shopify data
- [ ] The blocked-checkout unobservability note is visible on both the Activity page and the dashboard
- [ ] No feature described in the UI that doesn't exist
- [ ] No in-repo comment describes a system that was replaced

### Shopper experience
- [ ] Storefront notice renders on product pages, in the storefront locale, with German as the fallback
- [ ] Notice states both the amount and that it's refundable
- [ ] Cart line reads `Pfand · 0,25 €`, not `Pfand (Deposit) - 0,08 €`
- [ ] Deposit product unfindable: storefront search, direct URL, bare `/cart/add`
- [ ] EUR checkout completes
- [ ] Multi-market only: a converted-presentment checkout completes and shows the converted deposit
- [ ] A cart holding a deposit whose tier was retired mid-session still completes
- [ ] Every checkout block message is comprehensible to a shopper, in both languages, without app vocabulary

### Merchant experience
- [ ] Onboarding completes end to end on a fresh install
- [ ] Adding a deposit amount takes one currency-free form
- [ ] Deactivating an unused amount takes one click; deactivating an in-use amount is refused with a count and a route out
- [ ] A >50-product catalogue is fully reachable, searchable, filterable
- [ ] Coverage percentage is correct or explicitly qualified
- [ ] Manual refund path documented in-app, and following it produces a dashboard delta
- [ ] German admin renders German — nav, titles, errors, and guard messages
- [ ] Every error a merchant can hit is written by this app, not passed through raw from Shopify

### Data
- [ ] `orders/create`, `refunds/create`, `orders/cancelled` all deliver 200
- [ ] Replayed webhook deliveries do not double-count
- [ ] Cancelled orders excluded from collected totals exactly once
- [ ] `shop/redact` removes all `DepositEvent` rows
- [ ] No customer PII stored anywhere

### Operational
- [ ] `README.md` lets a fresh developer run the app
- [ ] §6.1 invariants documented in-repo, not only in this file
- [ ] Dev DB backed up before the P1-5 and P2-1 migrations
- [ ] Protected customer data noted in the App Store checklist (§4.3) — not a pre-production blocker

---

## 13. Explicitly out of scope for pre-production

| Item | Why it can wait |
|---|---|
| **Billing API** | Your stated decision. Blocks App Store listing, not dev-store readiness. |
| **Hosting, Dockerfile, `application_url`** | Your stated decision. The Dockerfile is broken (`npm ci` in a pnpm-only repo; `node:20-alpine` against `>=20.19 <22 \|\| >=22.12`) and `application_url` is still `https://example.com` — deployment-phase problems. |
| **Automated refunds on return** | Needs returns/fulfilment modelling and merchant-configurable policy. §8 is the honest v1 answer. |
| **Blocked-checkout metrics** | Platform limitation. Shopify never reports validation outcomes to apps. Not buildable without out-of-band instrumentation. |
| **`orders/updated`** | Noisy; order edits are rare and add real complexity for negligible accuracy. |
| **Per-market deposit amounts** | Architecturally rejected (§2.1, §2.2). Would let a merchant charge a legally wrong Pfand, and the `money` metafield type forbids it anyway. |
| **Base-currency change after configuration** | Silently mis-denominates existing tiers. Document as a known limitation; don't build the migration. A detector reading §3.2's root `currency` is the cheap future guard. |
| **Market-localized `$app:pfand` overrides** | A merchant *can* register one via Translate & Adapt (§2.1 fact 3). Out of scope to support; open question 1 decides whether it needs detecting and warning about. |
| **Postgres integration tests / testcontainers** | Domain logic is well covered with mocked Prisma — 164 tests. Worth doing eventually, not now. |
| **E2E automation** | The manual checklist (§12) is proportionate at this stage. |
| **>50 tier support / `productSet` concurrency** | The `variants(first: 50)` read-back ceiling (`deposits.server.ts:323`) and the concurrent-admin race are real. A German catalogue needs ~6 tiers and a one-person shop has one admin. Cap at 50 with a clear error; revisit if a real merchant approaches it. |
| **Tier editing (amount changes)** | Soft-delete plus create covers it. Editing means re-variant-ing and rewriting every affected product metafield. P1-3's guard makes the retire-and-replace flow safe, which is the real gap. |
| **Uninstall config cleanup** | Config preservation on reinstall is defensible. Add a staleness check when it bites. |
| **Extension API version drift** | App webhooks are `2026-07` (`shopify.app.toml:37`); both Functions are `2026-04` (`shopify.extension.toml`). Documented and intentional — Functions version independently. Watch, don't act. |
| **Full i18n tooling** | One extra language. A flat key map is right-sized (X-1). |

---

## 14. Open questions

Down from nine to four. The other five were answered by reading the code and the platform docs — see §0.

1. **Does a Function's input query return a market-localized `$app:pfand` value, or the base value?** Metafields are market-localizable (`MarketLocalizableResourceType.METAFIELD`), and the behaviour inside Functions isn't documented. If Functions see the localized value, a merchant using Translate & Adapt could orphan their own products. Test by registering a market localization on one product and checking out from that market. Decides whether the app needs to detect and warn about localized `$app:pfand` values. Not a blocker — no merchant reaches this state by accident.
2. **Does `lineExpand` work against a variant on a `DRAFT` product?** X-3a hinges on it. Fall back to ACTIVE-but-unpublished if not. Also: what shape does `CartLine.parentRelationship` take after a `lineExpand` — is `parent.merchandise` the original product variant? P1-7's per-line matching needs this confirmed from a real dev-store cart payload before fixtures are written.
3. **Does the current theme on `asad-app-dev` expose a cart-line block target?** Decides whether X-4's cart placement is buildable or product-page-only.
4. **Should the deposit variant title carry the euro amount** (`0,25 €`) when a converted-market shopper is charged `$0.27`? Legally defensible, possibly confusing. Decide from a real presentment checkout (X-2), not in advance.
