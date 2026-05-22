import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  isHelpFlag,
  tryShowSubcommandHelp,
  _subcommandHelpKeys,
} from '../../src/commands/subcommand-help';

describe('subcommand-help isHelpFlag', () => {
  it('matches --help and -h, nothing else', () => {
    expect(isHelpFlag('--help')).toBe(true);
    expect(isHelpFlag('-h')).toBe(true);
    expect(isHelpFlag('help')).toBe(false);
    expect(isHelpFlag('--HELP')).toBe(false);
    expect(isHelpFlag(undefined)).toBe(false);
    expect(isHelpFlag('')).toBe(false);
  });
});

describe('subcommand-help tryShowSubcommandHelp', () => {
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    writeSpy.mockRestore();
  });

  // Every renderer registered in subcommand-help.ts must:
  //   - print non-empty output (we mock stdout and assert .write was called)
  //   - mention its own command name so the CI smoke matrix's regex
  //     (`new RegExp(cmd, 'i')`) matches reliably.
  for (const cmd of _subcommandHelpKeys) {
    it(`prints help for "${cmd}" --help that contains the command name`, () => {
      const handled = tryShowSubcommandHelp(cmd, ['--help']);
      expect(handled).toBe(true);
      expect(writeSpy).toHaveBeenCalled();
      const printed = writeSpy.mock.calls
        .map((c: unknown[]) => String(c[0]))
        .join('\n');
      // Case-insensitive substring — most renderers print the bold
      // "codeam <cmd>" header, but some compound commands (pair-auto)
      // would otherwise miss a strict equality match.
      expect(printed.toLowerCase()).toContain(cmd.toLowerCase());
    });

    it(`accepts -h shorthand for "${cmd}"`, () => {
      const handled = tryShowSubcommandHelp(cmd, ['-h']);
      expect(handled).toBe(true);
    });
  }

  it('returns false for an unknown command', () => {
    const handled = tryShowSubcommandHelp('definitely-not-a-command', ['--help']);
    expect(handled).toBe(false);
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('returns false when args[0] is not the help flag', () => {
    expect(tryShowSubcommandHelp('pair', [])).toBe(false);
    expect(tryShowSubcommandHelp('pair', ['--agent', 'claude'])).toBe(false);
    expect(tryShowSubcommandHelp('link', ['claude'])).toBe(false);
  });
});
