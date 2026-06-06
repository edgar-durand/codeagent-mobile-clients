/**
 * Story — VS Code plugin nudges the user to update when a newer
 * version is on the Marketplace, mirroring the CLI's auto-update
 * advisory.
 *
 * Why this test exists
 * --------------------
 * The CLI auto-updates on a stale registry check (memory:
 * project_codeam_link_shipped + the auto-update task #83). The
 * VS Code + JetBrains plugins have no equivalent today, so users
 * sit on an old build that QA already has a fix for. We can't
 * silently re-install a VS Code extension (the host owns lifecycle),
 * but we can surface a banner that recommends update + opens the
 * extensions view with one click. The user requested this verbatim:
 * "como mismo lo hace el cli ... mostrar un banner en los plugins
 *  que recomiende actualizar para solucionar errores conocidos".
 *
 * Expected behaviour
 * ------------------
 * 1. Service queries the VS Code Marketplace for the latest published
 *    version of `CodeAgentMobile.codeagent-mobile`.
 * 2. If the latest is strictly greater than the current packageJSON
 *    version (semver-numeric, ignoring `-rc.N`), an information
 *    message is shown with "Update now" / "Release notes" / "Later"
 *    actions.
 * 3. "Update now" triggers `workbench.extensions.search` so the user
 *    lands on the extension page with the Update button visible.
 * 4. The latest version is cached in `globalState` for 24 h; the
 *    next activation reads from cache instead of re-hitting the
 *    marketplace.
 * 5. Dismissing the banner with "Later" suppresses the banner for
 *    the SAME version on subsequent activations until a newer one
 *    is published.
 *
 * Test strategy
 * -------------
 * Drive `checkForUpdatesNow` directly with stubbed fetch + stubbed
 * `vscode.window.showInformationMessage`. The marketplace fetch is
 * abstracted behind a test seam so the spec doesn't touch the
 * network.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { showInformationMessage, executeCommand, openExternal } = vi.hoisted(() => ({
  showInformationMessage: vi.fn(),
  executeCommand: vi.fn(),
  openExternal: vi.fn(),
}));

vi.mock('vscode', () => ({
  default: {},
  window: { showInformationMessage },
  commands: { executeCommand },
  env: { openExternal },
  Uri: { parse: (s: string) => ({ toString: () => s }) },
}));

import {
  checkForUpdatesNow,
  _updateNotifierTestSeam,
} from '../../src/services/update-notifier.service';

interface MemoryStore {
  data: Record<string, unknown>;
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

function makeStore(): MemoryStore {
  const data: Record<string, unknown> = {};
  return {
    data,
    get<T>(key: string): T | undefined {
      return data[key] as T | undefined;
    },
    update(key: string, value: unknown): Thenable<void> {
      data[key] = value;
      return Promise.resolve();
    },
  };
}

describe('story: VSC update-notifier recommends update on stale install', () => {
  beforeEach(() => {
    showInformationMessage.mockReset().mockResolvedValue(undefined);
    executeCommand.mockReset().mockResolvedValue(undefined);
    _updateNotifierTestSeam.setFetcher(null);
  });

  it('shows the banner when the marketplace reports a newer version', async () => {
    _updateNotifierTestSeam.setFetcher(async () => '2.11.0');
    const store = makeStore();

    await checkForUpdatesNow({
      currentVersion: '2.10.8',
      globalState: store as never,
    });

    expect(showInformationMessage).toHaveBeenCalledTimes(1);
    const [msg, ...actions] = showInformationMessage.mock.calls[0];
    expect(String(msg)).toContain('2.11.0');
    expect(actions).toEqual(expect.arrayContaining(['Update now', 'Release notes', 'Later']));
  });

  it('opens the extensions view when the user clicks Update now', async () => {
    _updateNotifierTestSeam.setFetcher(async () => '2.11.0');
    showInformationMessage.mockResolvedValueOnce('Update now');
    const store = makeStore();

    await checkForUpdatesNow({
      currentVersion: '2.10.8',
      globalState: store as never,
    });

    expect(executeCommand).toHaveBeenCalledWith(
      'workbench.extensions.search',
      '@id:CodeAgentMobile.codeagent-mobile',
    );
  });

  it('does NOT show the banner when current >= latest', async () => {
    _updateNotifierTestSeam.setFetcher(async () => '2.10.8');
    const store = makeStore();

    await checkForUpdatesNow({
      currentVersion: '2.10.8',
      globalState: store as never,
    });

    expect(showInformationMessage).not.toHaveBeenCalled();
  });

  it('caches the latest version for the next 24 h', async () => {
    const fetcher = vi.fn().mockResolvedValue('2.11.0');
    _updateNotifierTestSeam.setFetcher(fetcher);
    const store = makeStore();

    // First call hits the network.
    await checkForUpdatesNow({
      currentVersion: '2.10.8',
      globalState: store as never,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);

    // Second call within the TTL window uses the cache — no second fetch.
    showInformationMessage.mockClear();
    await checkForUpdatesNow({
      currentVersion: '2.10.8',
      globalState: store as never,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(showInformationMessage).toHaveBeenCalledTimes(1);
  });

  it('suppresses the banner for the same version after Later', async () => {
    _updateNotifierTestSeam.setFetcher(async () => '2.11.0');
    showInformationMessage.mockResolvedValueOnce('Later');
    const store = makeStore();

    // First activation: banner shows, user picks Later.
    await checkForUpdatesNow({
      currentVersion: '2.10.8',
      globalState: store as never,
    });
    expect(showInformationMessage).toHaveBeenCalledTimes(1);

    // Second activation: same latest, banner stays silent.
    showInformationMessage.mockClear();
    await checkForUpdatesNow({
      currentVersion: '2.10.8',
      globalState: store as never,
    });
    expect(showInformationMessage).not.toHaveBeenCalled();

    // Newer version published → banner returns.
    _updateNotifierTestSeam.setFetcher(async () => '2.12.0');
    // Bust the 24h cache deliberately so the new fetch lands.
    store.data['codeam.updateNotifier.cache'] = undefined;
    showInformationMessage.mockClear();
    await checkForUpdatesNow({
      currentVersion: '2.10.8',
      globalState: store as never,
    });
    expect(showInformationMessage).toHaveBeenCalledTimes(1);
  });
});
