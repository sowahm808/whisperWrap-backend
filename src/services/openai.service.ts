import OpenAI from 'openai';
import { z } from 'zod';
import { DeliveryFormat, WhisperType, WrapStyle } from '../types/whisper.types.js';

const responseSchema = z.object({
  title: z.string().min(5),
  message: z.string().min(20),
  scriptureReference: z.string().min(3),
  scriptureText: z.string().min(5),
  shortPrayer: z.string().min(5),
});

let client: OpenAI | null = null;
function getClient(): OpenAI {
  if (!process.env.OPENAI_API_KEY) throw new Error('Missing OPENAI_API_KEY');
  if (!client) client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return client;
}

export async function generateWhisperContent(input: {
  recipientName: string;
  whisperType: WhisperType;
  wrapStyle: WrapStyle;
  deliveryFormat: DeliveryFormat;
  senderIntent: string;
}) {
  const prompt = `Create a heartfelt Christian WhisperWrap message.
Recipient: ${input.recipientName}
Type: ${input.whisperType}
Style: ${input.wrapStyle}
Delivery: ${input.deliveryFormat}
Sender intent: ${input.senderIntent}
Return strict JSON with keys: title, message, scriptureReference, scriptureText, shortPrayer.`;

  const completion = await getClient().chat.completions.create({
    model: 'gpt-4.1-mini',
    temperature: 0.8,
    messages: [
      {
        role: 'system',
        content:
          'You write compassionate, biblical, clear language. Keep message under 220 words and prayer under 60 words.',
      },
      { role: 'user', content: prompt },
    ],
    response_format: { type: 'json_object' },
  });

  const content = completion.choices[0]?.message?.content;
  if (!content) throw new Error('OpenAI returned empty content');

  const parsed = responseSchema.safeParse(JSON.parse(content));
  if (!parsed.success) throw new Error('OpenAI response schema validation failed');
  return parsed.data;
}
