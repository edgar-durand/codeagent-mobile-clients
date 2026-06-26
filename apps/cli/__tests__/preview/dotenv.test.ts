import { describe, it, expect } from 'vitest';
import { parseDotenv, serializeDotenv, ENV_KEY_RE } from '../../src/services/preview/dotenv';

describe('parseDotenv', () => {
  it('parses simple KEY=VALUE lines preserving order', () => {
    expect(parseDotenv('A=1\nB=2')).toEqual([
      { key: 'A', value: '1' },
      { key: 'B', value: '2' },
    ]);
  });
  it('ignores blank lines and # comments', () => {
    expect(parseDotenv('# header\n\nA=1\n   # indented comment\nB=2\n')).toEqual([
      { key: 'A', value: '1' },
      { key: 'B', value: '2' },
    ]);
  });
  it('strips an optional `export ` prefix', () => {
    expect(parseDotenv('export A=1')).toEqual([{ key: 'A', value: '1' }]);
  });
  it('keeps `=` inside the value', () => {
    expect(parseDotenv('URL=postgres://u:p@h:5432/db?x=1')).toEqual([
      { key: 'URL', value: 'postgres://u:p@h:5432/db?x=1' },
    ]);
  });
  it('unquotes single- and double-quoted values', () => {
    expect(parseDotenv(`A="hello world"\nB='c#d'`)).toEqual([
      { key: 'A', value: 'hello world' },
      { key: 'B', value: 'c#d' },
    ]);
  });
  it('last-wins on duplicate keys', () => {
    expect(parseDotenv('A=1\nA=2')).toEqual([{ key: 'A', value: '2' }]);
  });
  it('returns [] for empty input', () => {
    expect(parseDotenv('')).toEqual([]);
  });
});

describe('serializeDotenv', () => {
  it('writes KEY=value with a managed header and trailing newline', () => {
    const out = serializeDotenv([{ key: 'A', value: '1' }, { key: 'B', value: '2' }]);
    expect(out).toBe('# Managed by CodeAgent\nA=1\nB=2\n');
  });
  it('quotes values containing whitespace, # or newlines', () => {
    const out = serializeDotenv([
      { key: 'A', value: 'hello world' },
      { key: 'B', value: 'c#d' },
      { key: 'C', value: 'line1\nline2' },
    ]);
    expect(out).toBe('# Managed by CodeAgent\nA="hello world"\nB="c#d"\nC="line1\\nline2"\n');
  });
  it('round-trips parse(serialize(x)) back to x', () => {
    const vars = [
      { key: 'URL', value: 'postgres://u:p@h:5432/db?x=1' },
      { key: 'NAME', value: 'hello world' },
    ];
    expect(parseDotenv(serializeDotenv(vars))).toEqual(vars);
  });
});

describe('ENV_KEY_RE', () => {
  it('accepts valid keys and rejects invalid', () => {
    expect(ENV_KEY_RE.test('DATABASE_URL')).toBe(true);
    expect(ENV_KEY_RE.test('_X1')).toBe(true);
    expect(ENV_KEY_RE.test('1ABC')).toBe(false);
    expect(ENV_KEY_RE.test('A B')).toBe(false);
    expect(ENV_KEY_RE.test('')).toBe(false);
  });
});
