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
