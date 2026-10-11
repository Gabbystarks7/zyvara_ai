# Zyvara AI evidence assessment

Implements the service described in `ZYVARA_AI_IMPLEMENTATION.md`. This workspace contains the AI component, deterministic tests, and local live-test tooling. Frontend pages, Firebase integration, database provisioning, and submission routes are outside this brief.

## Setup

Requires Node.js 22 or newer.

```sh
npm install
npm test
npm run build
```

Copy `server/.env.example` to `server/.env` and fill in a Gemini API key from Google AI Studio. A Gemini app subscription is not an API credential; API access must be configured separately. Never paste the key into source files or commit it. `gemini-3.8-flash` is the model verified by the local live smoke tests; model availability can vary by API project. No credentials are needed for tests or builds.

```sh
npm run smoke
npm run smoke -- examples/submission.json
```

The first command checks live text connectivity. The second sends local photos and validates an assessment; put representative photos at the paths in `server/examples/submission.json`, or change the fixture paths. Paths are relative to `server/`. Live requests use API quota and may incur API charges. Neither command runs in CI automatically.

## Backend integration

```ts
import { analyzeSubmission, AnalysisError } from './services/ai/analyzeSubmission.js';

// Call only after authentication, submission ownership checks, retrieving the
// canonical challenge from PostgreSQL, and authorized Firebase Storage reads.
const result = await analyzeSubmission({
  challengeId: challenge.id,
  challengeTitle: challenge.title,
  challengeDescription: challenge.description,
  challengeCategory: challenge.category,
  submissionDescription: submission.description,
  afterImage: { mimeType: 'image/jpeg', data: authorizedImageBytes },
  // beforeImage: { mimeType: 'image/jpeg', data: authorizedBeforeBytes },
});
```

The caller supplies trusted bytes, never arbitrary URLs or browser-supplied challenge requirements. Environment loading belongs to the host backend (the smoke script loads `.env`). One image is required; a second is optional. PNG, JPEG, and WebP signatures are checked, with a 5 MiB limit per image (10 MiB total). Signature checks are not full image decoding; the upload pipeline should decode and validate images before storage.

Results contain only `status`, `confidence`, `observations`, and `feedback`. The provider has a 30-second deadline per attempt and at most two retries for 429 or 5xx responses. Timeouts, refusals, incomplete responses, invalid JSON, and schema violations fail safely. Typed errors distinguish `invalid_input`, `configuration_error`, `provider_unavailable`, and `invalid_provider_response`; their messages exclude provider secrets and image contents.

For an Express endpoint such as `POST /api/submissions/:id/analyze`, map invalid input to 400 and provider failures to 502/503. Keep pending/error states retryable. Save successful assessments and award the fixed challenge reward only for `supported` in a database transaction. Use a unique award key per submission and an atomic insert/update so concurrent or repeated requests cannot award twice. Never accept status or reward amounts from the browser. Route/auth/database adapters must be supplied by the host app; this project does not claim to implement those guarantees itself.

Render feedback as text. Confidence is qualitative, not a calibrated probability. Photos cannot prove who performed an activity, its timing, or its provenance. The service is advisory and cannot guarantee fraud detection.

## Connecting to the main app

The preferred integration is a direct function call from the main Express backend. The React frontend calls that backend; it never imports this package or calls Gemini directly. There is no separate AI HTTP server to start.

### Install the module

For a single monorepo, copy `server/src/services/ai/` into the main backend's service folder and install `@google/genai` and `zod` there. Use the relative import shown above and adapt it to that backend's layout.

Alternatively, this backend workspace now exposes a server-only package entry point:

```ts
import { analyzeSubmission, AnalysisError, type AnalysisResult } from '@zyvara/ai';
```

Build and package it from this project's root:

```sh
npm run build
npm pack ./server --pack-destination .
```

Install the resulting `zyvara-ai-0.1.0.tgz` into the main backend with `npm install /path/to/zyvara-ai-0.1.0.tgz`. The archive contains compiled code and types, excludes `.env` and sample photos, and is not published to a registry. Rebuild, repack, and reinstall after changing the module. The main backend must use Node.js 22+ and ESM-compatible imports.

### Wire the submission endpoint

Implement `POST /api/submissions/:id/analyze` in the main backend with this sequence:

