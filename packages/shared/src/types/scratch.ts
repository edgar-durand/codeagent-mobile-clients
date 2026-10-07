/**
 * Agent-first onboarding (spec 2026-09-28-agent-first-onboarding-scratch-box-design).
 * ONE constant decides which deploy card is primary on mobile + web (D4) — flip
 * the array to make GitHub primary. A user whose GitHub is already linked sees
 * the repo card first.
 */
export type DeployChoice = 'scratch' | 'github';
export const DEPLOY_CHOICE_ORDER: readonly DeployChoice[] = ['scratch', 'github'];
export function orderDeployChoices(githubLinked: boolean): DeployChoice[] {
  const order = [...DEPLOY_CHOICE_ORDER];
  return githubLinked ? order.reverse() : order;
}

export interface StarterPrompt {
  label: string;
  prompt: string;
}
/**
 * Composer starters for an empty scratch Box session (D12/§4.3).
 *
 * Every starter must BUILD something on its first turn and end with the
 * preview open: on FREE each send is one of 3 daily tasks, and a starter that
 * only asks a question or lists ideas spends one with nothing to show
 * (replays 2026-10-05: "give me three quick ideas" → ideas + "Which one?"
 * (shokhanahmadi61); "ask me the business name first" → "I'll need a business
 * name" (deepak.namdeo81)). Ask for details AFTER the first build, not before.
 */
export const SCRATCH_STARTER_PROMPTS: readonly StarterPrompt[] = [
  {
    label: 'Landing page',
    prompt:
      'Build a simple, good-looking landing page for a business, using a placeholder business name I can change later. Build it and open the preview.',
  },
  {
    label: 'To-do app',
    prompt: 'Build a small to-do app I can use in the browser, then open the preview.',
  },
  {
    label: 'Browser game',
    prompt: 'Build a small game that runs in the browser, then open the preview.',
  },
  {
    label: 'Surprise me',
    prompt:
      'Pick one small, useful app you can build quickly, build it right away without asking me first, then open the preview and tell me what I can change.',
  },
];

export const SCRATCH_ZIP_FREE_LIMIT_BYTES = 104_857_600;
export const SCRATCH_ZIP_WIFI_HINT_BYTES = 209_715_200;
export type ScratchSavedVia = 'github' | 'gitlab' | 'zip';
export interface ScratchProjectState {
  projectId: string;
  sessionId: string | null;
  savedAt: string | null;
  savedVia: ScratchSavedVia | null;
  repoFullName: string | null;
}
export type ScratchExportResult =
  | { url: string; sizeBytes: number; expiresAt: string }
  | {
      tooLarge: true;
      sizeBytes: number;
      limitBytes: number;
      topPaths: Array<{ path: string; bytes: number }>;
    };
