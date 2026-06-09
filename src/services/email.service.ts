import sgMail from '@sendgrid/mail';

let configured = false;

function ensureConfig() {
  if (configured) return;
  const apiKey = process.env.SENDGRID_API_KEY;
  if (!apiKey) throw new Error('Missing SENDGRID_API_KEY');
  sgMail.setApiKey(apiKey);
  configured = true;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export async function sendConsentEmail(payload: {
  recipientEmail: string;
  recipientName: string;
  senderName: string;
  unwrapLink: string;
}) {
  ensureConfig();
  const from = process.env.FROM_EMAIL;
  if (!from) throw new Error('Missing FROM_EMAIL');

  const senderName = payload.senderName.trim() || 'A friend';
  const text = `${senderName} has sent you a WhisperWrap through WhisperComp.
Would you like to unwrap it?
Click here to accept and view your message: ${payload.unwrapLink}`;

  const safeSenderName = escapeHtml(senderName);
  const safeRecipientName = escapeHtml(payload.recipientName.trim() || 'there');
  const safeLink = escapeHtml(payload.unwrapLink);

  await sgMail.send({
    to: payload.recipientEmail,
    from,
    subject: `${senderName} sent you a WhisperWrap`,
    text,
    html: `
      <p>Hello ${safeRecipientName},</p>
      <p>${safeSenderName} has sent you a WhisperWrap through WhisperComp.</p>
      <p>Would you like to unwrap it?</p>
      <p><a href="${safeLink}">Click here to accept and view your message</a></p>
    `,
  });
}
