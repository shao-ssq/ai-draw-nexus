import type { Env, Message } from './types.js'
import { generateGemini } from './stream-gemini.js'

/**
 * Gemini non-streaming call via the native protocol.
 * Thinking is controlled by `generationConfig.thinkingConfig.thinkingLevel`;
 * thinking parts are excluded from the returned answer text.
 */
export async function callGemini(
  messages: Message[],
  env: Env,
  thinking: string
): Promise<string> {
  return generateGemini(messages, env, thinking)
}
