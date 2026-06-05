/**
 * Cyberpunk brand palette mirrored from the mobile app's
 * `apps/mobile/DESIGN_SYSTEM.md` and the JetBrains plugin's
 * `BrandColors.kt`. Exposed to the webview as CSS custom properties
 * so the panel can mix brand tokens with the host's
 * `var(--vscode-*)` tokens (focus rings, scrollbar, etc.).
 *
 * Audit notes:
 *  - `--ca-purple` is the canonical accent (#A855F7); the older
 *    `#A78BFA` lavender was the wrong purple.
 *  - GlassCard primitive is opacity 0.7 + backdrop-blur 12px on the
 *    surface-gray fill.
 *  - Status dots map by intent:
 *      online → success-green, transient → warning-amber, offline → error-red.
 */
export function brandCssTokens(): string {
  return `
    :root {
      --ca-purple: #A855F7;
      --ca-lavender: #D0BCFF;
      --ca-glow-purple: rgba(168, 85, 247, 0.45);
      /* Soft purple tints derived from --ca-purple — used for
         translucent overlays (reveal pills, status chips, etc.)
         where a solid color would feel too heavy. Names follow the
         mobile design system's electricPurple/<opacity> shape. */
      --ca-purple-soft: rgba(168, 85, 247, 0.18);
      --ca-purple-glow-soft: rgba(168, 85, 247, 0.25);

      --ca-success: #00FFA0;
      --ca-warning: #FFC107;
      --ca-error: #FF4444;

      --ca-terminal-black: #05050D;
      --ca-surface-gray: #1E1E2E;
      --ca-surface-dim: #12121C;

      --ca-on-surface: #FFFFFF;
      --ca-on-surface-variant: #C0C0CB;
      --ca-muted: #8E8E93;
    }
  `;
}
