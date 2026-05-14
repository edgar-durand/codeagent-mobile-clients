/**
 * Protocol-level types for TUI chrome steps and interactive selectors.
 *
 * Agent-AGNOSTIC: the *shapes* below are part of the chunk-protocol contract
 * between the CLI/IDE clients and the mobile app. The *parsers* that recognize
 * chrome lines and selectors live next to each agent's runtime strategy
 * (e.g. apps/cli/src/agents/claude/parsing.ts) because the glyphs and
 * conventions vary per agent.
 */

export type ChromeToolType = 'read' | 'edit' | 'bash' | 'search' | 'thinking' | 'other';

export interface ChromeStep {
  tool: ChromeToolType;
  label: string;
  detail?: string;
  status: 'running' | 'done';
}

export interface SelectPrompt {
  question: string;
  options: string[];
  optionDescriptions: string[];
  /** 0-based index of the highlighted item (always 0 for numbered selectors). */
  currentIndex: number;
}
