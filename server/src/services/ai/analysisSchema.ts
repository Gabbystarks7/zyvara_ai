import { z } from 'zod';

export type EvidenceImage = { mimeType: 'image/jpeg' | 'image/png' | 'image/webp'; data: Buffer };
export type AnalysisInput = {
  challengeId: string;
  challengeTitle: string;
  challengeDescription: string;
  challengeCategory: string;
  submissionDescription: string;
  beforeImage?: EvidenceImage;
  afterImage: EvidenceImage;
};
export const analysisSchema = z.strictObject({
  status: z.enum(['supported', 'insufficient_evidence', 'not_supported']),
  confidence: z.enum(['low', 'medium', 'high']),
  observations: z.array(z.string().trim().min(1).max(500)).max(12),
  feedback: z.string().trim().min(1).max(2000),
});
export type AnalysisResult = z.infer<typeof analysisSchema>;
export const analysisJsonSchema = z.toJSONSchema(analysisSchema);
export type AnalysisErrorCode = 'invalid_input' | 'provider_unavailable' | 'invalid_provider_response' | 'configuration_error';
export class AnalysisError extends Error {
  constructor(public readonly code: AnalysisErrorCode, message: string) {
    super(message);
    this.name = 'AnalysisError';
  }
}

const imageSchema = z.strictObject({
  mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  data: z.instanceof(Buffer).refine(b => b.length > 0 && b.length <= 5 * 1024 * 1024),
});
const inputSchema = z.strictObject({
  challengeId: z.string().trim().min(1).max(200),
  challengeTitle: z.string().trim().min(1).max(500),
  challengeDescription: z.string().trim().min(1).max(10000),
  challengeCategory: z.string().trim().min(1).max(200),
  submissionDescription: z.string().trim().min(1).max(10000),
  beforeImage: imageSchema.optional(),
  afterImage: imageSchema,
});
export function validateInput(input: AnalysisInput): AnalysisInput {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) throw new AnalysisError('invalid_input', 'Required fields or image limits are invalid (maximum 5 MiB per image).');
  for (const image of [parsed.data.beforeImage, parsed.data.afterImage]) {
    if (!image) continue;
    const b = image.data;
    const valid = image.mimeType === 'image/png'
      ? b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
      : image.mimeType === 'image/jpeg'
        ? b.length >= 3 && b[0] === 255 && b[1] === 216 && b[2] === 255
        : b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP';
    if (!valid) throw new AnalysisError('invalid_input', 'Image signature does not match its declared media type.');
  }
  return parsed.data;
}
