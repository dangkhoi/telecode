import { logger } from '../util/logger.js';

/**
 * A chain step defines one agent invocation in the pipeline.
 */
export interface ChainStep {
  agent: string;
  prompt: string;
}

/**
 * Parse chain syntax from user input.
 * Format: `agent1: prompt1 | agent2: prompt2 | agent3: prompt3`
 */
export function parseChain(input: string, defaultAgent: string): ChainStep[] | { error: string } {
  const parts = input.split('|').map(s => s.trim()).filter(s => s.length > 0);
  if (parts.length < 2) {
    return { error: 'Chain cần ít nhất 2 steps (phân cách bằng |).' };
  }
  if (parts.length > 5) {
    return { error: 'Chain tối đa 5 steps.' };
  }
  const steps: ChainStep[] = [];
  for (const part of parts) {
    const colonIdx = part.indexOf(':');
    if (colonIdx > 0 && colonIdx < 20 && !part.slice(0, colonIdx).includes(' ')) {
      const agent = part.slice(0, colonIdx).trim().toLowerCase();
      const prompt = part.slice(colonIdx + 1).trim();
      if (!prompt) return { error: `Step "${agent}" không có prompt.` };
      steps.push({ agent, prompt });
    } else {
      steps.push({ agent: defaultAgent, prompt: part });
    }
  }
  return steps;
}

/**
 * Inject previous output into a step's prompt.
 */
export function injectPreviousOutput(prompt: string, prevOutput: string): string {
  if (prompt.includes('{{prev}}')) {
    return prompt.replace(/\{\{prev\}\}/g, prevOutput);
  }
  return `Previous step output:\n\n${prevOutput}\n\n---\n\n${prompt}`;
}

/**
 * Validate that all agents in the chain are registered.
 */
export function validateChainAgents(
  steps: ChainStep[],
  registeredAgents: string[],
): string | null {
  const registered = new Set(registeredAgents);
  for (const step of steps) {
    if (!registered.has(step.agent)) {
      return `Agent "${step.agent}" không được đăng ký. Có: ${registeredAgents.join(', ')}`;
    }
  }
  return null;
}
