import * as crypto from 'node:crypto';
import * as QRCode from 'qrcode';
import * as vscode from 'vscode';

export function generateNonce(): string {
  return crypto.randomBytes(16).toString('base64');
}

export function cspMeta(webview: vscode.Webview, nonce: string): string {
  return [
    `default-src 'none'`,
    `img-src ${webview.cspSource} data:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
    `font-src ${webview.cspSource}`,
  ].join('; ');
}

export async function renderPairingQrSvg(code: string): Promise<string> {
  return QRCode.toString(code, {
    type: 'svg',
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 180,
    color: { dark: '#000000', light: '#ffffff' },
  });
}

/**
 * Session IDs sent by the webview are echoes of UUIDs we previously
 * stored in recentSessions. Reject anything that doesn't match the
 * shape — the webview is a sandboxed iframe behind our CSP, but the
 * downstream services treat sessionId as trusted input. Exposed from
 * this module so it can be unit-tested without booting the panel.
 */
export function sanitizeSessionId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(raw)) return null;
  return raw;
}
