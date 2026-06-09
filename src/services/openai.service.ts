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

let client: OpenAI | null = null;
function getClient(): OpenAI {
  if (!process.env.OPENAI_API_KEY) throw new Error('Missing OPENAI_API_KEY');
  if (!client) client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return client;
}

function parseOpenAiJson(content: string): GeneratedWhisper {
  let decoded: unknown;

  try {
    decoded = JSON.parse(content);
  } catch {
    throw new Error('OpenAI returned invalid JSON');
  }

  const parsed = responseSchema.safeParse(decoded);
  if (!parsed.success) throw new Error('OpenAI response schema validation failed');
  return parsed.data;
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
  if (!content) throw new Error('OpenAI returned empty content');

  return parseOpenAiJson(content);
}
