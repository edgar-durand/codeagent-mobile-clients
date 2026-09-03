import { describe, it, expect } from 'vitest';
import { getEnabledIntegrations, type IntegrationMcpDelivery } from '@codeam/shared';
import { launcherFlagsOf, specOf, warmTargets } from '../../src/integrations/mcp-warm';

function delivery(over: Partial<IntegrationMcpDelivery>): IntegrationMcpDelivery {
  return { command: 'npx', args: [], envMapping: {}, ...over } as IntegrationMcpDelivery;
}

describe('specOf — the spec must be the one the RUNTIME asks for', () => {
  it('reads the package out of an npx delivery, past the flags', () => {
    expect(specOf(delivery({ command: 'npx', args: ['-y', 'mcp-server-trello@1.0.4'] }))).toBe(
      'mcp-server-trello@1.0.4',
    );
  });

  it('ignores trailing flags that follow the package', () => {
    expect(
      specOf(
        delivery({
          command: 'npx',
          args: ['-y', 'figma-developer-mcp@0.13.2', '--stdio', '--no-telemetry'],
        }),
      ),
    ).toBe('figma-developer-mcp@0.13.2');
  });

  it('reads a uvx delivery, whose spec carries no flag at all', () => {
    expect(specOf(delivery({ command: 'uvx', args: ['mcp-atlassian==0.22.1'] }))).toBe(
      'mcp-atlassian==0.22.1',
    );
  });

  it('returns null for a delivery with no child to launch', () => {
    // builtin (convex) and HTTP-relay (posthog, vercel, …) deliveries serve
    // tools in-process — there is nothing to download, so warming them would
    // be a no-op at best and a spurious build failure at worst.
    expect(specOf(delivery({ command: '', args: [] }))).toBeNull();
  });
});

describe('launcherFlagsOf — the warm must invoke the launcher like the runtime does', () => {
  it('keeps the flags BEFORE the package', () => {
    // ⚠️ postman is why this exists: its package declares a `preinstall` guard
    // of `npx only-allow pnpm`, so npm refuses to install it and
    // `npx -y <pkg>` exits 1 before the server is reached. The delivery carries
    // `--ignore-scripts` for that reason, and a warm run that dropped the flag
    // would fail on the one package that most needs warming.
    expect(
      launcherFlagsOf(
        delivery({ command: 'npx', args: ['-y', '--ignore-scripts', '@postman/x@1.0.0'] }),
      ),
    ).toEqual(['-y', '--ignore-scripts']);
  });

  it('drops the flags AFTER the package — those belong to the server', () => {
    // figma's `--stdio --no-telemetry` are the server's own arguments; handing
    // them to `npx --package … -c true` would be meaningless at best.
    expect(
      launcherFlagsOf(
        delivery({
          command: 'npx',
          args: ['-y', 'figma-developer-mcp@0.13.2', '--stdio', '--no-telemetry'],
        }),
      ),
    ).toEqual(['-y']);
  });

  it('is empty for a uvx delivery, whose spec is the first argument', () => {
    expect(launcherFlagsOf(delivery({ command: 'uvx', args: ['mcp-atlassian==0.22.1'] }))).toEqual(
      [],
    );
  });
});

describe('warmTargets — derived from the registry, never a second list', () => {
  it('covers every enabled integration that spawns a child, and only those', () => {
    // ⚠️ This is the anti-drift assertion. The warm list must be computed from
    // the same registry the `mcp-run` shim resolves at runtime; a hardcoded
    // list (in this file, or in the box Dockerfile) would silently warm the
    // WRONG version the next time someone re-pins a package — and a cache
    // warmed for the wrong version is worse than a cold one, because it looks
    // warm and still downloads.
    const expected = getEnabledIntegrations()
      .map((i) => i.delivery?.mcp)
      .filter((d): d is IntegrationMcpDelivery => Boolean(d))
      .map((d) => specOf(d))
      .filter((s): s is string => Boolean(s));

    const targets = warmTargets();
    expect(new Set(targets.map((t) => t.spec))).toEqual(new Set(expected));
  });

  it('de-duplicates a spec shared by two integrations', () => {
    // jira and confluence are both served by one `mcp-atlassian` pin (confluence
    // is a display alias over jira's credential), so warming it twice would pay
    // the same download twice.
    const specs = warmTargets().map((t) => t.spec);
    expect(specs.length).toBe(new Set(specs).size);
  });

  it('carries the launcher, because npx and uvx warm differently', () => {
    for (const t of warmTargets()) {
      expect(t.launcher).not.toBe('');
      expect(t.spec).not.toBe('');
    }
    // The registry uses exactly these two launchers today; a new one would need
    // its own warm recipe, and `mcp-warm` reports it as skipped rather than
    // pretending it warmed.
    expect(new Set(warmTargets().map((t) => t.launcher))).toEqual(new Set(['npx', 'uvx']));
  });

  it("carries postman's --ignore-scripts through from the registry", () => {
    // End-to-end over the REAL registry: the flag has to survive from the
    // delivery into the warm target, or the box image warms postman with the
    // wrong invocation and it fails there exactly as it does at runtime.
    const postman = warmTargets().find((t) => t.spec.includes('postman-mcp-server'));
    expect(postman).toBeDefined();
    expect(postman?.flags).toContain('--ignore-scripts');
  });

  it('finds a non-trivial number of packages — a silently empty list is a bug', () => {
    // If the registry shape ever changes under us (delivery moved, renamed),
    // `warmTargets` would quietly return [] and the image would look warmed
    // while every box downloads from scratch. Fail loudly instead.
    expect(warmTargets().length).toBeGreaterThan(10);
  });
});
