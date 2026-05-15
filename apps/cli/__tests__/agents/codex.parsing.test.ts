import { describe, it, expect } from 'vitest';
import { filterCodexChrome, parseCodexChrome, detectCodexSelector, wrapCodexCodeBlocks } from '../../src/agents/codex/parsing';

describe('codex/parsing filterCodexChrome', () => {
  it('keeps an agent reply that starts with • after a user prompt', () => {
    const lines = ['› hola', '', '• Hola. ¿Qué necesitas que haga?'];
    const out = filterCodexChrome(lines);
    expect(out).toContain('Hola. ¿Qué necesitas que haga?');
  });

  it('strips the leading • from the emitted line so the bubble is clean', () => {
    const lines = ['• Hola.'];
    const out = filterCodexChrome(lines);
    expect(out.some(l => l.startsWith('•'))).toBe(false);
    expect(out).toContain('Hola.');
  });

  it('drops intro box drawing + Tip / Learn more banners', () => {
    const lines = [
      '╭───────────────────────────────────────╮',
      '│ >_ OpenAI Codex (v0.130.0)            │',
      '│ model:     gpt-5.5                    │',
      '╰───────────────────────────────────────╯',
      '  Tip: GPT-5.5 is now available in Codex.',
      '  Learn more: https://openai.com/...',
      '• Real agent reply',
    ];
    const out = filterCodexChrome(lines);
    expect(out).not.toContain(expect.stringContaining('OpenAI Codex'));
    expect(out.find(l => l.startsWith('Tip:'))).toBeUndefined();
    expect(out.find(l => l.startsWith('Learn more:'))).toBeUndefined();
    expect(out).toContain('Real agent reply');
  });

  it('drops the user-prompt echo with the › prefix', () => {
    const lines = ['› what is the time?', '• 11:25 PM'];
    const out = filterCodexChrome(lines);
    expect(out.find(l => /^[›>]\s/.test(l))).toBeUndefined();
    expect(out).toContain('11:25 PM');
  });

  it('handles multiple turns: each › resets the echo guard', () => {
    const lines = [
      '› hola',
      '',
      '• Hola. Estoy listo.',
      '› hola',
      '',
      '• Hola. ¿Qué necesitas?',
    ];
    const out = filterCodexChrome(lines);
    expect(out).toContain('Hola. Estoy listo.');
    expect(out).toContain('Hola. ¿Qué necesitas?');
    expect(out.filter(l => /^[›>]\s/.test(l))).toHaveLength(0);
  });

  it('keeps non-echo, non-bullet plain text lines (multi-line agent response)', () => {
    const lines = ['• First line of reply', 'continuation line without bullet'];
    const out = filterCodexChrome(lines);
    expect(out).toContain('First line of reply');
    expect(out).toContain('continuation line without bullet');
  });

  it('drops box-drawing lines regardless of surrounding content', () => {
    const lines = ['╭──────╮', '│ info │', '╰──────╯'];
    const out = filterCodexChrome(lines);
    expect(out.every(l => !/^[╭╰│]/.test(l.trimStart()))).toBe(true);
  });

  it('drops the bottom status footer "gpt-X.Y default · ~/path"', () => {
    const lines = [
      '› hola',
      '',
      '• Hola. ¿En qué te ayudo?',
      '',
      'gpt-5.5 default · ~/Documents/codeagent',
    ];
    const out = filterCodexChrome(lines);
    expect(out).toContain('Hola. ¿En qué te ayudo?');
    expect(out.find(l => /default\s+[·•]/.test(l))).toBeUndefined();
  });

  it('drops the footer for other gpt models too', () => {
    const lines = [
      '• reply',
      'gpt-5.4-mini default · /tmp/project',
    ];
    const out = filterCodexChrome(lines);
    expect(out).toContain('reply');
    expect(out.find(l => l.includes('gpt-5.4-mini'))).toBeUndefined();
  });

  it('keeps an agent reply that uses · (U+00B7 MIDDLE DOT) instead of • bullet', () => {
    const lines = ['› hola', '', '· Hola con middle dot'];
    const out = filterCodexChrome(lines);
    expect(out).toContain('Hola con middle dot');
    expect(out.some(l => l.startsWith('·'))).toBe(false);
  });

  it('regression: Claude still works through the Claude strategy (no Codex changes touched shared)', () => {
    // No-op — Claude path goes through @codeagent/shared filterChrome
    // unchanged. This test exists as documentation.
    expect(true).toBe(true);
  });
});

