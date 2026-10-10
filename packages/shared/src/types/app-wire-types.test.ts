// Epic codeagent-pi6: the Composer, feature-gate and compression-savings wire
// types used to live only in codeagent-mobile's `@codeam/app-shared`, with a
// hand-synced copy inside api-v2. They are owned here now so all three
// consumers import one declaration.
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  DEFAULT_FEATURE_GATES,
  type AgentSavings,
  type CompressionSavingsData,
  type ComposerStructureRequest,
  type ComposerStructureStreamEvent,
  type FeatureGateKey,
} from '../index';

describe('app wire types exported from @codeam/shared', () => {
  it('feature gates fail closed', () => {
    expect(DEFAULT_FEATURE_GATES).toEqual({ beads: false });
    expectTypeOf<FeatureGateKey>().toEqualTypeOf<'beads'>();
  });

  it('composer request + stream event shapes', () => {
    const req: ComposerStructureRequest = {
      voiceTranscript: 'fix the login bug',
      attachments: [{ filename: 'err.log', mime: 'text/plain', sizeBytes: 12, textExcerpt: 'boom' }],
      sessionContext: { sessionId: 's1', agentId: 'claude', modelId: null, lastMessageIds: [] },
      requestAutoTitle: true,
    };
    const done: ComposerStructureStreamEvent = {
      event: 'done',
      data: { tokensIn: 1, tokensOut: 2, latencyMs: 3 },
    };
    expect(req.attachments[0]?.textExcerpt).toBe('boom');
    expect(done.event).toBe('done');
  });

  it('compression savings response nests per-agent rows', () => {
    expectTypeOf<CompressionSavingsData['perAgent']>().toEqualTypeOf<AgentSavings[]>();
  });
});
