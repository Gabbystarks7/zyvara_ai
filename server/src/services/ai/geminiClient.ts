import { GoogleGenAI, type Part } from '@google/genai';
import { AnalysisError, analysisJsonSchema } from './analysisSchema.js';
import { systemInstruction } from './analysisPrompt.js';

export interface AssessmentProvider {
  generate(parts: Part[], signal: AbortSignal): Promise<string>;
}
export function createGeminiProvider(env: NodeJS.ProcessEnv = process.env): AssessmentProvider {
  const apiKey = env.GEMINI_API_KEY?.trim();
  const model = env.GEMINI_MODEL?.trim();
  if (!apiKey || !model) throw new AnalysisError('configuration_error', 'Set GEMINI_API_KEY and GEMINI_MODEL in the server environment.');
  const ai = new GoogleGenAI({ apiKey });
  return {
    async generate(parts, signal) {
      const response = await ai.models.generateContent({
        model, contents: [{ role: 'user', parts }],
        config: { systemInstruction, responseMimeType: 'application/json', responseJsonSchema: analysisJsonSchema,
          abortSignal: signal, httpOptions: { timeout: 30000, retryOptions: { attempts: 1 } } },
      });
      if (response.promptFeedback?.blockReason || response.candidates?.[0]?.finishReason !== 'STOP') {
        throw new AnalysisError('invalid_provider_response', 'The provider blocked or did not complete the assessment.');
      }
      return response.text ?? '';
    },
  };
}
