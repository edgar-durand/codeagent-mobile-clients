import { describe, it, expect } from 'vitest';
import {
  textReferencesInternal,
  pathIsInternal,
  toolCallReferencesInternal,
  internalPathPermissionOutcome,
} from '../../../src/agents/acp/internal-paths';

const HOME = '/home/box';

describe('internal-paths — CodeAgent internals guard predicates', () => {
  describe('textReferencesInternal (bash command / tool input)', () => {
    it('flags references to ~/.codeam and house-claude', () => {
      expect(textReferencesInternal('cat ~/.codeam/host-agent.json')).toBe(true);
      expect(textReferencesInternal('ls /home/box/.codeam/self-hosted')).toBe(true);
      expect(textReferencesInternal('cat ~/.codeam/house-claude/x/.claude.json')).toBe(true);
      expect(textReferencesInternal('cat .codeam-host.log')).toBe(true);
    });
    it('does NOT flag the bootstrap node dir or normal commands', () => {
      expect(textReferencesInternal('/tmp/codeam-node20/bin/node')).toBe(false); // no leading dot
      expect(textReferencesInternal('bd ready')).toBe(false);
      expect(textReferencesInternal('bd remember "did the thing"')).toBe(false);
      expect(textReferencesInternal('npm test')).toBe(false);
      expect(textReferencesInternal(undefined)).toBe(false);
    });
  });

  describe('pathIsInternal (fs read/write seam, absolute paths)', () => {
    it('flags home-anchored internal paths', () => {
      expect(pathIsInternal(`${HOME}/.codeam/host-agent.json`, HOME)).toBe(true);
      expect(pathIsInternal(`${HOME}/.codeam`, HOME)).toBe(true);
      expect(pathIsInternal(`${HOME}/.beads/shared-server/dolt`, HOME)).toBe(true);
      expect(pathIsInternal(`${HOME}/.codeam-host.log`, HOME)).toBe(true);
      expect(pathIsInternal(`${HOME}/.codeam/house-claude/dep/x`, HOME)).toBe(true);
    });
    it('does NOT flag the project or its own ./.beads', () => {
      expect(pathIsInternal(`${HOME}/.codeam/self-hosted/dep/repo/src/index.ts`, HOME)).toBe(true); // still internal (under .codeam)
      expect(pathIsInternal('/workspaces/project/.beads/config.yaml', HOME)).toBe(false); // project beads, not home
      expect(pathIsInternal('/workspaces/project/src/index.ts', HOME)).toBe(false);
      expect(pathIsInternal(null, HOME)).toBe(false);
    });
    it('is not fooled by a sibling prefix (.codeam-extra)', () => {
      expect(pathIsInternal(`${HOME}/.codeam-extra/x`, HOME)).toBe(false);
    });
  });

  describe('toolCallReferencesInternal (ACP permission request)', () => {
    it('flags a bash tool call touching an internal path', () => {
      expect(
        toolCallReferencesInternal({ title: 'Bash', rawInput: { command: 'cat ~/.codeam/config.json' } }),
      ).toBe(true);
    });
    it('flags via the title too', () => {
      expect(toolCallReferencesInternal({ title: 'Read ~/.codeam/host-agent.json' })).toBe(true);
    });
    it('does not flag a normal tool call', () => {
      expect(
        toolCallReferencesInternal({ title: 'Bash', rawInput: { command: 'npm run build' } }),
      ).toBe(false);
    });
  });

  // The REAL decision the runner's onRequestPermission uses (verbatim).
  describe('internalPathPermissionOutcome (the enforced deny decision)', () => {
    const internalCall = { title: 'Bash', rawInput: { command: 'cat ~/.codeam/host-agent.json' } };
    const cleanCall = { title: 'Bash', rawInput: { command: 'npm run build' } };

    it('returns null for a clean tool call (caller proceeds to auto-approve)', () => {
      expect(
        internalPathPermissionOutcome({ toolCall: cleanCall, options: [{ optionId: 'a', kind: 'allow_always' }] }),
      ).toBeNull();
    });
    it('DENIES an internal-path call by selecting the broadest reject option', () => {
      const out = internalPathPermissionOutcome({
        toolCall: internalCall,
        options: [
          { optionId: 'a', kind: 'allow_always' },
          { optionId: 'r1', kind: 'reject_once' },
          { optionId: 'r2', kind: 'reject_always' },
        ],
      });
      expect(out).toEqual({ outcome: { outcome: 'selected', optionId: 'r2' } });
    });
    it('falls back to reject_once when reject_always is absent', () => {
      const out = internalPathPermissionOutcome({
        toolCall: internalCall,
        options: [
          { optionId: 'a', kind: 'allow_once' },
          { optionId: 'r1', kind: 'reject_once' },
        ],
      });
      expect(out).toEqual({ outcome: { outcome: 'selected', optionId: 'r1' } });
    });
    it('CANCELS the tool when the agent offers no reject option', () => {
      const out = internalPathPermissionOutcome({
        toolCall: internalCall,
        options: [{ optionId: 'a', kind: 'allow_always' }],
      });
      expect(out).toEqual({ outcome: { outcome: 'cancelled' } });
    });
  });
});
