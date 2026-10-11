// Server-only public API. Never import this package into the React client.
export { analyzeSubmission, createAnalyzer, AnalysisError } from './services/ai/analyzeSubmission.js';
export type { AnalysisInput, AnalysisResult, EvidenceImage } from './services/ai/analyzeSubmission.js';
export { createGeminiProvider } from './services/ai/geminiClient.js';
export type { AssessmentProvider } from './services/ai/geminiClient.js';
