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

export async function generateWhisperContent(input: {
  recipientName: string;
  whisperType: WhisperType;
  wrapStyle: WrapStyle;
  deliveryFormat: DeliveryFormat;
  senderIntent: string;
}): Promise<GeneratedWhisper> {
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

  try {
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
  } catch (err) {
    throw toGenerationError(err);
  }
}
