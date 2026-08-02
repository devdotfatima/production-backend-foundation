-- AlterEnum
ALTER TYPE "OtpPurpose" ADD VALUE 'PASSWORD_RESET';

-- AlterTable
ALTER TABLE "otp_challenges" ADD COLUMN "verifiedAt" TIMESTAMPTZ(3);

-- DropTable
DROP TABLE "password_reset_tokens";
