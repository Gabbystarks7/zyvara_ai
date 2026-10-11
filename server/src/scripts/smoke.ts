import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { GoogleGenAI } from '@google/genai';
import { analyzeSubmission, AnalysisError, type AnalysisInput } from '../services/ai/analyzeSubmission.js';

async function readLocalFile(path: unknown): Promise<Buffer> {
  if (typeof path !== 'string' || !path.trim()) {
    throw new AnalysisError('invalid_input', 'Each local fixture and image must have a nonempty file path.');
  }
  try { return await readFile(path); }
  catch {
    throw new AnalysisError('invalid_input', `Cannot read local file ${JSON.stringify(path)}. Paths are relative to the server folder; check the filename and extension.`);
  }
}

try {
  if (!process.env.GEMINI_API_KEY || !process.env.GEMINI_MODEL) throw new AnalysisError('configuration_error', 'Set the API key and model in server/.env.');
  const fixturePath = process.argv[2];
  if (!fixturePath) {
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const response = await ai.models.generateContent({ model: process.env.GEMINI_MODEL, contents: 'Reply with OK.', config: { httpOptions: { timeout: 30000 } } });
    if (!response.text?.trim()) throw new Error('Empty response');
    console.log('Gemini connectivity succeeded.');
  } else {
    // A local fixture uses image file paths instead of Buffer values.
    const contents = (await readLocalFile(fixturePath)).toString('utf8');
    let fixture;
    try { fixture = JSON.parse(contents); }
    catch { throw new AnalysisError('invalid_input', 'The submission fixture is not valid JSON.'); }
    if (!fixture || typeof fixture !== 'object' || Array.isArray(fixture)) {
      throw new AnalysisError('invalid_input', 'The submission fixture must be a JSON object.');
    }
    for (const key of ['beforeImage', 'afterImage']) {
      if (fixture[key]) fixture[key] = { mimeType: fixture[key].mimeType, data: await readLocalFile(fixture[key].path) };
    }
    console.log(JSON.stringify(await analyzeSubmission(fixture as AnalysisInput), null, 2));
  }
} catch (error) {
  if (error instanceof AnalysisError) {
    console.error(`${error.code}: ${error.message}`);
  } else {
    // Never print raw SDK errors: they may include request data or credentials.
    const status = error && typeof error === 'object' && 'status' in error ? Number(error.status) : undefined;
    const hints: Record<number, string> = {
      400: 'The API rejected the request. Check that the key and configured model are valid.',
      401: 'The API key was not accepted.',
      402: 'The API requires payment. Check API project billing and available credits.',
      403: 'API access was denied. Check key restrictions and project access.',
      404: 'The configured model was not found or is unavailable for this project.',
      429: 'The API quota or rate limit was exceeded. Check Google AI Studio project quota and billing.',
    };
    console.error(status && Number.isFinite(status)
      ? `Gemini request failed (HTTP ${status}). ${hints[status] ?? 'The provider could not complete the request.'}`
      : 'Gemini smoke test failed. Check network access and local fixture paths.');
  }
  process.exitCode = 1;
}
