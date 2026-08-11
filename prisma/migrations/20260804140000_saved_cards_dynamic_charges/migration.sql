-- Saved cards and dynamic-amount charges (docs/feature-roadmap.md section 3).
--
-- Additive only. `payment_methods` stores Stripe identifiers and display metadata exclusively --
-- no PAN, no CVC -- so the service stays within PCI SAQ-A. `chargeable_items` holds the
-- server-owned amount for a dynamic charge; the charge API accepts a reference, never a price.

-- CreateEnum
CREATE TYPE "ChargeableStatus" AS ENUM ('OPEN', 'CONSUMED', 'EXPIRED', 'CANCELED');

-- CreateTable
CREATE TABLE "payment_methods" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "organizationId" UUID,
    "userId" UUID NOT NULL,
    "stripePaymentMethodId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "brand" TEXT,
    "last4" TEXT,
    "expMonth" INTEGER,
    "expYear" INTEGER,
    "fingerprint" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "mandateId" TEXT,
    "detachedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "payment_methods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chargeable_items" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "organizationId" UUID,
    "userId" UUID,
    "reference" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "metadata" JSONB,
    "status" "ChargeableStatus" NOT NULL DEFAULT 'OPEN',
    "expiresAt" TIMESTAMPTZ(3),
    "consumedAt" TIMESTAMPTZ(3),
    "paymentIntentId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "chargeable_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payment_methods_stripePaymentMethodId_key" ON "payment_methods"("stripePaymentMethodId");

-- CreateIndex
CREATE INDEX "payment_methods_organizationId_deletedAt_idx" ON "payment_methods"("organizationId", "deletedAt");

-- CreateIndex
CREATE INDEX "payment_methods_userId_deletedAt_idx" ON "payment_methods"("userId", "deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "chargeable_items_reference_key" ON "chargeable_items"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "chargeable_items_paymentIntentId_key" ON "chargeable_items"("paymentIntentId");

-- CreateIndex
CREATE INDEX "chargeable_items_organizationId_status_createdAt_idx" ON "chargeable_items"("organizationId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "chargeable_items_status_expiresAt_idx" ON "chargeable_items"("status", "expiresAt");

-- AddForeignKey
ALTER TABLE "payment_methods" ADD CONSTRAINT "payment_methods_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_methods" ADD CONSTRAINT "payment_methods_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chargeable_items" ADD CONSTRAINT "chargeable_items_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

