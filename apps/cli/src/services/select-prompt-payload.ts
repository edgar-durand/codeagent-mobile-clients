import type { SelectPrompt } from '@codeagent/shared';

export interface SelectPromptPayload {
  prompt: string;
  promptContext: string;
  options?: string[];
  optionDescriptions?: string[];
  currentIndex?: number;
}

export function buildSelectPromptPayload(selector: SelectPrompt): SelectPromptPayload {
  const prompt = selector.question.trim();
  const optionDescriptions = selector.optionDescriptions.map((desc) => desc.trim());
  const promptContext = buildPromptContext(prompt, selector.options, optionDescriptions);

  return {
    prompt,
    promptContext,
    ...(selector.options.length > 0 ? { options: selector.options } : {}),
    optionDescriptions,
    currentIndex: selector.currentIndex,
  };
}

function buildPromptContext(
  prompt: string,
  options: string[],
  optionDescriptions: string[],
): string {
  const optionContext = options.flatMap((option, index) => {
    const description = optionDescriptions[index]?.trim() ?? '';
    if (!description) return [];
    return [`${index + 1}. ${option}`, description];
  });

  return [prompt, ...optionContext]
    .map((part) => part.trim())
    .filter(Boolean)
    .join('\n\n');
}
