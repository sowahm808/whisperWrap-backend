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
  | 'consent_sent'
  | 'accepted'
  | 'opened'
  | 'listened'
  | 'failed';

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
