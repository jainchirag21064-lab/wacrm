import { describe, expect, it } from 'vitest';
import { validateAccessRequest } from './validation';

describe('validateAccessRequest', () => {
  it('accepts a well-formed request and lowercases the email', () => {
    const res = validateAccessRequest({
      full_name: '  Alice  ',
      email: '  Alice@Example.COM ',
      company_name: 'Acme',
      message: 'Hello',
      referral_code: 'X',
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value).toEqual({
        full_name: 'Alice',
        email: 'alice@example.com',
        company_name: 'Acme',
        message: 'Hello',
        referral_code: 'X',
      });
    }
  });

  it('treats blank optional fields as null', () => {
    const res = validateAccessRequest({
      full_name: 'Bob',
      email: 'bob@example.com',
      company_name: '   ',
      message: '',
      referral_code: undefined,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.company_name).toBeNull();
      expect(res.value.message).toBeNull();
      expect(res.value.referral_code).toBeNull();
    }
  });

  it('rejects a missing full name', () => {
    expect(
      validateAccessRequest({ email: 'a@b.com' }).ok,
    ).toBe(false);
  });

  it('rejects a malformed email', () => {
    expect(
      validateAccessRequest({ full_name: 'A', email: 'not-an-email' }).ok,
    ).toBe(false);
    expect(
      validateAccessRequest({ full_name: 'A', email: 'a@b' }).ok,
    ).toBe(false);
  });

  it('rejects an oversized email', () => {
    const long = `${'a'.repeat(250)}@b.com`;
    expect(
      validateAccessRequest({ full_name: 'A', email: long }).ok,
    ).toBe(false);
  });

  it('clamps oversized optional fields rather than rejecting', () => {
    const res = validateAccessRequest({
      full_name: 'A',
      email: 'a@b.com',
      message: 'x'.repeat(5000),
      referral_code: 'y'.repeat(500),
      company_name: 'z'.repeat(1000),
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.message).toHaveLength(2000);
      expect(res.value.referral_code).toHaveLength(100);
      expect(res.value.company_name).toHaveLength(120);
    }
  });

  it('passes referral code through as informational only', () => {
    const res = validateAccessRequest({
      full_name: 'A',
      email: 'a@b.com',
      referral_code: 'PARTNER1',
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.referral_code).toBe('PARTNER1');
  });

  it('rejects null / non-object input', () => {
    expect(validateAccessRequest(null).ok).toBe(false);
    expect(validateAccessRequest(undefined).ok).toBe(false);
    expect(validateAccessRequest('nope' as never).ok).toBe(false);
  });
});
