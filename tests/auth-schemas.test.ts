import { describe, expect, it } from 'vitest';
import {
  loginSchema,
  otpVerifySchema,
  passwordResetConfirmSchema,
  passwordResetVerifyOtpSchema,
  signupSchema,
} from '../dist/src/modules/auth/auth.schemas.js';

describe('auth validation', () => {
  it('normalizes email addresses', () => {
    const result = loginSchema.parse({ email: ' User@Example.COM ', password: 'password' });
    expect(result.email).toBe('user@example.com');
  });

  it('requires strong signup passwords', () => {
    expect(() => signupSchema.parse({ email: 'user@example.com', password: 'short' })).toThrow();
  });

  it('requires E.164 phones and six-digit OTPs', () => {
    expect(
      otpVerifySchema.parse({
        channel: 'SMS',
        destination: '+15551234567',
        purpose: 'LOGIN',
        code: '123456',
      }),
    ).toBeTruthy();
    expect(() =>
      otpVerifySchema.parse({
        channel: 'SMS',
        destination: '5551234567',
        purpose: 'LOGIN',
        code: '123',
      }),
    ).toThrow();
  });

  it('validates the password-reset OTP and confirmation payloads', () => {
    expect(
      passwordResetVerifyOtpSchema.parse({
        email: ' User@Example.COM ',
        otp: '123456',
      }),
    ).toEqual({ email: 'user@example.com', otp: '123456' });
    expect(
      passwordResetConfirmSchema.parse({
        resetToken: 'r'.repeat(64),
        newPassword: 'a-strong-password-123',
      }),
    ).toEqual({ resetToken: 'r'.repeat(64), newPassword: 'a-strong-password-123' });
    expect(() =>
      passwordResetVerifyOtpSchema.parse({ email: 'user@example.com', otp: '123' }),
    ).toThrow();
    expect(() =>
      passwordResetConfirmSchema.parse({
        email: 'user@example.com',
        newPassword: 'a-strong-password-123',
      }),
    ).toThrow();
  });
});
