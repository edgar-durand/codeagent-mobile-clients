/**
 * Headroom provisioning manifest — the SINGLE source of truth for what a
 * Headroom install consists of, rendered by every provisioning surface:
 *
 *   - codespace bootstrap (bash composer in the backend repo,
 *     `apps/api-v2/src/codespaces/github-ssh.service.ts` — adopts in PR-2),
 *   - self-hosted deploy (TS installer, CLI `commands/host-agent.ts`
 *     `setupHeadroomForSelfHosted`),
 *   - on-demand local sessions ("Session add-ons → Cost-saving", CLI
 *     `services/headroom/configure.ts`).
 *
 * Values are DATA-first (arrays/records, plus tiny pure renderers) so both
 * the TS installer and a bash composer can interpolate from them. Renderers
 * are byte-exact with the literals they replaced — guarded by
 * `packages/shared/__tests__/headroom-manifest.test.ts`.
 *
 * ⚠️ The extras matter: `[proxy,code]` pulls the ONNX compression engines
 * (Kompress + tree-sitter CodeCompressor). NEVER add `[ml]` — that's
 * multi-GB PyTorch, and a broken/cold torch wedges every prompt at
 * "Thinking…". The models are pre-downloaded at provision time because the
 * proxy eager-loads with `allow_download=False` and a cold cache defers the
 * ~840 MB download to the first prompt (blowing the agent's ~90 s idle
 * timeout).
 */

/** Local proxy port the agent's config is routed to. */
export const HEADROOM_PROXY_PORT = 8787;

/**
 * Env that pins the ONNX backend on the proxy process — never imports
 * torch. Spread into the proxy launch env on every surface.
 */
export const HEADROOM_BACKEND_ENV = {
  HEADROOM_KOMPRESS_BACKEND: 'onnx_cpu',
} as const;

/**
 * The proxy's HTTP/server companion packages, installed alongside the
 * `headroom-ai[...]` package. The COMPRESSION ENGINES come from the
 * headroom-ai extras — NOT this list.
 */
export const HEADROOM_PIP_COMPANIONS: readonly string[] = [
  'fastapi',
  'uvicorn',
  'httpx[http2]',
  'websockets',
  'zstandard',
];

/** The three provisioning surfaces (see module doc). */
export type HeadroomSurface = 'codespace' | 'selfHosted' | 'onDemand';

/**
 * pip extras per surface. `onDemand` additionally ships `image`
 * (image-compression support, added with the Session add-ons path in
 * codeam-cli@2.49.0); the older codespace/self-hosted install strings
 * remain `[proxy,code]` byte-for-byte.
 */
export const HEADROOM_EXTRAS_BY_SURFACE: Readonly<Record<HeadroomSurface, readonly string[]>> = {
  codespace: ['proxy', 'code'],
  selfHosted: ['proxy', 'code'],
  onDemand: ['proxy', 'code', 'image'],
};

/** `headroom-ai[<extras>]` — the pip requirement string. */
export function headroomPipPackage(extras: readonly string[]): string {
  return `headroom-ai[${extras.join(',')}]`;
}

/** One HuggingFace repo to pre-warm into the HF cache at provision time. */
export interface HeadroomModelSpec {
  repo: string;
  /** `snapshot_download(..., allow_patterns=[…])` filter. */
  allowPatterns: readonly string[];
}

/**
 * The two HF repos Kompress needs. kompress-v2-base is the ONNX model
 * (skip its .pt/.safetensors torch artifacts); ModernBERT-base is the
 * TOKENIZER ONLY (skip its model weights).
 */
export const HEADROOM_MODELS: readonly HeadroomModelSpec[] = [
  {
    repo: 'chopratejas/kompress-v2-base',
    allowPatterns: ['*.json', 'onnx/*.onnx', 'kompress-int8-wo.onnx'],
  },
  {
    repo: 'answerdotai/ModernBERT-base',
    allowPatterns: ['*.json', 'tokenizer*', '*.txt', 'vocab*', 'merges*'],
  },
];

/** Formatting knob so each surface can stay byte-identical to its
 *  historical literal (the CLI joins patterns with `,`, the codespace
 *  bash composer with `, `). */
export interface HeadroomPythonRenderOpts {
  /** Put a space after the commas between allow_patterns entries. */
  spaceAfterComma?: boolean;
}

/** Render one `snapshot_download(...)` python line for a model. */
export function headroomSnapshotDownloadLine(
  model: HeadroomModelSpec,
  opts: HeadroomPythonRenderOpts = {},
): string {
  const sep = opts.spaceAfterComma ? ', ' : ',';
  const patterns = model.allowPatterns.map((p) => `"${p}"`).join(sep);
  return `snapshot_download("${model.repo}", allow_patterns=[${patterns}])`;
}

/**
 * The full model pre-download python snippet (import + one
 * `snapshot_download` per model), newline-joined — what the surfaces pass
 * to `python -c` / a heredoc.
 */
export function headroomModelPredownloadScript(opts: HeadroomPythonRenderOpts = {}): string {
  return [
    'from huggingface_hub import snapshot_download',
    ...HEADROOM_MODELS.map((m) => headroomSnapshotDownloadLine(m, opts)),
  ].join('\n');
}
