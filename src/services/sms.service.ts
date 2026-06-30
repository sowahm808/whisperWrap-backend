import twilio from 'twilio';

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN,
);

export async function sendConsentSms({
  recipientPhone,
  recipientName,
  senderName,
  unwrapLink,
}: {
  recipientPhone: string;
  recipientName: string;
  senderName: string;
  unwrapLink: string;
}) {
  return client.messages.create({
    from: process.env.TWILIO_PHONE_NUMBER,
    to: recipientPhone,
    body: `Hi ${recipientName || 'there'}, ${senderName || 'A friend'} sent you a WhisperWrap. Would you like to unwrap it? ${unwrapLink}`,
  });
}