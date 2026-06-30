# WhisperWrap Backend MVP

Production-ready Node.js/Express backend for the WhisperWrap MVP only. ShepherdCare is intentionally not included.

## MVP capabilities

- Firebase Auth token verification for signup/login flows.
- Firestore user profiles in `users` with `subscriptionStatus`.
- Active subscription gate for authenticated sender-only WhisperWrap actions after generation.
- AI message generation at `POST /api/whispers/generate`, with public preview generation enabled by default.
- Sender review support: load, edit, regenerate, and confirm generated content before consent is sent.
- Optional audio delivery through Firebase Storage signed upload and signed read URLs.
- Consent email delivery through SendGrid at `POST /api/whispers/send-consent`.
- Public unwrap flow at `/unwrap/:token` on the frontend, backed by `GET /api/whispers/unwrap/:token`.
- Recipient event tracking in `recipientEvents` for `consent_sent`, `accepted`, `opened`, and `listened`.
- Whisper statuses: `draft`, `generated`, `consent_sent`, `accepted`, `opened`, `listened`, `failed`.

## Firestore collections

### `users/{uid}`

```json
{
  "email": "sender@example.com",
  "displayName": "Sender Name",
  "subscriptionStatus": "inactive | active",
  "createdAt": "serverTimestamp",
  "updatedAt": "serverTimestamp"
}
```

By default, anyone can generate an AI preview WhisperWrap. Unauthenticated preview generation returns AI content without writing a backend `whispers` document, so the preview button does not depend on Firebase Admin being configured for anonymous callers. Include a Firebase ID token when calling `POST /api/whispers/generate` if you want the backend to persist the generated whisper and return a `whisperId`. Only users with `subscriptionStatus: "active"` can edit, upload audio for, or send WhisperWraps. Set `PUBLIC_WHISPER_GENERATION=false` to require active subscriptions for generation too.

### `whispers/{whisperId}`

Stores the recipient details, sender intent, generated content, optional `audioPath`, current status, and a hashed unwrap token. Raw unwrap tokens are never stored.

### `recipientEvents/{eventId}`

Stores immutable recipient timeline events:

```json
{
  "whisperId": "abc123",
  "event": "consent_sent | accepted | opened | listened",
  "createdAt": "serverTimestamp"
}
```

## Environment variables

Copy `.env.example` to `.env` and fill in the required values.

| Variable | Required | Description |
| --- | --- | --- |
| `PORT` | No | API port. Defaults to `3000`. |
| `CORS_ORIGIN` | No | Comma-separated frontend origins. Use your Angular/Ionic origin in production. |
| `OPENAI_API_KEY` | Yes | OpenAI API key for message generation. |
| `OPENAI_MODEL` | No | OpenAI model override. Defaults to `gpt-4.1-mini`. |
| `OPENAI_RETRY_ATTEMPTS` | No | Number of retry attempts for transient OpenAI failures. Defaults to `2`; maximum is `5`. |
| `OPENAI_RETRY_DELAY_MS` | No | Base retry delay for transient OpenAI failures. Defaults to `500`; maximum is `5000`. |
| `OPENAI_RATE_LIMIT_FALLBACK` | No | Set to `false` to disable local fallback WhisperWrap copy when OpenAI returns a rate-limit response after retries. Enabled by default. |
| `FIREBASE_PROJECT_ID` | Yes | Firebase project ID. |
| `FIREBASE_CLIENT_EMAIL` | Yes | Firebase service account client email. |
| `FIREBASE_PRIVATE_KEY` | Yes | Firebase service account private key with escaped newlines. |
| `FIREBASE_STORAGE_BUCKET` | No | Storage bucket override. Defaults to `<projectId>.appspot.com`. |
| `SENDGRID_API_KEY` | Yes | SendGrid API key. |
| `FROM_EMAIL` | Yes | Verified SendGrid sender email. |
| `APP_BASE_URL` | Yes | Frontend base URL used to build `/unwrap/:token` consent links. |
| `PASSWORD_RESET_CONTINUE_URL` | No | Optional Firebase password reset continue URL. |
| `PUBLIC_WHISPER_GENERATION` | No | Set to `false` to require a Firebase ID token and active subscription for `POST /api/whispers/generate`. Public generation is enabled by default so the frontend AI preview button can work before auth is attached; unauthenticated previews are not persisted by the backend. |

## Local setup

```bash
npm install
npm run dev
```

Useful checks:

```bash
npm run typecheck
npm run build
```

## Authentication

The Angular/Ionic app should authenticate users with Firebase Auth. Send Firebase ID tokens to protected backend endpoints. The backend accepts the token in the standard `Authorization` header, the `X-Firebase-ID-Token` header, or (for clients that cannot attach custom headers) a `firebaseIdToken` JSON body field:

```http
Authorization: Bearer <firebase-id-token>
# or
X-Firebase-ID-Token: <firebase-id-token>
# or include in JSON request body for protected POST/PATCH endpoints:
{ "firebaseIdToken": "<firebase-id-token>" }
```

The backend verifies the token with Firebase Admin SDK and ensures `users/{uid}` exists with `subscriptionStatus: "inactive"` by default.

An optional server-side signup helper is available:

```http
POST /api/auth/signup
Content-Type: application/json

{
  "email": "user@example.com",
  "password": "at-least-8-chars",
  "displayName": "User Name"
}
```

The response includes a Firebase custom token. The frontend can call `signInWithCustomToken(auth, customToken)`. Protected backend endpoints must receive the signed-in user's Firebase ID token (for example, from `await auth.currentUser.getIdToken()`), not this custom token.

