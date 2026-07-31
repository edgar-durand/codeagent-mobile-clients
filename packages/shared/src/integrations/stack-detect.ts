// Repo stack → recommended integrations (Session Tools "Recommended").
//
// PURE logic only — no filesystem. The CLI reads the repo's dependency
// manifests (package.json, requirements.txt, go.mod, …), collects the raw
// dependency NAMES, and calls `recommendForDeps(names)`. Keeping the mapping
// here (single source) lets the CLI and any UI agree on what a dep implies.
import type { IntegrationId } from './types';

export type RepoStack = 'frontend' | 'backend' | 'fullstack' | 'mobile' | 'unknown';

/** The Session Tools stack-detection result (wire type, carried by the
 *  SESSION_STACK_DETECTED event). `source` distinguishes the deterministic
 *  dependency scan from the agent one-shot fallback. */
export interface RepoStackDetection {
  stack: RepoStack;
  /** Integrations the repo's dependencies directly evidence (high confidence). */
  detected: IntegrationId[];
  /** Integrations commonly paired with the classified stack, minus `detected`. */
  recommended: IntegrationId[];
  source: 'scan' | 'agent';
}

/** Exact dependency name → integration (across ecosystems: npm, pip, go, gem…). */
export const DEP_TO_INTEGRATION: Record<string, IntegrationId> = {
  // errors / observability
  '@sentry/node': 'sentry',
  '@sentry/react': 'sentry',
  '@sentry/nextjs': 'sentry',
  '@sentry/browser': 'sentry',
  'sentry-sdk': 'sentry',
  'dd-trace': 'datadog',
  'datadog-api-client': 'datadog',
  'datadog-metrics': 'datadog',
  // analytics
  'posthog-js': 'posthog',
  'posthog-node': 'posthog',
  posthog: 'posthog',
  mixpanel: 'mixpanel',
  'mixpanel-browser': 'mixpanel',
  // database / backend platforms
  convex: 'convex',
  '@supabase/supabase-js': 'supabase',
  'supabase': 'supabase',
  // infra / deploy
  vercel: 'vercel',
  '@vercel/node': 'vercel',
  wrangler: 'cloudflare',
  // comms
  '@slack/web-api': 'slack',
  '@slack/bolt': 'slack',
  'discord.js': 'discord',
  'discord-py': 'discord',
  'discord': 'discord',
  // trackers / docs / design
  '@linear/sdk': 'linear',
  '@notionhq/client': 'notion',
  'jira.js': 'jira',
  jira: 'jira',
  newman: 'postman',
  'figma-api': 'figma',
  'figma-js': 'figma',
  // email / automation
  resend: 'resend',
  n8n: 'n8n',
};

/** Dependency name PREFIX → integration (scoped-package families). */
const DEP_PREFIX_TO_INTEGRATION: Array<[string, IntegrationId]> = [
  ['@sentry/', 'sentry'],
  ['@vercel/', 'vercel'],
  ['@cloudflare/', 'cloudflare'],
  ['@supabase/', 'supabase'],
  ['@slack/', 'slack'],
  ['@datadog/', 'datadog'],
  ['@linear/', 'linear'],
  ['@notionhq/', 'notion'],
];

/** Stack classification markers (dependency name → stack signal). */
const FRONTEND_MARKERS = [
  'react',
  'react-dom',
  'next',
  'vue',
  'nuxt',
  '@angular/core',
  'svelte',
  '@sveltejs/kit',
  'solid-js',
  'astro',
  'gatsby',
  'remix',
  '@remix-run/react',
];
const MOBILE_MARKERS = ['react-native', 'expo', '@react-native/core', '@ionic/core', 'flutter'];
const BACKEND_MARKERS = [
  'express',
  'fastify',
  '@nestjs/core',
  'koa',
  '@hapi/hapi',
  'django',
  'flask',
  'fastapi',
  'rails',
  'sinatra',
  'gin-gonic',
  'laravel/framework',
  'actix-web',
  'spring-boot',
];

function hasAny(deps: Set<string>, markers: string[]): boolean {
  for (const m of markers) if (deps.has(m)) return true;
  return false;
}

/** Classify the repo stack from its dependency NAMES. */
export function classifyStack(depNames: string[]): RepoStack {
  const deps = new Set(depNames);
  const mobile = hasAny(deps, MOBILE_MARKERS);
  if (mobile) return 'mobile';
  const frontend = hasAny(deps, FRONTEND_MARKERS);
  const backend = hasAny(deps, BACKEND_MARKERS);
  if (frontend && backend) return 'fullstack';
  if (frontend) return 'frontend';
  if (backend) return 'backend';
  return 'unknown';
}

/** Integrations directly evidenced by the repo's dependencies (deduped, stable order). */
export function detectedIntegrationsFromDeps(depNames: string[]): IntegrationId[] {
  const out: IntegrationId[] = [];
  const seen = new Set<IntegrationId>();
  const push = (id: IntegrationId) => {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  };
  for (const name of depNames) {
    const exact = DEP_TO_INTEGRATION[name];
    if (exact) {
      push(exact);
      continue;
    }
    for (const [prefix, id] of DEP_PREFIX_TO_INTEGRATION) {
      if (name.startsWith(prefix)) {
        push(id);
        break;
      }
    }
  }
  return out;
}

/** Commonly-paired integrations per classified stack (the curated inference layer). */
export const STACK_TO_RECOMMENDED: Record<RepoStack, IntegrationId[]> = {
  frontend: ['figma', 'sentry', 'posthog', 'vercel'],
  backend: ['sentry', 'datadog', 'supabase', 'convex', 'cloudflare'],
  fullstack: ['sentry', 'posthog', 'vercel', 'supabase', 'convex'],
  mobile: ['sentry', 'posthog'],
  unknown: [],
};

/**
 * The deterministic core of Session Tools "Recommended": classify the stack and
 * combine direct-evidence detections with stack inference. `recommended`
 * excludes anything already `detected`. Returns `source:'scan'`. When both
 * `detected` and `recommended` are empty (unrecognized stack), the CLI falls
 * back to the agent one-shot (B).
 */
export function recommendForDeps(depNames: string[]): RepoStackDetection {
  const stack = classifyStack(depNames);
  const detected = detectedIntegrationsFromDeps(depNames);
  const detectedSet = new Set(detected);
  const recommended = STACK_TO_RECOMMENDED[stack].filter((id) => !detectedSet.has(id));
  return { stack, detected, recommended, source: 'scan' };
}