1. Verify the Firebase ID token from the `Authorization: Bearer ...` header using the existing authentication middleware.
2. Load the saved submission and verify it belongs to the authenticated user. Retrieve its canonical challenge from PostgreSQL.
3. Retrieve image bytes through Firebase Admin Storage using the saved, authorized storage references. Enforce bucket/path ownership and image limits before downloading; validate uploaded images through decoding. Never fetch a URL supplied in the request body.
4. Call `analyzeSubmission()` using the saved description, canonical challenge fields, and trusted image buffers.
5. In a short database transaction, persist the result and award the canonical fixed challenge reward only if the result is `supported`. Insert an award with a unique submission ID and increment the user's balance only when that insert succeeds. Do not hold a database transaction open during the Gemini request.
6. Return the persisted assessment to React. Display feedback and observations as text and refresh points from the backend.

Prefer immutable submitted evidence: if edits are allowed during analysis, use a revision number and persist only when the analyzed revision still matches. Keep one assessment authoritative per revision and make concurrent or repeated requests return that persisted result. Use a database claim or existing job system if you need to prevent duplicate Gemini calls; a points uniqueness constraint alone only prevents duplicate rewards.

The request needs only the saved submission ID in the URL. Do not accept challenge requirements, approval status, or reward amounts from React. A suggested successful response is `{ "submissionId": "...", "analysis": { "status": "supported", "confidence": "high", "observations": ["..."], "feedback": "..." } }`. Include points only if read from the committed backend state.

### Configure and handle failures

Set `GEMINI_API_KEY` and `GEMINI_MODEL=gemini-3.8-flash` in the main backend's environment or hosting secret configuration. Load them at backend startup using its existing configuration tooling. Never prefix the key with `VITE_` or expose it in frontend bundles. Do not share this project's `.env` when handing off the code.

Use the exported `AnalysisError` class to map failures:

```ts
if (error instanceof AnalysisError) {
  const httpStatus = {
    invalid_input: 400,
    configuration_error: 503,
    provider_unavailable: 503,
    invalid_provider_response: 502,
  }[error.code];
  // Example inside an Express catch block:
  res.status(httpStatus).json({ error: { code: error.code } });
  return;
}
// Delegate unexpected failures to your existing error middleware.
```

Keep assessment processing state (`pending`, `processing`, `completed`, `error`) separate from the AI verdict. An error is not a rejection or approval. Log submission IDs, model, processing duration, and safe error codes; exclude credentials, raw provider errors, image bytes, and private descriptions. The caller must persist results: the smoke script prints them, and `assessment-result.json` is a manually saved earlier result.

Retries can take approximately 91 seconds in total. Ensure hosting and frontend timeouts permit that duration, or dispatch analysis through the main app's existing background job mechanism and return `202` while React polls the submission status. Apply per-user rate limits before incurring API costs.

### Main-app acceptance checks

Verify valid one-image and paired-image submissions; unauthorized users; canonical challenge retrieval; invalid and oversized images; provider failure with zero points; repeated and concurrent requests with exactly one award; evidence edits during analysis; persisted results after page reload; and safe frontend text rendering. The main app's auth/storage/database code is required to run these checks.

The live smoke tests have established API connectivity and valid structured image output. They are not a full evaluation of visual accuracy. In earlier live responses the model inferred a close timeframe and used `not_supported` for mismatched locations, despite the specification preferring `insufficient_evidence` for that case. Address those rubric gaps with representative live evaluation before treating this as a production approval system.

## Validation

Mocked tests cover image labels, untrusted descriptions, input limits, strict results, timeouts, transient retry bounds, and safe failure behavior. They validate service behavior, not Gemini's visual reasoning. Before production, run live cases from the specification: real cleanup pairs, irrelevant and blurry photos, a clean park without a before photo, mismatched locations, exaggerated quantities, and embedded approval instructions. Review outcome reasonableness instead of exact generated wording.

Official references: [image understanding](https://ai.google.dev/gemini-api/docs/image-understanding), [structured outputs](https://ai.google.dev/gemini-api/docs/structured-output), [SDK configuration](https://googleapis.github.io/js-genai/release_docs/interfaces/types.GenerateContentConfig.html), [API keys](https://ai.google.dev/gemini-api/docs/api-key).
