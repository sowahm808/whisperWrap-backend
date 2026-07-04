import OpenAI from 'openai';
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

const RETRYABLE_OPENAI_STATUSES = new Set([408, 409, 429, 500, 502, 503, 504]);
const DEFAULT_OPENAI_RETRY_ATTEMPTS = 2;
const DEFAULT_OPENAI_RETRY_DELAY_MS = 500;

type WhisperGenerationInput = {
  recipientName: string;
  senderName?: string;
  whisperType: WhisperType;
  wrapStyle: WrapStyle;
  deliveryFormat: DeliveryFormat;
  senderIntent: string;
  prompt?: string;
};

type OpenAIErrorLike = {
  status?: number;
  code?: string;
  message?: string;
};

export class OpenAiGenerationError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'OpenAiGenerationError';
  }
}

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!process.env.OPENAI_API_KEY) {
    throw new OpenAiGenerationError(
      'OpenAI is not configured. Please set OPENAI_API_KEY on the backend.',
      503,
      'openai_not_configured',
    );
  }

  if (!client) {
    client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }

  return client;
}

function clean(value: string | undefined | null): string {
  return String(value ?? '').trim();
}

function getPrompt(input: WhisperGenerationInput): string {
  return clean(input.prompt || input.senderIntent);
}

function parseOpenAiJson(content: string): GeneratedWhisper {
  let decoded: unknown;

  try {
    decoded = JSON.parse(content);
  } catch {
    throw new OpenAiGenerationError(
      'The AI service returned invalid JSON. Please try again.',
      502,
      'openai_invalid_json',
    );
  }

  const parsed = responseSchema.safeParse(decoded);

  if (!parsed.success) {
    throw new OpenAiGenerationError(
      'The AI service returned incomplete WhisperWrap content. Please try again.',
      502,
      'openai_invalid_schema',
    );
  }

  return parsed.data;
}

function asOpenAIError(err: unknown): OpenAIErrorLike {
  if (err && typeof err === 'object') return err as OpenAIErrorLike;
  return {};
}

function toGenerationError(err: unknown): OpenAiGenerationError {
  if (err instanceof OpenAiGenerationError) return err;

  const openAiError = asOpenAIError(err);
  const status = openAiError.status;
  const code = openAiError.code ?? 'openai_request_failed';

  if (status === 401) {
    return new OpenAiGenerationError(
      'OpenAI rejected the backend API key. Please check OPENAI_API_KEY.',
      503,
      'openai_auth_failed',
    );
  }

  if (status === 429) {
    return new OpenAiGenerationError(
      'The AI service is busy right now. Please try again shortly.',
      429,
      'openai_rate_limited',
    );
  }

  if (status && status >= 500) {
    return new OpenAiGenerationError(
      'The AI service is temporarily unavailable. Please try again.',
      502,
      code,
    );
  }

  if (status && status >= 400) {
    return new OpenAiGenerationError(
      'The AI service could not generate that WhisperWrap. Please revise the details and try again.',
      400,
      code,
    );
  }

  return new OpenAiGenerationError(
    'Failed to contact the AI service. Please try again.',
    502,
    code,
  );
}

function retryAttempts(): number {
  const configured = Number(process.env.OPENAI_RETRY_ATTEMPTS);
  if (!Number.isFinite(configured)) return DEFAULT_OPENAI_RETRY_ATTEMPTS;
  return Math.max(0, Math.min(Math.floor(configured), 5));
}

function retryDelayMs(): number {
  const configured = Number(process.env.OPENAI_RETRY_DELAY_MS);
  if (!Number.isFinite(configured)) return DEFAULT_OPENAI_RETRY_DELAY_MS;
  return Math.max(0, Math.min(Math.floor(configured), 5000));
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isRetryableOpenAIError(err: unknown): boolean {
  const status = asOpenAIError(err).status;
  return typeof status === 'number' && RETRYABLE_OPENAI_STATUSES.has(status);
}

function validateGenerationInput(input: WhisperGenerationInput): void {
  const prompt = getPrompt(input);
  const recipientName = clean(input.recipientName);
  const senderName = clean(input.senderName);

  if (!prompt) {
    throw new OpenAiGenerationError(
      'Prompt is required to generate a WhisperWrap.',
      400,
      'missing_prompt',
    );
  }

  if (prompt.length < 10) {
    throw new OpenAiGenerationError(
      'Prompt is too short. Please describe what the WhisperWrap should say.',
      400,
      'prompt_too_short',
    );
  }

  if (prompt.length > 2000) {
    throw new OpenAiGenerationError(
      'Prompt is too long. Please keep it under 2,000 characters.',
      400,
      'prompt_too_long',
    );
  }

  if (!recipientName) {
    throw new OpenAiGenerationError(
      'Recipient name is required.',
      400,
      'missing_recipient_name',
    );
  }

  if (!senderName) {
    throw new OpenAiGenerationError(
      'Sender name is required.',
      400,
      'missing_sender_name',
    );
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
- Keep the message under 220 words.
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

async function requestOpenAiWhisper(prompt: string): Promise<GeneratedWhisper> {
  const completion = await getClient().chat.completions.create({
    model: process.env.OPENAI_MODEL ?? 'gpt-4.1-mini',
    temperature: 0.7,
    messages: [
      {
        role: 'system',
        content:
          'You generate safe Christian WhisperWrap messages. Return valid JSON only. Follow the requested schema exactly. Keep the content biblical, ethical, compassionate, consent-safe, and free from manipulation, shame, harassment, medical claims, prophetic guarantees, or guaranteed outcomes.',
      },
      {
        role: 'user',
        content: prompt,
      },
    ],
    response_format: { type: 'json_object' },
  });

  const content = completion.choices[0]?.message?.content;

  if (!content) {
    throw new OpenAiGenerationError(
      'The AI service returned an empty response. Please try again.',
      502,
      'openai_empty_content',
    );
  }

  return parseOpenAiJson(content);
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
      return await requestOpenAiWhisper(prompt);
    } catch (err) {
      lastError = err;

      if (attempt === attempts || !isRetryableOpenAIError(err)) {
        break;
      }

      await sleep(retryDelayMs() * attempt);
    }
  }

  throw toGenerationError(lastError);
}