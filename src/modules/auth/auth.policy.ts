import type { OtpPurpose, UserStatus } from '@prisma/client';

export type VerificationTransition = 'ACTIVATE' | 'VERIFY_ONLY' | 'BLOCKED';

/** Public OTP requests may only target users eligible for the requested purpose. */
export function requiredOtpUserStatus(purpose: OtpPurpose): UserStatus {
  return purpose === 'LOGIN' || purpose === 'PASSWORD_RESET' ? 'ACTIVE' : 'PENDING';
}

/**
 * Verification may activate a pending account or update verification metadata on
 * an already-active account. It must never alter suspended or disabled accounts.
 */
export function verificationTransition(status: UserStatus): VerificationTransition {
  if (status === 'PENDING') return 'ACTIVATE';
  if (status === 'ACTIVE') return 'VERIFY_ONLY';
  return 'BLOCKED';
}
