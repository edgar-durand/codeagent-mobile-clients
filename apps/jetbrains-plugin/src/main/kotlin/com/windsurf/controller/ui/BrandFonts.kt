package com.windsurf.controller.ui

import com.intellij.openapi.diagnostic.Logger
import java.awt.Font
import java.awt.GraphicsEnvironment

/**
 * Lazy-loaded brand fonts. Variable-axis TTFs ship under
 * `src/main/resources/fonts/` and are registered with the JVM's
 * GraphicsEnvironment on first use so Swing can resolve them by
 * family name via `Font("Hanken Grotesk", …)`.
 *
 * Hard rules from the design audit (mirrored from
 * `apps/mobile/DESIGN_SYSTEM.md`):
 *   - Hanken Grotesk headlines stay MIXED case — never
 *     `text-transform: uppercase` on a Hanken span.
 *   - JetBrains Mono labels are UPPERCASE + 0.05em letterspacing.
 *   - The pairing code renders in JetBrains Mono with the
 *     electric-purple text-shadow set by BrandColors.glowPurple.
 *
 * Falls back to JBLabel defaults if the TTF can't be loaded
 * (corrupt jar, missing entry on an exotic IDE distribution).
 */
object BrandFonts {

    private val logger = Logger.getInstance(BrandFonts::class.java)

    private const val HANKEN_RESOURCE = "/fonts/HankenGrotesk[wght].ttf"
    private const val JBM_RESOURCE = "/fonts/JetBrainsMono[wght].ttf"

    private var hankenBase: Font? = null
    private var jbmBase: Font? = null
    private var loaded = false

    @Synchronized
    private fun load() {
        if (loaded) return
        loaded = true
        val ge = GraphicsEnvironment.getLocalGraphicsEnvironment()
        hankenBase = loadResource(HANKEN_RESOURCE)?.also { ge.registerFont(it) }
        jbmBase = loadResource(JBM_RESOURCE)?.also { ge.registerFont(it) }
    }

    private fun loadResource(path: String): Font? {
        return try {
            val stream = BrandFonts::class.java.getResourceAsStream(path)
                ?: throw IllegalStateException("Missing font resource: $path")
            stream.use { Font.createFont(Font.TRUETYPE_FONT, it) }
        } catch (e: Exception) {
            logger.warn("Failed to load font $path: ${e.message}")
            null
        }
    }

    /** Display / body font. Mixed-case per DLS. */
    fun hanken(style: Int = Font.PLAIN, size: Float): Font {
        load()
        val base = hankenBase ?: return Font(Font.SANS_SERIF, style, size.toInt())
        return base.deriveFont(style, size)
    }

    /** Monospace label / pairing-code font. Uppercase per DLS. */
    fun jetBrainsMono(style: Int = Font.PLAIN, size: Float): Font {
        load()
        val base = jbmBase ?: return Font(Font.MONOSPACED, style, size.toInt())
        return base.deriveFont(style, size)
    }
}
