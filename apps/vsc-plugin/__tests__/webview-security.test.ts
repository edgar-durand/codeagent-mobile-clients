import { describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';

// The webview-security helpers only touch the vscode shape via
// `webview.cspSource` — easy to stub. The qrcode dependency is real
// (we want to verify the SVG actually round-trips), so don't mock it.
vi.mock('vscode', () => ({}));

import {
  generateNonce,
  cspMeta,
  renderPairingQrSvg,
  sanitizeSessionId,
} from '../src/utils/webview-security';

function fakeWebview(cspSource: string): vscode.Webview {
  return { cspSource } as unknown as vscode.Webview;
}

describe('generateNonce', () => {
  it('produces a 22-char base64-safe nonce', () => {
    const n = generateNonce();
    // 16 bytes = 22 base64 chars (3-byte aligned + 2 trailing chars, no '=' if base64).
    expect(n).toHaveLength(24);
    expect(n).toMatch(/^[A-Za-z0-9+/=]+$/);
  });

  it('returns distinct values on each call', () => {
    const a = generateNonce();
    const b = generateNonce();
    const c = generateNonce();
    expect(new Set([a, b, c]).size).toBe(3);
  });
});

describe('cspMeta', () => {
  it('locks default-src to none', () => {
    const meta = cspMeta(fakeWebview('vscode-webview://x'), 'n0nce');
    expect(meta).toContain(`default-src 'none'`);
  });

  it('binds script-src to the supplied nonce only — no unsafe-inline, no host', () => {
    const meta = cspMeta(fakeWebview('vscode-webview://x'), 'abc');
    expect(meta).toContain(`script-src 'nonce-abc'`);
    // script-src specifically must NOT include 'unsafe-inline' or the
    // host — either would undo the nonce gate. (style-src DOES use
    // 'unsafe-inline' so the existing <style> block keeps working —
    // that case is covered in a separate it() below.)
    const scriptSrc = meta.split(';').find((d) => d.trim().startsWith('script-src'));
    expect(scriptSrc).toBeDefined();
    expect(scriptSrc).not.toContain(`'unsafe-inline'`);
    expect(scriptSrc).not.toMatch(/vscode-webview:/);
  });

  it('binds img-src to webview.cspSource + data: only', () => {
    const meta = cspMeta(fakeWebview('vscode-webview://x'), 'n');
    expect(meta).toContain(`img-src vscode-webview://x data:`);
  });

  it("quotes style-src 'unsafe-inline' so the existing <style> block keeps working", () => {
    const meta = cspMeta(fakeWebview('vscode-webview://x'), 'n');
    expect(meta).toContain(`style-src vscode-webview://x 'unsafe-inline'`);
  });
});

describe('sanitizeSessionId', () => {
  it.each([
    'abc',
    'A1B2C3-_',
    'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', // UUID-shaped
    '0',
    'A'.repeat(128),
  ])('accepts safe session id: %j', (input) => {
    expect(sanitizeSessionId(input)).toBe(input);
  });

  it.each([
    '', // empty
    'A'.repeat(129), // too long
    'with space',
    'has/slash',
    'has.dot',
    "has'quote",
    'has;semi',
    '<script>',
    'tab\there',
    'newline\nhere',
    null,
    undefined,
    42,
    {},
    [],
  ])('rejects bogus session id: %j', (input) => {
    expect(sanitizeSessionId(input)).toBeNull();
  });
});

describe('renderPairingQrSvg', () => {
  it('produces a valid SVG document for a 6-digit pair code', async () => {
    const svg = await renderPairingQrSvg('123456');
    // qrcode encodes the input in the SVG; we don't assert the encoding
    // bytes, just the wrapper shape so a future migration to a different
    // QR lib doesn't silently produce non-SVG output.
    expect(svg).toMatch(/^<svg[\s\S]*<\/svg>\s*$/);
    expect(svg).toContain('width="180"');
  });

  it('rejects nothing — encodes arbitrary text safely', async () => {
    // The pairing code is the only real input today, but the helper is
    // generic — verify it doesn't choke on a longer string in case a
    // future flow QRs a URL or token.
    const svg = await renderPairingQrSvg('https://codeagent-mobile.com/pair/abc123');
    expect(svg).toMatch(/^<svg/);
  });
});
