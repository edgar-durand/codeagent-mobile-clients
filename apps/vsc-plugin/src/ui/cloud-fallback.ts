export interface CloudFallbackMessage {
  title: string;
  body: string;
  steps: string[];
  repoLine: string | null;
  learnMoreUrl: string;
}

const LEARN_MORE_URL = 'https://www.codeagent-mobile.com/docs/network';

export function buildCloudFallbackMessage(input: {
  repo: { owner: string; repo: string } | null;
  branch: string | null;
}): CloudFallbackMessage {
  const repoLine = input.repo
    ? `${input.repo.owner}/${input.repo.repo}${input.branch ? ` · ${input.branch}` : ''}`
    : null;
  const pickStep = input.repo
    ? `Pick this repo: ${input.repo.owner}/${input.repo.repo}`
    : 'Pick this repository';
  return {
    title: "Can't reach CodeAgent on this network",
    body:
      "Your network (VPN or firewall) is blocking the connection to CodeAgent. " +
      'You can still drive this project from your phone using a cloud workspace — ' +
      "it runs on GitHub, so your machine's network restrictions don't apply.",
    steps: [
      'Open the CodeAgent app on your phone',
      'Start a cloud workspace (Deploy → New Codespace)',
      pickStep,
      'Drive the agent from your phone',
    ],
    repoLine,
    learnMoreUrl: LEARN_MORE_URL,
  };
}