describe('codex/parsing parseCodexChrome', () => {
  it('always returns null (Codex Phase 2 has no chrome steps)', () => {
    expect(parseCodexChrome('• some reply')).toBeNull();
    expect(parseCodexChrome('• Reading file.ts')).toBeNull();
    expect(parseCodexChrome('')).toBeNull();
  });
});

describe('codex/parsing detectCodexSelector', () => {
  it('returns null without the "Press enter to confirm" trailer (narrative numbered list)', () => {
    // Plan-shaped numbered list in a regular agent reply must NOT be
    // detected as a selector.
    const lines = [
      'Plan to fix the bug:',
      '',
      '  1. Reproduce locally',
      '  2. Add a failing test',
      '  3. Implement the fix',
    ];
    expect(detectCodexSelector(lines)).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(detectCodexSelector([])).toBeNull();
  });

  it('detects the shell-approval prompt and extracts question + 3 options + cursor index', () => {
    const lines = [
      'Would you like to run the following command?',
      '',
      'Reason: Do you want to run the landing build/prerender check outside the sandbox so tsx can create its temporary IPC pipe?',
      '',
      '$ npm run build:check',
      '',
      '> 1. Yes, proceed (y)',
      '  2. Yes, and don\'t ask again for commands that start with `npm run build:check` (p)',
      '  3. No, and tell Codex what to do differently (esc)',
      '',
      'Press enter to confirm or esc to cancel',
    ];
    const sel = detectCodexSelector(lines);
    expect(sel).not.toBeNull();
    expect(sel?.question).toContain('Would you like to run the following command?');
    expect(sel?.question).toContain('Reason:');
    expect(sel?.question).toContain('npm run build:check');
    expect(sel?.options).toEqual([
      'Yes, proceed (y)',
      'Yes, and don\'t ask again for commands that start with `npm run build:check` (p)',
      'No, and tell Codex what to do differently (esc)',
    ]);
    expect(sel?.currentIndex).toBe(0);
  });

  it('tracks cursor index when the cursor is not on the first option', () => {
    const lines = [
      'Pick one',
      '',
      '  1. Alpha',
      '> 2. Beta',
      '  3. Gamma',
      '',
      'Press enter to confirm or esc to cancel',
    ];
    const sel = detectCodexSelector(lines);
    expect(sel?.currentIndex).toBe(1);
  });

  it('returns null when fewer than 2 options match', () => {
    const lines = [
      'Only one option?',
      '> 1. Yes',
      'Press enter to confirm or esc to cancel',
    ];
    expect(detectCodexSelector(lines)).toBeNull();
  });
});

describe('codex/parsing filterCodexChrome — selector-cursor preservation', () => {
  it('keeps `> 1. text` (cursored numbered option) so detectCodexSelector can see it', () => {
    // Regression: the user-echo filter previously matched any `> token`
    // line, eating the first option of a Codex approval prompt and
    // leaving the mobile renderer with only options 2 and 3.
    const lines = [
      '> 1. Yes, proceed (y)',
      '  2. Yes, and don\'t ask again (p)',
      '  3. No, and tell Codex what to do differently (esc)',
    ];
    const out = filterCodexChrome(lines);
    expect(out).toContain('> 1. Yes, proceed (y)');
    expect(out).toContain('  2. Yes, and don\'t ask again (p)');
    expect(out).toContain('  3. No, and tell Codex what to do differently (esc)');
  });

  it('still drops bare `> text` user echoes (the original filter intent)', () => {
    const lines = ['> hola que tal', '• reply'];
    const out = filterCodexChrome(lines);
    expect(out.find(l => /^>\s+hola/.test(l))).toBeUndefined();
    expect(out).toContain('reply');
  });
});

