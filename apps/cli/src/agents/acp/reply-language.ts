/**
 * Reply-language hint from the user's device locale.
 *
 * Agents greet and answer in English by default, so a non-English user spent
 * their FIRST task just stating their language ("Hola hablo y entiendo
 * español", tchacker647; "Saya tidak paham bahasa Inggris…",
 * info.notifikasi.transaksi — replays 2026-10-05). The app now sends its
 * device locale on `start_task` (`StartTaskPayload.locale`), and the first
 * turn of each agent in a session carries one context line telling it which
 * language to use. It rides the squad-context resource block, so it is
 * context the agent sees, never words shown in the user's bubble.
 *
 * English (or a missing / unparseable locale) adds nothing: it is already the
 * default and an extra line would only cost tokens.
 */

const hinted = new Set<string>();

/** English display name of a BCP-47 locale's language ("id-ID" → "Indonesian"),
 *  or null for English / a missing or invalid tag. */
export function replyLanguageName(locale: string | undefined | null): string | null {
  if (typeof locale !== 'string' || locale.trim().length === 0) return null;
  try {
    const language = new Intl.Locale(locale.trim().replace(/_/g, '-')).language;
    if (!language || language === 'en' || language === 'und') return null;
    const name = new Intl.DisplayNames(['en'], { type: 'language' }).of(language);
    // DisplayNames echoes the code back for a language it doesn't know.
    return name && name.toLowerCase() !== language ? name : null;
  } catch {
    return null;
  }
}

/**
 * The language context line for THIS turn, or null. Returned once per
 * (session, agent), so a session's first turn and the first turn after an
 * agent switch carry it, and later turns don't repeat it.
 */
export function replyLanguageContextOnce(
  locale: string | undefined | null,
  sessionId: string,
  agent: string,
): string | null {
  const language = replyLanguageName(locale);
  if (!language) return null;
  const key = `${sessionId}:${agent}`;
  if (hinted.has(key)) return null;
  hinted.add(key);
  return `The user's device language is ${language}. Reply in ${language} unless the user writes in another language.`;
}

/** Test seam: forget which sessions were already hinted. */
export function _resetReplyLanguageHints(): void {
  hinted.clear();
}
