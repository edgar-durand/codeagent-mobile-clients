package com.windsurf.controller.ui

import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel
import java.awt.Color
import java.awt.image.BufferedImage

/**
 * Pairing-code QR renderer. The mobile + landing dashboards bundle
 * the QR rendering directly into their UI; the JetBrains plugin
 * needs to do it locally so the pairing code never leaks to a
 * third-party QR service (parity with the VS Code plugin's
 * `renderPairingQrSvg` in `utils/webview-security.ts`).
 *
 * Pure function — no instance state. The dark/light foreground +
 * background flip is a single boolean parameter.
 */
internal object QrImageRenderer {

    fun render(text: String, size: Int, dark: Boolean): BufferedImage {
        val hints = mapOf(
            EncodeHintType.ERROR_CORRECTION to ErrorCorrectionLevel.M,
            EncodeHintType.MARGIN to 1,
        )
        val writer = QRCodeWriter()
        val bitMatrix = writer.encode(text, BarcodeFormat.QR_CODE, size, size, hints)
        val bg = if (dark) Color(60, 60, 63) else Color.WHITE
        val fg = if (dark) Color.WHITE else Color.BLACK
        val image = BufferedImage(size, size, BufferedImage.TYPE_INT_RGB)
        for (x in 0 until size) {
            for (y in 0 until size) {
                image.setRGB(x, y, if (bitMatrix.get(x, y)) fg.rgb else bg.rgb)
            }
        }
        return image
    }
}
