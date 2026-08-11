/*
  Warnings:

  - You are about to drop the `api_keys` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `customer_webhook_deliveries` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `customer_webhook_endpoints` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `feature_flags` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `service_accounts` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "api_keys" DROP CONSTRAINT "api_keys_serviceAccountId_fkey";

-- DropForeignKey
ALTER TABLE "customer_webhook_deliveries" DROP CONSTRAINT "customer_webhook_deliveries_endpointId_fkey";

-- DropForeignKey
ALTER TABLE "customer_webhook_endpoints" DROP CONSTRAINT "customer_webhook_endpoints_organizationId_fkey";

-- DropForeignKey
ALTER TABLE "customer_webhook_endpoints" DROP CONSTRAINT "customer_webhook_endpoints_userId_fkey";

-- DropForeignKey
ALTER TABLE "feature_flags" DROP CONSTRAINT "feature_flags_organizationId_fkey";

-- DropForeignKey
ALTER TABLE "service_accounts" DROP CONSTRAINT "service_accounts_organizationId_fkey";

-- DropTable
DROP TABLE "api_keys";

-- DropTable
DROP TABLE "customer_webhook_deliveries";

-- DropTable
DROP TABLE "customer_webhook_endpoints";

-- DropTable
DROP TABLE "feature_flags";

-- DropTable
DROP TABLE "service_accounts";
