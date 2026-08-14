export type WhisperType =
  | 'congratulations'
  | 'comfort'
  | 'motivation'
  | 'forgiveness'
  | 'apology'
  | 'reconnection'
  | 'encouragement';

export type WrapStyle =
  | 'gentle'
  | 'prophetic'
  | 'elegant'
  | 'celebration'
  | 'healing'
  | 'reconciliation'
  | 'gratitude'
  | 'romantic'
  | 'encouragement'
  | 'legacy';

export type DeliveryFormat = 'text' | 'audio' | 'text_audio';

export type RecipientGender = 'male' | 'female';

export type WhisperStatus =
  | 'draft'
  | 'generated'
  | 'content_confirmed'
  | 'consent_pending'
  | 'sms_consented'
  | 'delivered'
  // Legacy values remain readable during migration.
  | 'consent_sent'
  | 'accepted'
  | 'opened'
  | 'listened'
  | 'failed';

export interface SmsConsentRecord {
  status: 'pending' | 'granted' | 'declined' | 'revoked';
  phoneNumber?: string | null;
  consentedAt?: FirebaseFirestore.Timestamp | FirebaseFirestore.FieldValue | null;
  revokedAt?: FirebaseFirestore.Timestamp | FirebaseFirestore.FieldValue | null;
  method?: 'web-checkbox';
  source?: 'recipient-sms-consent-page';
  disclosureVersion?: string | null;
  termsVersion?: string | null;
  privacyVersion?: string | null;
  disclosureText?: string | null;
}

export interface GeneratedWhisper {
  title: string;
  message: string;
  scriptureReference: string;
  scriptureText: string;
  shortPrayer: string;
}

export interface WhisperRecord {
  userId: string;
  senderName: string;
  recipientName: string;
  recipientAddressName: string;
  recipientGender: RecipientGender;
  recipientEmail: string | null;
  recipientPhone?: string | null;
  whisperType: WhisperType;
  wrapStyle: WrapStyle;
  deliveryFormat: DeliveryFormat;
  senderIntent: string;
  generatedContent: GeneratedWhisper;
  audioPath?: string | null;
  status: WhisperStatus;
  tokenHash?: string | null;
  smsConsent?: SmsConsentRecord | null;
  smsConsentTokenHash?: string | null;
  smsConsentTokenCreatedAt?: FirebaseFirestore.Timestamp | FirebaseFirestore.FieldValue | null;
  smsConsentTokenUsedAt?: FirebaseFirestore.Timestamp | FirebaseFirestore.FieldValue | null;
  smsDeliveryState?: 'not_authorized' | 'sending' | 'sent' | 'failed' | null;
  contentConfirmedAt?: FirebaseFirestore.FieldValue;
  consentSentAt?: FirebaseFirestore.FieldValue;
  acceptedAt?: FirebaseFirestore.FieldValue;
  openedAt?: FirebaseFirestore.FieldValue;
  listenedAt?: FirebaseFirestore.FieldValue;
  smsSid?: string | null;
  smsStatus?: string | null;
  smsSentAt?: FirebaseFirestore.FieldValue;
  createdAt: FirebaseFirestore.FieldValue;
  updatedAt: FirebaseFirestore.FieldValue;
}

export interface RecipientEventRecord {
  whisperId: string;
  event: WhisperStatus;
  createdAt: FirebaseFirestore.FieldValue;
  metadata?: Record<string, unknown>;
}