A server-side forgot password helper is also available. It generates a Firebase password reset link and sends it through SendGrid. The response is intentionally generic when an account is not found.

```http
POST /api/auth/forgot-password
Content-Type: application/json

{
  "email": "user@example.com"
}
```

## API endpoints

### Generate WhisperWrap

```http
POST /api/whispers/generate
Authorization: Bearer <firebase-id-token> # optional unless PUBLIC_WHISPER_GENERATION=false
Content-Type: application/json

{
  "recipientName": "Jordan",
  "recipientEmail": "jordan@example.com",
  "recipientPhone": "+15551234567",
  "whisperType": "encouragement",
  "wrapStyle": "gentle",
  "deliveryFormat": "text_audio",
  "senderIntent": "Encourage Jordan before a major life transition."
}
```

Authenticated response:

```json
{
  "whisperId": "abc123",
  "persisted": true,
  "title": "A Gentle Word for the Road Ahead",
  "message": "...",
  "scriptureReference": "Psalm 121:8",
  "scriptureText": "...",
  "shortPrayer": "..."
}
```

Unauthenticated public preview responses use `200 OK`, return `"whisperId": null`, and include `"persisted": false` with the same generated content fields. Because these previews are not stored, they cannot be sent for consent until the user signs in, has an active subscription, and generates again with a Firebase ID token so the response includes a persisted `whisperId`.

### Load generated WhisperWrap

```http
GET /api/whispers/:whisperId
Authorization: Bearer <firebase-id-token>
```

### Edit reviewed content

```http
PATCH /api/whispers/:whisperId/content
Authorization: Bearer <firebase-id-token>
Content-Type: application/json

{
  "generatedContent": {
    "title": "Updated title",
    "message": "Updated message...",
    "scriptureReference": "Psalm 121:8",
    "scriptureText": "Updated scripture text...",
    "shortPrayer": "Updated prayer..."
  }
}
```

Edits are rejected after consent has been sent.

### Regenerate content

```http
POST /api/whispers/:whisperId/regenerate
Authorization: Bearer <firebase-id-token>
```

Regeneration is rejected after consent has been sent.

### Confirm reviewed content

```http
POST /api/whispers/:whisperId/confirm
Authorization: Bearer <firebase-id-token>
```

Confirmation records `contentConfirmedAt` and keeps the whisper sendable without introducing non-MVP statuses.

### Create audio upload URL

```http
POST /api/whispers/audio-upload-url
Authorization: Bearer <firebase-id-token>
Content-Type: application/json

{
  "whisperId": "abc123",
  "contentType": "audio/webm"
}
```

Upload the audio file directly to the returned signed `uploadUrl` within 15 minutes. Audio upload is only allowed for `audio` or `text_audio` delivery formats.

### Send consent email

```http
POST /api/whispers/send-consent
Authorization: Bearer <firebase-id-token>
Content-Type: application/json

{
  "whisperId": "abc123",
  "firebaseIdToken": "<firebase-id-token>"
}
```

`firebaseIdToken` is an optional fallback for clients that cannot attach auth headers.

A `401 Unauthorized` from this endpoint means the request did not include a verifiable Firebase ID token. In the frontend, call `await auth.currentUser.getIdToken()` after the user is signed in and send that ID token; do not send the custom token returned by `/api/auth/signup`. A `403 subscription_required` means the token was valid, but `users/{uid}.subscriptionStatus` is not `active`.

Email body:

```text
{SenderName} has sent you a WhisperWrap through WhisperComp.
Would you like to unwrap it?
Click here to accept and view your message: {unwrapLink}
```

For audio deliveries, this endpoint requires an uploaded audio file first.

### Public unwrap

Frontend route: `/unwrap/:token`

Backend endpoint used by the public page:

```http
GET /api/whispers/unwrap/:token
```

The frontend may call `POST /api/whispers/unwrap/:token/accept` when the recipient taps accept. The content request records `opened`. If the frontend skips the explicit accept call, the first successful content request records both `accepted` and `opened`. If audio exists, the response includes a one-hour signed `audioUrl`.

### Accept unwrap

```http
POST /api/whispers/unwrap/:token/accept
```

Call this when the recipient accepts the consent prompt before displaying content.

### Mark audio listened

```http
POST /api/whispers/unwrap/:token/listened
```

Call this after the recipient starts or completes audio playback to move the status to `listened` and record a recipient event.

## End-to-end MVP test flow

1. Create or sign in a Firebase Auth user.
2. Set `users/{uid}.subscriptionStatus` to `active` in Firestore.
3. Call `POST /api/whispers/generate` with the payload. Include a Firebase ID token if generation is configured to require auth or if you want the whisper attached to the sender account.
4. Review the generated content in the frontend.
5. Optionally call `PATCH /api/whispers/:whisperId/content` or `POST /api/whispers/:whisperId/regenerate`, then call `POST /api/whispers/:whisperId/confirm`.
6. For `audio` or `text_audio`, call `POST /api/whispers/audio-upload-url` and upload audio to Firebase Storage.
7. Call `POST /api/whispers/send-consent`.
8. Open the returned frontend unwrap link.
9. The public page calls `GET /api/whispers/unwrap/:token`, displays the message, scripture, prayer, optional audio, and the “Join Resurgence Vibe” link.
10. If audio is played, call `POST /api/whispers/unwrap/:token/listened`.
11. Verify `whispers.status` and `recipientEvents` in Firestore.
