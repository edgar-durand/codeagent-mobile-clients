import { describe, it, expect } from 'vitest';
import { filterChrome } from '../src/services/output.service';

describe('filterChrome — context compaction and thinking indicators', () => {
  it('filters standalone compaction notice "↓ N tokens"', () => {
    expect(filterChrome(['↓ 518 tokens'])).toEqual([]);
  });

  it('filters compaction notice with large token count', () => {
    expect(filterChrome(['↓ 12345 tokens'])).toEqual([]);
  });

  it('filters combined compaction + thinking indicator "↓ N tokens · thought for Ns"', () => {
    expect(filterChrome(['↓ 518 tokens · thought for 18s'])).toEqual([]);
  });

  it('filters combined compaction + thinking with larger numbers', () => {
    expect(filterChrome(['↓ 1024 tokens · thought for 120s'])).toEqual([]);
  });

  it('filters standalone extended thinking indicator "thought for Ns"', () => {
    expect(filterChrome(['thought for 18s'])).toEqual([]);
  });

  it('filters standalone extended thinking indicator with multi-digit seconds', () => {
    expect(filterChrome(['thought for 120s'])).toEqual([]);
  });

  it('does NOT filter real content lines that happen to mention tokens', () => {
    const line = 'The model uses 518 tokens per request by default.';
    expect(filterChrome([line])).toEqual([line]);
  });

  it('does NOT filter real content lines that mention thinking', () => {
    const line = 'I was thinking about the best approach here.';
    expect(filterChrome([line])).toEqual([line]);
  });

  it('filters compaction lines while preserving surrounding real content', () => {
    const input = [
      'Here is the updated function:',
      '↓ 518 tokens · thought for 18s',
      'The change was applied successfully.',
    ];
    expect(filterChrome(input)).toEqual([
      'Here is the updated function:',
      'The change was applied successfully.',
    ]);
  });

  it('filters multiple compaction lines in a single output', () => {
    const input = [
      '↓ 200 tokens',
      'Some real content',
      '↓ 400 tokens · thought for 5s',
      'thought for 30s',
    ];
    expect(filterChrome(input)).toEqual(['Some real content']);
  });
});
