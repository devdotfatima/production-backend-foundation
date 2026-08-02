-- Social/OIDC identities and Stripe billing projections.
ALTER TABLE "users" ADD COLUMN "stripeCustomerId" TEXT;

CREATE TYPE "SocialProvider" AS ENUM ('GOOGLE', 'APPLE');

CREATE TABLE "social_accounts" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "provider" "SocialProvider" NOT NULL,
    "providerAccountId" TEXT NOT NULL,
    "email" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "social_accounts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "stripe_subscriptions" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "stripeSubscriptionId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "priceId" TEXT,
    "currency" TEXT,
    "currentPeriodStart" TIMESTAMPTZ(3),
    "currentPeriodEnd" TIMESTAMPTZ(3),
    "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
    "canceledAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "stripe_subscriptions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "stripe_payments" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "stripePaymentIntentId" TEXT,
    "checkoutSessionId" TEXT,
    "chargeId" TEXT,
    "status" TEXT NOT NULL,
    "amount" INTEGER,
    "amountRefunded" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "stripe_payments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "users_stripeCustomerId_key" ON "users"("stripeCustomerId");
CREATE UNIQUE INDEX "social_accounts_provider_providerAccountId_key" ON "social_accounts"("provider", "providerAccountId");
CREATE INDEX "social_accounts_userId_deletedAt_idx" ON "social_accounts"("userId", "deletedAt");
CREATE UNIQUE INDEX "stripe_subscriptions_stripeSubscriptionId_key" ON "stripe_subscriptions"("stripeSubscriptionId");
CREATE INDEX "stripe_subscriptions_userId_status_deletedAt_idx" ON "stripe_subscriptions"("userId", "status", "deletedAt");
CREATE UNIQUE INDEX "stripe_payments_stripePaymentIntentId_key" ON "stripe_payments"("stripePaymentIntentId");
CREATE UNIQUE INDEX "stripe_payments_checkoutSessionId_key" ON "stripe_payments"("checkoutSessionId");
CREATE UNIQUE INDEX "stripe_payments_chargeId_key" ON "stripe_payments"("chargeId");
CREATE INDEX "stripe_payments_userId_status_createdAt_idx" ON "stripe_payments"("userId", "status", "createdAt");

ALTER TABLE "social_accounts" ADD CONSTRAINT "social_accounts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "stripe_subscriptions" ADD CONSTRAINT "stripe_subscriptions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "stripe_payments" ADD CONSTRAINT "stripe_payments_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
