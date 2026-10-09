import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildFleetBoxMigrateArgs,
  buildFleetBoxRunArgs,
  defaultDockerRunner,
  fleetLaneKey,
  fleetRefCanRecreate,
  isFleetBoxRefPayload,
  isFleetContainerName,
  isFleetCreateBoxPayload,
  isFleetMigrateBoxImagePayload,
  isFleetPruneHostPayload,
  isMissingContainerError,
  isMissingVolumeError,
  resolveFleetBoxImage,
} from '../../src/commands/host/fleet-docker';
import * as hostAgent from '../../src/commands/host-agent';
import type { RemoteCommand } from '../../src/services/command-relay.service';

const LIMITS = { memoryMb: 1536, cpus: 1, pidsLimit: 512, diskGb: 10 };
const BOX = { boxId: 'box_1', containerName: 'codeam-box-u1', apiOrigin: 'https://api.example' };

function cmd(type: string, payload: Record<string, unknown>): RemoteCommand {
  return { id: 'c1', sessionId: 's1', type, payload };
}

describe('fleet-docker', () => {
  let savedImage: string | undefined;
  beforeEach(() => {
    savedImage = process.env.CODEAM_FLEET_BOX_IMAGE;
    delete process.env.CODEAM_FLEET_BOX_IMAGE;
  });
  afterEach(() => {
    if (savedImage === undefined) delete process.env.CODEAM_FLEET_BOX_IMAGE;
    else process.env.CODEAM_FLEET_BOX_IMAGE = savedImage;
  });

  it('host-agent keeps re-exporting the moved public surface (import paths unchanged)', () => {
    expect(hostAgent.defaultDockerRunner).toBe(defaultDockerRunner);
    expect(hostAgent.fleetLaneKey).toBe(fleetLaneKey);
  });

  describe('container-name allowlist', () => {
    it.each(['codeam-box-abc123', 'codeam-box-0'])('accepts %s', (n) => {
      expect(isFleetContainerName(n)).toBe(true);
    });
    it.each(['postgres', 'codeam-box-', 'codeam-box-ABC', 'codeam-box-a;rm -rf /', 42])(
      'refuses %s',
      (n) => {
        expect(isFleetContainerName(n)).toBe(false);
      },
    );
  });

  describe('payload guards', () => {
    it('create requires a non-empty token, origin and finite limits', () => {
      expect(isFleetCreateBoxPayload({ ...BOX, enrollToken: 't', limits: LIMITS })).toBe(true);
      expect(isFleetCreateBoxPayload({ ...BOX, enrollToken: '', limits: LIMITS })).toBe(false);
      expect(
        isFleetCreateBoxPayload({ ...BOX, enrollToken: 't', limits: { ...LIMITS, cpus: NaN } }),
      ).toBe(false);
      expect(
        isFleetCreateBoxPayload({
          ...BOX,
          containerName: 'evil',
          enrollToken: 't',
          limits: LIMITS,
        }),
      ).toBe(false);
    });

    it('migrate REJECTS a payload that carries an enroll token', () => {
      expect(isFleetMigrateBoxImagePayload({ ...BOX, limits: LIMITS })).toBe(true);
      expect(isFleetMigrateBoxImagePayload({ ...BOX, limits: LIMITS, enrollToken: 't' })).toBe(
        false,
      );
    });

    it('ref validates the optional recreate credentials only when present', () => {
      const ref = { boxId: 'box_1', containerName: 'codeam-box-u1' };
      expect(isFleetBoxRefPayload(ref)).toBe(true);
      expect(isFleetBoxRefPayload({ ...ref, removeVolume: 'yes' })).toBe(false);
      expect(isFleetBoxRefPayload({ ...ref, enrollToken: '' })).toBe(false);
      expect(isFleetBoxRefPayload({ ...ref, limits: { memoryMb: 1 } })).toBe(false);
      expect(fleetRefCanRecreate(ref)).toBe(false);
      expect(
        fleetRefCanRecreate({ ...ref, enrollToken: 't', apiOrigin: 'https://a', limits: LIMITS }),
      ).toBe(true);
    });

    it('prune needs both boolean flags', () => {
      expect(isFleetPruneHostPayload({ images: true, buildCache: false })).toBe(true);
      expect(isFleetPruneHostPayload({ images: true })).toBe(false);
      expect(isFleetPruneHostPayload(null)).toBe(false);
    });
  });

  it('treats already-gone containers/volumes as idempotent success', () => {
    expect(isMissingContainerError('Error: No such container: codeam-box-u1')).toBe(true);
    expect(isMissingVolumeError('Error: no such volume: codeam-box-u1')).toBe(true);
    expect(isMissingContainerError('permission denied')).toBe(false);
  });

  it('fleetLaneKey lanes per container, the host for a prune, null for non-fleet', () => {
    expect(fleetLaneKey(cmd('fleet_stop_box', { containerName: 'codeam-box-u1' }))).toBe(
      'codeam-box-u1',
    );
    expect(fleetLaneKey(cmd('fleet_prune_host', { images: true, buildCache: true }))).toBe('host');
    expect(fleetLaneKey(cmd('fleet_stop_box', {}))).toBe('fleet_stop_box');
    expect(fleetLaneKey(cmd('self_hosted_deploy', { containerName: 'x' }))).toBeNull();
  });

  describe('docker run template', () => {
    it('builds the full isolation argv with the token as a BARE -e (never a value in argv)', () => {
      const args = buildFleetBoxRunArgs({ ...BOX, limits: LIMITS });
      expect(args).toEqual([
        'run',
        '-d',
        '--pull=always',
        '--name',
        'codeam-box-u1',
        '--restart',
        'unless-stopped',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges',
        '--memory',
        '1536m',
        '--cpus',
        '1',
        '--pids-limit',
        '512',
        '--network',
        'fleet-net',
        '--label',
        'com.codeagent.user-id=u1',
        '--label',
        'com.codeagent.box-id=box_1',
        '--label',
        'com.codeagent.created-by=fleet',
        '-v',
        'codeam-box-u1:/home/box',
        '-e',
        'CODEAM_ENROLL_TOKEN',
        '-e',
        'CODEAM_API_URL=https://api.example',
        '-e',
        'CODEAM_HOST_LABEL=CodeAgent Box',
        '-e',
        'CODEAM_ENROLL_EPHEMERAL=1',
        'ghcr.io/edgar-durand/codeam-box:latest',
      ]);
      expect(args.some((a) => a.startsWith('CODEAM_ENROLL_TOKEN='))).toBe(false);
    });

    it('an image override is used verbatim and skips --pull=always', () => {
      process.env.CODEAM_FLEET_BOX_IMAGE = 'codeam-box:ci';
      expect(resolveFleetBoxImage()).toBe('codeam-box:ci');
      const args = buildFleetBoxRunArgs({ ...BOX, limits: LIMITS });
      expect(args).not.toContain('--pull=always');
      expect(args[args.length - 1]).toBe('codeam-box:ci');
    });

    it('migrate = the same template as `create`, detached-less and pull-less', () => {
      const run = buildFleetBoxRunArgs({ ...BOX, limits: LIMITS });
      const migrate = buildFleetBoxMigrateArgs({ ...BOX, limits: LIMITS });
      expect(migrate[0]).toBe('create');
      expect(migrate).not.toContain('-d');
      expect(migrate).not.toContain('--pull=always');
      expect(migrate.slice(1)).toEqual(
        run.filter((a) => !['run', '-d', '--pull=always'].includes(a)),
      );
    });
  });
});
