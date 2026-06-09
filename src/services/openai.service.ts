import OpenAI from 'openai';
import { z } from 'zod';
import { DeliveryFormat, GeneratedWhisper, WhisperType, WrapStyle } from '../types/whisper.types.js';

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
  whisperType: WhisperType;
  wrapStyle: WrapStyle;
  deliveryFormat: DeliveryFormat;
  senderIntent: string;
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
    throw new OpenAiGenerationError('OpenAI is not configured. Please set OPENAI_API_KEY on the backend.', 503, 'openai_not_configured');
  }
  if (!client) client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return client;
}

function parseOpenAiJson(content: string): GeneratedWhisper {
  let decoded: unknown;

  try {
    decoded = JSON.parse(content);
  } catch {
    throw new OpenAiGenerationError('The AI service returned an invalid response. Please try again.', 502, 'openai_invalid_json');
  }

  const parsed = responseSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new OpenAiGenerationError('The AI service returned incomplete WhisperWrap content. Please try again.', 502, 'openai_invalid_schema');
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
    return new OpenAiGenerationError('OpenAI rejected the backend API key. Please check OPENAI_API_KEY.', 503, 'openai_auth_failed');
  }

  if (status === 429) {
    return new OpenAiGenerationError('The AI service is rate limited right now. Please try again shortly.', 429, 'openai_rate_limited');
  }

  if (status && status >= 500) {
    return new OpenAiGenerationError('The AI service is temporarily unavailable. Please try again.', 502, code);
  }

  if (status && status >= 400) {
    return new OpenAiGenerationError('The AI service could not generate that WhisperWrap. Please revise the details and try again.', 400, code);
  }

  return new OpenAiGenerationError('Failed to contact the AI service. Please try again.', 502, code);
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

function rateLimitFallbackEnabled(): boolean {
  return process.env.OPENAI_RATE_LIMIT_FALLBACK !== 'false';
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isRetryableOpenAIError(err: unknown): boolean {
  const status = asOpenAIError(err).status;
  return typeof status === 'number' && RETRYABLE_OPENAI_STATUSES.has(status);
}

function isRateLimitError(err: unknown): boolean {
  return asOpenAIError(err).status === 429;
}

function formatLabel(value: string): string {
  return value.replace(/_/g, ' ');
}

function fallbackScripture(input: WhisperGenerationInput): Pick<GeneratedWhisper, 'scriptureReference' | 'scriptureText'> {
  if (input.whisperType === 'comfort' || input.wrapStyle === 'healing') {
    return {
      scriptureReference: 'Psalm 34:18',
      scriptureText: 'The Lord is nigh unto them that are of a broken heart; and saveth such as be of a contrite spirit.',
    };
  }

  if (input.whisperType === 'forgiveness' || input.whisperType === 'apology' || input.wrapStyle === 'reconciliation') {
    return {
      scriptureReference: 'Colossians 3:13',
      scriptureText: 'Forbearing one another, and forgiving one another, even as Christ forgave you, so also do ye.',
    };
  }

  if (input.whisperType === 'congratulations' || input.wrapStyle === 'celebration') {
    return {
      scriptureReference: 'Psalm 118:24',
      scriptureText: 'This is the day which the Lord hath made; we will rejoice and be glad in it.',
    };
  }

  return {
    scriptureReference: 'Numbers 6:24-26',
    scriptureText: 'The Lord bless thee, and keep thee: the Lord make his face shine upon thee, and give thee peace.',
  };
}

function generateFallbackWhisperContent(input: WhisperGenerationInput): GeneratedWhisper {
  const recipientName = input.recipientName.trim();
  const style = formatLabel(input.wrapStyle);
  const type = formatLabel(input.whisperType);
  const scripture = fallbackScripture(input);

  return {
    title: `A ${style} WhisperWrap for ${recipientName}`,
    message: `${recipientName}, this ${type} message is sent with care and prayer. May you feel steadied by God's nearness today, held by grace, and encouraged to take the next faithful step at your own pace. You are not being rushed or pressured here; this is simply a warm reminder that your life matters deeply to God and to those who are cheering you on.`,
    scriptureReference: scripture.scriptureReference,
    scriptureText: scripture.scriptureText,
    shortPrayer: `Lord, bless ${recipientName} with peace, wisdom, courage, and a clear sense of Your gentle presence today. Amen.`,
  };
}

async function requestOpenAiWhisper(prompt: string): Promise<GeneratedWhisper> {
  const completion = await getClient().chat.completions.create({
    model: process.env.OPENAI_MODEL ?? 'gpt-4.1-mini',
    temperature: 0.7,
    messages: [
      {
        role: 'system',
        content:
          'You write compassionate, biblical, clear language for Christian encouragement. Avoid manipulation, shame, medical claims, and guaranteed outcomes.',
      },
      { role: 'user', content: prompt },
    ],
    response_format: { type: 'json_object' },
  });

  const content = completion.choices[0]?.message?.content;
  if (!content) throw new OpenAiGenerationError('The AI service returned an empty response. Please try again.', 502, 'openai_empty_content');

  return parseOpenAiJson(content);
}

export async function generateWhisperContent(input: WhisperGenerationInput): Promise<GeneratedWhisper> {
  const prompt = `Create one original Christian WhisperWrap message for the MVP.
Recipient name: ${input.recipientName}
Whisper type: ${input.whisperType}
Wrap style: ${input.wrapStyle}
Delivery format: ${input.deliveryFormat}
Sender intent: ${input.senderIntent}

Requirements:
- Return only valid JSON.
- JSON keys must be title, message, scriptureReference, scriptureText, shortPrayer.
- Message must be warm, consent-safe, and under 220 words.
- Scripture must be a public-domain Bible translation wording or a brief paraphrase.
- Do not invent private facts about the recipient.
- Do not include markdown.`;

  const attempts = retryAttempts() + 1;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await requestOpenAiWhisper(prompt);
    } catch (err) {
      lastError = err;
      if (attempt === attempts || !isRetryableOpenAIError(err)) break;
      await sleep(retryDelayMs() * attempt);
    }
  }

  if (lastError && isRateLimitError(lastError) && rateLimitFallbackEnabled()) {
    console.warn('OpenAI rate limited WhisperWrap generation; returning local fallback content instead.');
    return generateFallbackWhisperContent(input);
  }

  throw toGenerationError(lastError);
}
