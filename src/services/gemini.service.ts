import { z } from 'zod';
import {
  DeliveryFormat,
  GeneratedWhisper,
  WhisperType,
  WrapStyle,
} from '../types/whisper.types.js';

const responseSchema = z.object({
  title: z.string().trim().min(5).max(90),
  message: z.string().trim().min(20).max(1600),
  scriptureReference: z.string().trim().min(3).max(80),
  scriptureText: z.string().trim().min(5).max(500),
  shortPrayer: z.string().trim().min(5).max(500),
});

const RETRYABLE_GEMINI_STATUSES = new Set([408, 409, 429, 500, 502, 503, 504]);
const DEFAULT_GEMINI_RETRY_ATTEMPTS = 2;
const DEFAULT_GEMINI_RETRY_DELAY_MS = 500;
const DEFAULT_GEMINI_MODEL = 'gemini-1.5-flash';
const GEMINI_API_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

type WhisperGenerationInput = {
  recipientName: string;
  senderName?: string;
  whisperType: WhisperType;
  wrapStyle: WrapStyle;
  deliveryFormat: DeliveryFormat;
  senderIntent: string;
  prompt?: string;
};

type GeminiErrorResponse = {
  error?: {
    code?: number;
    message?: string;
    status?: string;
  };
};

type GeminiResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
  }>;
};

type GeminiRequestError = Error & {
  status?: number;
  code?: string;
};

export class GeminiGenerationError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'GeminiGenerationError';
  }
}

function apiKey(): string {
  const key = process.env.GEMINI_API_KEY?.trim();

  if (!key) {
    throw new GeminiGenerationError(
      'Gemini is not configured. Please set GEMINI_API_KEY on the backend.',
      503,
      'gemini_not_configured',
    );
  }

  return key;
}

function modelName(): string {
  return process.env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL;
}

function clean(value: string | undefined | null): string {
  return String(value ?? '').trim();
}

function getPrompt(input: WhisperGenerationInput): string {
  return clean(input.prompt || input.senderIntent);
}

function parseGeminiJson(content: string): GeneratedWhisper {
  let decoded: unknown;

  try {
    decoded = JSON.parse(content);
  } catch {
    throw new GeminiGenerationError(
      'The AI service returned invalid JSON. Please try again.',
      502,
      'gemini_invalid_json',
    );
  }

  const parsed = responseSchema.safeParse(decoded);

  if (!parsed.success) {
    throw new GeminiGenerationError(
      'The AI service returned incomplete WhisperWrap content. Please try again.',
      502,
      'gemini_invalid_schema',
    );
  }

  return parsed.data;
}

function asGeminiRequestError(err: unknown): GeminiRequestError | undefined {
  if (err instanceof Error) return err as GeminiRequestError;
  return undefined;
}

function toGenerationError(err: unknown): GeminiGenerationError {
  if (err instanceof GeminiGenerationError) return err;

  const geminiError = asGeminiRequestError(err);
  const status = geminiError?.status;
  const code = geminiError?.code ?? 'gemini_request_failed';

  if (status === 400 || status === 403) {
    return new GeminiGenerationError(
      'Gemini rejected the backend API key or request. Please check GEMINI_API_KEY and GEMINI_MODEL.',
      503,
      'gemini_auth_failed',
    );
  }

  if (status === 429) {
    return new GeminiGenerationError(
      'The AI service is busy right now. Please try again shortly.',
      429,
      'gemini_rate_limited',
    );
  }

  if (status && status >= 500) {
    return new GeminiGenerationError(
      'The AI service is temporarily unavailable. Please try again.',
      502,
      code,
    );
  }

  if (status && status >= 400) {
    return new GeminiGenerationError(
      'The AI service could not generate that WhisperWrap. Please revise the details and try again.',
      400,
      code,
    );
  }

  return new GeminiGenerationError(
    'Failed to contact the AI service. Please try again.',
    502,
    code,
  );
}

function retryAttempts(): number {
  const configured = Number(process.env.GEMINI_RETRY_ATTEMPTS);
  if (!Number.isFinite(configured)) return DEFAULT_GEMINI_RETRY_ATTEMPTS;
  return Math.max(0, Math.min(Math.floor(configured), 5));
}

