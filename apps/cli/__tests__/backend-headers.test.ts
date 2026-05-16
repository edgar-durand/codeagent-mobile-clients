import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { vercelBypassHeader } from '../src/lib/backend-headers';

describe('vercelBypassHeader', () => {
  const original = process.env.CODEAM_VERCEL_BYPASS;

  beforeEach(() => {
    delete process.env.CODEAM_VERCEL_BYPASS;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.CODEAM_VERCEL_BYPASS;
    else process.env.CODEAM_VERCEL_BYPASS = original;
  });

  it('returns an empty object when CODEAM_VERCEL_BYPASS is unset', () => {
    expect(vercelBypassHeader()).toEqual({});
  });

  it('returns the x-vercel-protection-bypass header when the env is set', () => {
    process.env.CODEAM_VERCEL_BYPASS = 'bypass-secret-abc';
    expect(vercelBypassHeader()).toEqual({ 'x-vercel-protection-bypass': 'bypass-secret-abc' });
  });

  it('treats empty string as unset (no header)', () => {
    process.env.CODEAM_VERCEL_BYPASS = '';
    expect(vercelBypassHeader()).toEqual({});
  });
});
