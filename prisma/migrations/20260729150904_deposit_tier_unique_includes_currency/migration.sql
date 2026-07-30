-- DropIndex
DROP INDEX "DepositTier_shop_amount_key";

-- CreateIndex
CREATE UNIQUE INDEX "DepositTier_shop_amount_currency_key" ON "DepositTier"("shop", "amount", "currency");
