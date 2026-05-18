import sgMail from '@sendgrid/mail';

let configured = false;

function ensureConfig() {
  if (configured) return;
  const apiKey = process.env.SENDGRID_API_KEY;
  if (!apiKey) throw new Error('Missing SENDGRID_API_KEY');
  sgMail.setApiKey(apiKey);
  configured = true;
}

export async function sendConsentEmail(payload: {
  recipientEmail: string;
  senderName: string;
  unwrapLink: string;
}) {
  ensureConfig();
  const from = process.env.FROM_EMAIL;
  if (!from) throw new Error('Missing FROM_EMAIL');

  const text = `${payload.senderName} has sent you a WhisperWrap through WhisperComp.
Would you like to unwrap it?
Click here to accept and view your message: ${payload.unwrapLink}`;

  await sgMail.send({
    to: payload.recipientEmail,
    from,
    subject: `${payload.senderName} sent you a WhisperWrap`,
    text,
  });
}
