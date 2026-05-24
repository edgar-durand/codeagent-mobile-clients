package com.windsurf.controller.ui

import java.awt.Color

/**
 * Canonical CodeAgent Mobile cyberpunk palette. Mirrors the brand
 * tokens in `apps/mobile/src/theme/colors.ts` (the `brand` namespace).
 *
 * Hard rules from the design audit:
 *   - `electricPurple` is the accent token, not `primaryLavender`. Used
 *     for active labels, the pairing-code glow, and selected tab
 *     indicators. Pairs with `glowPurple` for shadow effects.
 *   - `surfaceGray` / `surfaceDim` are the card backgrounds; the
 *     terminal-black `terminalBlack` is the surface beneath.
 *   - Semantic colors map by intent: `successGreen` for online,
 *     `warningAmber` for transient states, `errorRed` for offline /
 *     destructive actions.
 *   - On light themes (IntelliJ Default + Light Headless), the
 *     terminal-black surface is replaced by `surfaceLight`.
 */
object BrandColors {
    val electricPurple = Color(0xA8, 0x55, 0xF7)
    val primaryLavender = Color(0xD0, 0xBC, 0xFF)
    val glowPurple = Color(0xA8, 0x55, 0xF7, 80)

    val successGreen = Color(0x00, 0xFF, 0xA0)
    val warningAmber = Color(0xFF, 0xC1, 0x07)
    val errorRed = Color(0xFF, 0x44, 0x44)

    val terminalBlack = Color(0x05, 0x05, 0x0D)
    val surfaceGray = Color(0x1E, 0x1E, 0x2E)
    val surfaceLight = Color(0xF5, 0xF5, 0xF7)
    val surfaceDim = Color(0x12, 0x12, 0x1C)

    val onSurface = Color(0xFF, 0xFF, 0xFF)
    val onSurfaceVariant = Color(0xC0, 0xC0, 0xCB)
    val mutedText = Color(0x8E, 0x8E, 0x93)
}
