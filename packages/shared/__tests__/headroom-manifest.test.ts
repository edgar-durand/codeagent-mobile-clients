import { describe, it, expect } from 'vitest';
import {
  HEADROOM_PROXY_PORT,
  HEADROOM_BACKEND_ENV,
  HEADROOM_PIP_COMPANIONS,
  HEADROOM_EXTRAS_BY_SURFACE,
  HEADROOM_MODELS,
  headroomPipPackage,
  headroomSnapshotDownloadLine,
  headroomModelPredownloadScript,
} from '../src/headroom/manifest';

/**
 * BYTE-EQUALITY contract: the manifest renderers must reproduce the exact
 * literals they replaced in the provisioning surfaces. A mismatch here means
 * a provisioning behavior change snuck in through the manifest — every
 * string below is copied verbatim from the pre-manifest source.
 */
describe('headroom manifest — byte-equality with the previous literals', () => {
  it('pip package: self-hosted + codespace surfaces render headroom-ai[proxy,code]', () => {
    // Previous literal in apps/cli/src/commands/host-agent.ts
    // (`headroom-ai[${extras.join(',')}]` with default extras) and in
    // api-v2 github-ssh.service.ts line ~623 ("headroom-ai[proxy,code]").
    expect(headroomPipPackage(HEADROOM_EXTRAS_BY_SURFACE.selfHosted)).toBe(
      'headroom-ai[proxy,code]',
    );
    expect(headroomPipPackage(HEADROOM_EXTRAS_BY_SURFACE.codespace)).toBe(
      'headroom-ai[proxy,code]',
    );
  });

  it('pip package: on-demand surface adds the image extra', () => {
    // Previous literal in apps/cli/src/services/headroom/configure.ts
    // (extras: ['proxy', 'code', 'image']).
    expect(headroomPipPackage(HEADROOM_EXTRAS_BY_SURFACE.onDemand)).toBe(
      'headroom-ai[proxy,code,image]',
    );
  });

  it('pip companions match the SERVER_DEPS literal (host-agent.ts) and the codespace install line', () => {
    expect(HEADROOM_PIP_COMPANIONS).toEqual([
      'fastapi',
      'uvicorn',
      'httpx[http2]',
      'websockets',
      'zstandard',
    ]);
  });

  it('model pre-download script is byte-identical to host-agent.ts predownloadPy', () => {
    // Previous literal in apps/cli/src/commands/host-agent.ts (self-hosted):
    const previous = [
      'from huggingface_hub import snapshot_download',
      'snapshot_download("chopratejas/kompress-v2-base", allow_patterns=["*.json","onnx/*.onnx","kompress-int8-wo.onnx"])',
      'snapshot_download("answerdotai/ModernBERT-base", allow_patterns=["*.json","tokenizer*","*.txt","vocab*","merges*"])',
    ].join('\n');
    expect(headroomModelPredownloadScript()).toBe(previous);
  });

  it('spaced rendering matches the codespace bootstrap lines (github-ssh.service.ts ~643-644)', () => {
    // The bash composer's python heredoc puts a space after each comma.
    expect(headroomSnapshotDownloadLine(HEADROOM_MODELS[0], { spaceAfterComma: true })).toBe(
      'snapshot_download("chopratejas/kompress-v2-base", allow_patterns=["*.json", "onnx/*.onnx", "kompress-int8-wo.onnx"])',
    );
    expect(headroomSnapshotDownloadLine(HEADROOM_MODELS[1], { spaceAfterComma: true })).toBe(
      'snapshot_download("answerdotai/ModernBERT-base", allow_patterns=["*.json", "tokenizer*", "*.txt", "vocab*", "merges*"])',
    );
  });

  it('models: exactly the two HF repos (ONNX model + tokenizer-only)', () => {
    expect(HEADROOM_MODELS.map((m) => m.repo)).toEqual([
      'chopratejas/kompress-v2-base',
      'answerdotai/ModernBERT-base',
    ]);
  });

  it('proxy port + ONNX backend env', () => {
    expect(HEADROOM_PROXY_PORT).toBe(8787);
    expect(HEADROOM_BACKEND_ENV).toEqual({ HEADROOM_KOMPRESS_BACKEND: 'onnx_cpu' });
  });
});
