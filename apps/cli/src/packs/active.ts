import type { PackRunner } from './runner';

/**
 * The session's single active pack runner. One CLI daemon owns one paired
 * session, and a session runs at most ONE pipeline at a time — a plain
 * module-level holder (the fleet-hooks/inngest.deps precedent) keeps the
 * relay handlers and the runner decoupled without threading state through
 * the command context.
 */
let active: PackRunner | null = null;

export function setActivePackRunner(runner: PackRunner | null): void {
  active = runner;
}

export function getActivePackRunner(): PackRunner | null {
  return active;
}