function retryDelayMs(): number {
  const configured = Number(process.env.GEMINI_RETRY_DELAY_MS);
  if (!Number.isFinite(configured)) return DEFAULT_GEMINI_RETRY_DELAY_MS;
  return Math.max(0, Math.min(Math.floor(configured), 5000));
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isRetryableGeminiError(err: unknown): boolean {
  const status = asGeminiRequestError(err)?.status;
  return typeof status === 'number' && RETRYABLE_GEMINI_STATUSES.has(status);
}

function validateGenerationInput(input: WhisperGenerationInput): void {
  const prompt = getPrompt(input);
  const recipientName = clean(input.recipientName);
  const senderName = clean(input.senderName);

  if (!prompt) {
    throw new GeminiGenerationError(
      'Prompt is required to generate a WhisperWrap.',
      400,
      'missing_prompt',
    );
  }

  if (prompt.length < 10) {
    throw new GeminiGenerationError(
      'Prompt is too short. Please describe what the WhisperWrap should say.',
      400,
      'prompt_too_short',
    );
  }

  if (prompt.length > 2000) {
    throw new GeminiGenerationError(
      'Prompt is too long. Please keep it under 2,000 characters.',
      400,
      'prompt_too_long',
    );
  }

  if (!recipientName) {
    throw new GeminiGenerationError('Recipient name is required.', 400, 'missing_recipient_name');
  }

  if (!senderName) {
    throw new GeminiGenerationError('Sender name is required.', 400, 'missing_sender_name');
  }
}

function buildWhisperPrompt(input: WhisperGenerationInput): string {
  const recipientName = clean(input.recipientName);
  const senderName = clean(input.senderName);
  const formPrompt = getPrompt(input);

  return `
You are WhisperWrap, an AI assistant that creates heartfelt, Scripture-centered, ethical Christian messages.

The sender wrote this request:

"${formPrompt}"

Whisper details:
Recipient Name: ${recipientName}
Sender Name: ${senderName}
Whisper Type: ${input.whisperType}
Wrap Style: ${input.wrapStyle}
Delivery Format: ${input.deliveryFormat}
Sender Intent: ${clean(input.senderIntent)}

Generate ONE complete WhisperWrap.

Requirements:
- The message must begin exactly with: "Whisper from ${senderName}:"
- After that opening, address ${recipientName} naturally by name.
- Do not use placeholders.
- Do not invent private facts.
- Do not mention that you are AI.
- Write like a caring human, not a greeting card.
- Keep the content emotionally intelligent, warm, biblical, and compassionate.
- Respect the recipient's dignity and free will.
- Never manipulate, shame, guilt, pressure, threaten, or frighten.
- Never make prophetic, financial, medical, legal, or guaranteed outcome claims.
- Include one appropriate Bible verse.
- Scripture must use public-domain wording, preferably KJV, or a brief paraphrase.
- Include a short prayer that mentions ${recipientName} by name.
- Keep the message under 30 words.
- The title should feel personal and engaging.

Return ONLY valid JSON with exactly these keys:
{
  "title": "",
  "message": "",
  "scriptureReference": "",
  "scriptureText": "",
  "shortPrayer": ""
}
`.trim();
}

function extractText(response: GeminiResponse): string | undefined {
  return response.candidates?.[0]?.content?.parts
    ?.map(part => part.text)
    .filter((text): text is string => !!text)
    .join('')
    .trim();
}

async function requestGeminiWhisper(prompt: string): Promise<GeneratedWhisper> {
  const url = `${GEMINI_API_BASE_URL}/models/${encodeURIComponent(modelName())}:generateContent?key=${encodeURIComponent(apiKey())}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: {
        parts: [
          {
            text: 'You generate safe Christian WhisperWrap messages. Return valid JSON only. Follow the requested schema exactly. Keep the content biblical, ethical, compassionate, consent-safe, and free from manipulation, shame, harassment, medical claims, prophetic guarantees, or guaranteed outcomes.',
          },
        ],
      },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.7,
        responseMimeType: 'application/json',
      },
    }),
  });

  const data = (await response.json().catch(() => ({}))) as GeminiResponse & GeminiErrorResponse;

  if (!response.ok) {
    const error = new Error(data.error?.message || 'Gemini request failed') as GeminiRequestError;
    error.status = response.status;
    error.code = data.error?.status?.toLowerCase() || 'gemini_request_failed';
    throw error;
  }

  const content = extractText(data);

  if (!content) {
    throw new GeminiGenerationError(
      'The AI service returned an empty response. Please try again.',
      502,
      'gemini_empty_content',
    );
  }

  return parseGeminiJson(content);
}

export async function generateWhisperContent(
  input: WhisperGenerationInput,
): Promise<GeneratedWhisper> {
  validateGenerationInput(input);

  const prompt = buildWhisperPrompt(input);
  const attempts = retryAttempts() + 1;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await requestGeminiWhisper(prompt);
    } catch (err) {
      lastError = err;

      if (attempt === attempts || !isRetryableGeminiError(err)) {
        break;
      }

      await sleep(retryDelayMs() * attempt);
    }
  }

  throw toGenerationError(lastError);
}
