package com.windsurf.controller.services;

import com.intellij.credentialStore.CredentialAttributes;
import org.jetbrains.annotations.NotNull;

/**
 * Builds {@link CredentialAttributes} through the plain {@code (String)} constructor.
 *
 * <p>From Kotlin, {@code CredentialAttributes(name)} compiles against the 2024.1 SDK
 * to the synthetic default-arguments constructor, which 2026.2 keeps only as a
 * deprecated (level ERROR) binary shim. Java resolves the explicit one-argument
 * constructor, present in both 2024.1 and 2026.2.
 */
final class CredentialAttributesCompat {
    private CredentialAttributesCompat() {}

    static @NotNull CredentialAttributes of(@NotNull String serviceName) {
        return new CredentialAttributes(serviceName);
    }
}
