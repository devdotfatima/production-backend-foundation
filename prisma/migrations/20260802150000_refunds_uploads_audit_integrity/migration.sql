-- Production refund operations, owner-scoped uploads, and signed audit records.
CREATE TYPE "UploadProvider" AS ENUM ('S3', 'CLOUDINARY');
CREATE TYPE "UploadStatus" AS ENUM ('PENDING', 'READY', 'FAILED', 'DELETED');

ALTER TABLE "audit_events"
ADD COLUMN "integrityHash" TEXT,
ADD COLUMN "integrityVersion" INTEGER NOT NULL DEFAULT 1;

CREATE TABLE "stripe_refund_operations" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "idempotencyKeyHash" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "paymentIntentId" TEXT,
    "chargeId" TEXT,
    "requestedAmount" INTEGER,
    "stripeRefundId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "amount" INTEGER,
    "currency" TEXT,
    "lastError" TEXT,
    "completedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "stripe_refund_operations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "uploads" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "provider" "UploadProvider" NOT NULL,
    "status" "UploadStatus" NOT NULL DEFAULT 'PENDING',
    "objectKey" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "expectedSize" BIGINT NOT NULL,
    "actualSize" BIGINT,
    "checksum" TEXT,
    "url" TEXT,
    "uploadExpiresAt" TIMESTAMPTZ(3) NOT NULL,
    "readyAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "uploads_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "stripe_refund_operations_stripeRefundId_key"
ON "stripe_refund_operations"("stripeRefundId");
CREATE UNIQUE INDEX "stripe_refund_operations_userId_idempotencyKeyHash_key"
ON "stripe_refund_operations"("userId", "idempotencyKeyHash");
CREATE INDEX "stripe_refund_operations_userId_createdAt_idx"
ON "stripe_refund_operations"("userId", "createdAt");
CREATE INDEX "stripe_refund_operations_paymentIntentId_idx"
ON "stripe_refund_operations"("paymentIntentId");
CREATE INDEX "stripe_refund_operations_chargeId_idx"
ON "stripe_refund_operations"("chargeId");

CREATE UNIQUE INDEX "uploads_provider_objectKey_key" ON "uploads"("provider", "objectKey");
CREATE INDEX "uploads_userId_status_createdAt_idx" ON "uploads"("userId", "status", "createdAt");
CREATE INDEX "uploads_status_uploadExpiresAt_idx" ON "uploads"("status", "uploadExpiresAt");

ALTER TABLE "stripe_refund_operations"
ADD CONSTRAINT "stripe_refund_operations_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "uploads"
ADD CONSTRAINT "uploads_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
