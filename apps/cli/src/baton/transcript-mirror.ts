import * as fs from 'fs';
import type { NormalizedMessage } from '@codeam/shared';
import type { RuntimeStrategy } from '../agents/strategy';

export interface TranscriptMirrorDeps {
  runtime: Pick<RuntimeStrategy, 'resolveHistoryFile' | 'parseHistoryFile'>;
  cwd: string;
  conversationId: string;
  onNewMessages: (messages: NormalizedMessage[]) => void;
  watch?: (file: string, onChange: () => void) => () => void;
}

/** Tails the agent's own transcript JSONL and emits only messages appended
 *  since the last emit. Reuses the runtime's history parser (no screen-scrape). */
export class TranscriptMirror {
  private emitted = 0;
  private unwatch: (() => void) | null = null;

  constructor(private readonly deps: TranscriptMirrorDeps) {}

  start(): void {
    const file = this.deps.runtime.resolveHistoryFile?.(this.deps.cwd, this.deps.conversationId);
    if (!file) return; // nothing to mirror yet
    this.emit(file);
    const watch = this.deps.watch ?? defaultWatch;
    this.unwatch = watch(file, () => this.emit(file));
  }

  stop(): void {
    this.unwatch?.();
    this.unwatch = null;
  }

  private emit(file: string): void {
    let all: NormalizedMessage[];
    try {
      all = this.deps.runtime.parseHistoryFile(file);
    } catch {
      return;
    }
    if (all.length <= this.emitted) return;
    const delta = all.slice(this.emitted);
    this.emitted = all.length;
    this.deps.onNewMessages(delta);
  }
}

function defaultWatch(file: string, onChange: () => void): () => void {
  const w = fs.watch(file, { persistent: false }, () => onChange());
  return () => w.close();
}
