-- Bind password-reset confirmation to a short-lived, single-use credential.
CREATE TABLE "password_reset_tokens" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "otpChallengeId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "usedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "password_reset_tokens_otpChallengeId_key"
ON "password_reset_tokens"("otpChallengeId");

CREATE UNIQUE INDEX "password_reset_tokens_tokenHash_key"
ON "password_reset_tokens"("tokenHash");

CREATE INDEX "password_reset_tokens_userId_expiresAt_idx"
ON "password_reset_tokens"("userId", "expiresAt");

ALTER TABLE "password_reset_tokens"
ADD CONSTRAINT "password_reset_tokens_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "password_reset_tokens"
ADD CONSTRAINT "password_reset_tokens_otpChallengeId_fkey"
FOREIGN KEY ("otpChallengeId") REFERENCES "otp_challenges"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Persist Stripe's event creation time and projection high-water marks.
ALTER TABLE "stripe_webhook_events"
ADD COLUMN "stripeCreatedAt" TIMESTAMPTZ(3);

UPDATE "stripe_webhook_events"
SET "stripeCreatedAt" = CASE
  WHEN "payload" ? 'created' AND ("payload"->>'created') ~ '^[0-9]+$'
    THEN TO_TIMESTAMP(("payload"->>'created')::DOUBLE PRECISION)
  ELSE "createdAt"
END;

ALTER TABLE "stripe_webhook_events"
ALTER COLUMN "stripeCreatedAt" SET NOT NULL;

ALTER TABLE "stripe_subscriptions"
ADD COLUMN "lastStripeEventId" TEXT,
ADD COLUMN "lastStripeEventCreatedAt" TIMESTAMPTZ(3);

ALTER TABLE "stripe_payments"
ADD COLUMN "lastStripeEventId" TEXT,
ADD COLUMN "lastStripeEventCreatedAt" TIMESTAMPTZ(3);
