import { analysisSchema, AnalysisError, validateInput, type AnalysisInput, type AnalysisResult } from './analysisSchema.js';
import { buildParts } from './analysisPrompt.js';
import { createGeminiProvider, type AssessmentProvider } from './geminiClient.js';
export { AnalysisError } from './analysisSchema.js';
export type { AnalysisInput, AnalysisResult, EvidenceImage } from './analysisSchema.js';

type Options = { timeoutMs?: number; maxRetries?: number; backoffMs?: number };
function isTransient(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const status = 'status' in error ? Number(error.status) : NaN;
  return status === 429 || (status >= 500 && status <= 599);
}
export function createAnalyzer(provider: AssessmentProvider, options: Options = {}) {
  const timeoutMs = options.timeoutMs ?? 30000;
  const maxRetries = options.maxRetries ?? 2;
  const backoffMs = options.backoffMs ?? 250;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 3 || !Number.isFinite(backoffMs) || backoffMs < 0 || backoffMs > 5000) {
    throw new AnalysisError('configuration_error', 'Invalid timeout or retry configuration.');
  }
  return async (input: AnalysisInput): Promise<AnalysisResult> => {
    const parts = buildParts(validateInput(input));
    let text = '';
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        text = await Promise.race([
          provider.generate(parts, controller.signal),
          new Promise<never>((_, reject) => { timer = setTimeout(() => {
            controller.abort();
            reject(new AnalysisError('provider_unavailable', 'The evidence assessment timed out.'));
          }, timeoutMs); }),
        ]);
        break;
      } catch (error) {
        if (error instanceof AnalysisError) throw error;
        if (attempt === maxRetries || !isTransient(error)) {
          throw new AnalysisError('provider_unavailable', 'The evidence assessment provider is unavailable.');
        }
      } finally { if (timer) clearTimeout(timer); }
      await new Promise(resolve => setTimeout(resolve, backoffMs * 2 ** attempt));
    }
    try { return analysisSchema.parse(JSON.parse(text)); }
    catch { throw new AnalysisError('invalid_provider_response', 'The provider returned an invalid assessment.'); }
  };
}
export async function analyzeSubmission(input: AnalysisInput): Promise<AnalysisResult> {
  validateInput(input);
  return createAnalyzer(createGeminiProvider())(input);
}
