import { describe, expect, it } from 'vitest';

import { safeNextPath } from '@/app/auth/callback/route';

describe('safeNextPath (open-redirect prevention)', () => {
  it('accepts a plain same-origin relative path', () => {
    expect(safeNextPath('/dashboard')).toBe('/dashboard');
  });

  it('accepts a nested path with query and hash', () => {
    expect(safeNextPath('/settings?tab=profile#name')).toBe(
      '/settings?tab=profile#name',
    );
  });

  it('accepts the root path', () => {
    expect(safeNextPath('/')).toBe('/');
  });

  it('returns null for null / undefined', () => {
    expect(safeNextPath(null)).toBeNull();
  });

  it('returns null for an absolute URL with a foreign host', () => {
    expect(safeNextPath('https://evil.example')).toBeNull();
    expect(safeNextPath('http://evil.example/dashboard')).toBeNull();
  });

  it('returns null for a protocol-relative URL', () => {
    expect(safeNextPath('//evil.example/dashboard')).toBeNull();
  });

  it('returns null for a path with a backslash', () => {
    expect(safeNextPath('/dashboard\\@evil.example')).toBeNull();
    expect(safeNextPath('\\evil.example')).toBeNull();
  });

  it('returns null for control characters', () => {
    expect(safeNextPath('/dash\u0000board')).toBeNull();
  });

  it('returns null for path traversal', () => {
    expect(safeNextPath('/../../etc/passwd')).toBeNull();
  });

  it('returns null for malformed percent-encoding', () => {
    expect(safeNextPath('/%zz%')).toBeNull();
  });

  it('returns null for an oversized value', () => {
    expect(safeNextPath(`/${'a'.repeat(2049)}`)).toBeNull();
  });

  it('accepts percent-encoded path segments intact', () => {
    expect(safeNextPath('/join%2Fabc')).toBe('/join/abc');
  });
});