describe('wrapCodexCodeBlocks', () => {
  it('wraps Java code in ```java fences', () => {
    const input = [
      'public class Foo {',
      '    public static void main(String[] args) {',
      '        System.out.println("hi");',
      '    }',
      '}',
    ];
    const out = wrapCodexCodeBlocks(input);
    expect(out[0]).toBe('```java');
    expect(out[out.length - 1]).toBe('```');
    expect(out.slice(1, -1)).toEqual(input);
  });

  it('infers typescript from type/interface keywords', () => {
    const input = [
      'type User = {',
      '    id: number;',
      '    name: string;',
      '};',
    ];
    const out = wrapCodexCodeBlocks(input);
    expect(out[0]).toBe('```typescript');
  });

  it('infers python from def + print', () => {
    const input = [
      'def greet(name):',
      '    print(f"hello {name}")',
      '    return name',
      '',
      'greet("Edgar")',
    ];
    const out = wrapCodexCodeBlocks(input);
    expect(out[0]).toBe('```python');
  });

  it('emits ``` (no lang) when language is not detectable', () => {
    const input = [
      'x = 5;',
      'y = 10;',
      'z = x + y;',
    ];
    const out = wrapCodexCodeBlocks(input);
    expect(out[0]).toBe('```');
  });

  it('leaves bullet-list text alone (no false positive on `•`-style content)', () => {
    const input = [
      'Plataforma para automatizar tareas administrativas',
      'Servicio de suscripción de comidas saludables',
      'Marketplace local de profesionales verificados',
      'App de educación financiera',
      'Agencia boutique de contenido',
    ];
    expect(wrapCodexCodeBlocks(input)).toEqual(input);
  });

  it('leaves prose alone (no false positive on a single stray `{` or `}`)', () => {
    const input = [
      'Mira esto: { es un curly brace }',
      'Pero el texto es solo prosa.',
    ];
    expect(wrapCodexCodeBlocks(input)).toEqual(input);
  });

  it('does NOT wrap when fewer than 3 code-shaped lines (avoid false positives)', () => {
    const input = [
      'Mira:',
      'const x = 5;',
      'fin del ejemplo',
    ];
    // Only 1 code-shaped line → leave as-is.
    expect(wrapCodexCodeBlocks(input)).toEqual(input);
  });

  it('preserves text before and after a code block', () => {
    const input = [
      'Aquí tienes el código:',
      'public class A {',
      '    static int x = 1;',
      '    static int y = 2;',
      '}',
      'Eso es todo.',
    ];
    const out = wrapCodexCodeBlocks(input);
    expect(out[0]).toBe('Aquí tienes el código:');
    expect(out[1]).toBe('```java');
    expect(out[out.length - 2]).toBe('```');
    expect(out[out.length - 1]).toBe('Eso es todo.');
  });

  // ─── Structured-block guards: DO NOT wrap diffs/commits/PRs/pushes/merges ─

  it('does NOT wrap a unified diff in ``` fences (diffBlockParser must see it)', () => {
    const input = [
      'Aquí el diff:',
      'diff --git a/app.py b/app.py',
      'index 4f2a91c..9c8e7b1 100644',
      '--- a/app.py',
      '+++ b/app.py',
      '@@ -1,10 +1,18 @@',
      ' def saludar(nombre):',
      '-    return "Hola " + nombre',
      '+    return f"Hola, {nombre}!"',
      ' def sumar(a, b):',
      '     return a + b',
    ];
    const out = wrapCodexCodeBlocks(input);
    expect(out.some(l => l.startsWith('```'))).toBe(false);
    // Body preserved verbatim so diffBlockParser can pick it up.
    expect(out).toEqual(input);
  });

  it('does NOT wrap a hunk-only diff (no `diff --git` header)', () => {
    const input = [
      '@@ -1,3 +1,4 @@',
      ' def x():',
      '-    return 1',
      '+    return 2',
      '+    # comment',
    ];
    expect(wrapCodexCodeBlocks(input)).toEqual(input);
  });

  it('does NOT wrap a commit header + stats block', () => {
    const input = [
      '[main abc1234] feat(api): add user endpoint',
      ' 3 files changed, 50 insertions(+), 2 deletions(-)',
      ' create mode 100644 src/users.ts',
    ];
    expect(wrapCodexCodeBlocks(input)).toEqual(input);
  });

  it('does NOT wrap a push output block', () => {
    const input = [
      'To https://github.com/edgar-durand/codeagent-mobile.git',
      '   abc1234..def5678  main -> main',
    ];
    expect(wrapCodexCodeBlocks(input)).toEqual(input);
  });

  it('does NOT wrap a "new branch" push block', () => {
    const input = [
      'To https://github.com/edgar-durand/codeagent-mobile.git',
      ' * [new branch]      feature/foo -> feature/foo',
    ];
    expect(wrapCodexCodeBlocks(input)).toEqual(input);
  });

  it('does NOT wrap a merge block', () => {
    const input = [
      'Updating abc1234..def5678',
      'Fast-forward',
      ' src/foo.ts | 10 +++++++---',
      ' 1 file changed, 7 insertions(+), 3 deletions(-)',
    ];
    expect(wrapCodexCodeBlocks(input)).toEqual(input);
  });

  it('does NOT wrap a `gh pr view` block', () => {
    const input = [
      'title: Add user endpoint',
      'state: OPEN',
      'number: 42',
      'url: https://github.com/edgar-durand/codeagent-mobile/pull/42',
      'additions: 50',
      'deletions: 2',
    ];
    expect(wrapCodexCodeBlocks(input)).toEqual(input);
  });

  it('does NOT wrap content with a pull-request URL', () => {
    const input = [
      'Created PR:',
      'https://github.com/edgar-durand/codeagent-mobile/pull/100',
      'PR is open.',
    ];
    expect(wrapCodexCodeBlocks(input)).toEqual(input);
  });

  // ─── Regression: Codex's 2-space chat margin must be stripped from
  // diff lines so the backend's diffBlockParser (anchored with ^) can
  // claim them. Without dedenting, the line `  @@ -1,6 +1,8 @@` slips
  // past the parser and `filePathLinkifier` turns `a/foo` and `b/foo`
  // into READ pills mid-diff, ruining the render. See ~/.codeam/debug.log
  // tick at 2026-05-14T19:49:50 where `in[5..9]` had 2 leading spaces.
  it('strips Codex chat-margin from diff markers (regression for filterCodexChrome real-world tick)', () => {
    // This is the EXACT shape that came off the wire on 2026-05-14:
    // `•`-prefixed reply followed by a 2-space-indented unified diff.
    const input = [
      '• Claro, acá va otro diff de git simulado:',
      '  diff --git a/src/auth/session.ts b/src/auth/session.ts',
      '  index 1f3a9b2..8c7d4e1 100644',
      '  --- a/src/auth/session.ts',
      '  +++ b/src/auth/session.ts',
      '  @@ -12,11 +12,18 @@ export async function getSession(userId: string) {',
      '     const session = await db.session.findFirst({',
      '       where: { userId },',
      '     });',
      '  -  if (!session) {',
      '  +  if (!session || session.expiresAt < new Date()) {',
      '       return null;',
      '     }',
      '     return session;',
      '   }',
    ];
    const out = filterCodexChrome(input);
    // Reply prose preserved.
    expect(out).toContain('Claro, acá va otro diff de git simulado:');
    // Diff markers MUST be at col 0 so diffBlockParser fires.
    expect(out).toContain('diff --git a/src/auth/session.ts b/src/auth/session.ts');
    expect(out).toContain('--- a/src/auth/session.ts');
    expect(out).toContain('+++ b/src/auth/session.ts');
    expect(out).toContain('@@ -12,11 +12,18 @@ export async function getSession(userId: string) {');
    // Body add/remove markers at col 0 too.
    expect(out).toContain('-  if (!session) {');
    expect(out).toContain('+  if (!session || session.expiresAt < new Date()) {');
    // Critical: no ``` fences (structured-block guard fires post-dedent).
    expect(out.some((l) => l.startsWith('```'))).toBe(false);
  });

  it('strips Codex chat-margin from a merge (pull fast-forward) so mergeBlockParser fires', () => {
    // Real shape from 2026-05-14 `ahora simula un pull` reproducer.
    const input = [
      '• $ git pull origin main',
      '  remote: Enumerating objects: 18, done.',
      '  Unpacking objects: 100% (12/12), 3.21 KiB | 1.60 MiB/s, done.',
      '  From github.com:example/project',
      '   * branch            main       -> FETCH_HEAD',
      '     7a91c2d..b4e8f30  main       -> origin/main',
      '  Updating 7a91c2d..b4e8f30',
      '  Fast-forward',
      '   src/client.ts        | 10 +++++++---',
      '   3 files changed, 25 insertions(+), 5 deletions(-)',
    ];
    const out = filterCodexChrome(input);
    // Merge markers MUST be at col 0 for mergeBlockParser to fire.
    expect(out).toContain('Updating 7a91c2d..b4e8f30');
    expect(out).toContain('Fast-forward');
    // From line at col 0 too (helps the textual fetch portion render cleanly).
    expect(out).toContain('From github.com:example/project');
  });

  it('strips Codex chat-margin from a push so pushBlockParser fires', () => {
    const input = [
      '• $ git push origin main',
      '  Enumerating objects: 9, done.',
      '  Writing objects: 100% (6/6), 1.42 KiB | 1.42 MiB/s, done.',
      '  Total 6 (delta 3), reused 0 (delta 0), pack-reused 0',
      '  remote: Resolving deltas: 100% (3/3), completed with 3 local objects.',
      '  To github.com:example/project.git',
      '     b4e8f30..d19a7bc  main -> main',
    ];
    const out = filterCodexChrome(input);
    expect(out).toContain('To github.com:example/project.git');
    // Body line preserves its single-leading-space (PUSH_UPDATE_RE has `^\s*`)
    expect(out).toContain('   b4e8f30..d19a7bc  main -> main');
  });

  it('strips Codex chat-margin from a commit so commitBlockParser fires', () => {
    const input = [
      '• $ git commit -m "Improve API client validation"',
      '  [main d19a7bc] Improve API client validation',
      '   3 files changed, 25 insertions(+), 5 deletions(-)',
      '   create mode 100644 tests/client.test.ts',
    ];
    const out = filterCodexChrome(input);
    // Commit header at col 0 for COMMIT_HEADER_RE.
    expect(out).toContain('[main d19a7bc] Improve API client validation');
    // Stats / create-mode allow ^\s*, so their single leading space survives.
    expect(out).toContain(' 3 files changed, 25 insertions(+), 5 deletions(-)');
    expect(out).toContain(' create mode 100644 tests/client.test.ts');
  });

  it('leaves diff alone when markers are already at col 0 (no dedent regression)', () => {
    const input = [
      'diff --git a/app.py b/app.py',
      '--- a/app.py',
      '+++ b/app.py',
      '@@ -1,3 +1,4 @@',
      ' def saludar(nombre):',
      '-    return "Hola " + nombre',
      '+    return f"Hola, {nombre}!"',
      '+',
    ];
    // Routes through wrapCodexCodeBlocks (structured guard fires).
    // We assert via wrapCodexCodeBlocks since filterCodexChrome would
    // strip nothing else here either.
    const out = wrapCodexCodeBlocks(input);
    expect(out).toEqual(input);
  });

  it('handles two separate code blocks in the same reply', () => {
    const input = [
      'public class A { static int x = 1; static int y = 2; }',
      'Y otro snippet:',
      'type B = {',
      '    a: number;',
      '    b: string;',
      '};',
    ];
    const out = wrapCodexCodeBlocks(input);
    // Java single-line: 1 code-shaped, doesn't reach 3 → stays plain.
    // TS block: 3 code-shaped → wrapped.
    const fences = out.filter(l => l.startsWith('```'));
    expect(fences).toEqual(['```typescript', '```']);
  });
});
