import { describe, expect, it } from 'vitest';
import { requiredOtpUserStatus, verificationTransition } from '../src/modules/auth/auth.policy.js';

describe('OTP account-status policy', () => {
  it('only issues public verification OTPs to pending users', () => {
    expect(requiredOtpUserStatus('VERIFY_EMAIL')).toBe('PENDING');
    expect(requiredOtpUserStatus('VERIFY_PHONE')).toBe('PENDING');
    expect(requiredOtpUserStatus('LOGIN')).toBe('ACTIVE');
  });

  it('never lets verification alter suspended or disabled users', () => {
    expect(verificationTransition('SUSPENDED')).toBe('BLOCKED');
    expect(verificationTransition('DISABLED')).toBe('BLOCKED');
  });

  it('only activates pending users and leaves active status unchanged', () => {
    expect(verificationTransition('PENDING')).toBe('ACTIVATE');
    expect(verificationTransition('ACTIVE')).toBe('VERIFY_ONLY');
  });
});
