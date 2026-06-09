# WhisperWrap Backend MVP

Node.js/Express backend for WhisperWrap MVP only.

## Features
- Firebase Auth account creation and verification
- Subscription gate (`users/{uid}.subscriptionStatus === active`)
- AI message generation endpoint (`POST /api/whispers/generate`)
- Optional audio upload URL generation (`POST /api/whispers/audio-upload-url`)
- Consent email endpoint (`POST /api/whispers/send-consent`)
- Public unwrap endpoint (`GET /api/whispers/unwrap/:token`)
- Firestore collections: `users`, `whispers`, `recipientEvents`

## Auth
Create accounts through the backend instead of calling Firebase client `createUserWithEmailAndPassword` directly:

```http
POST /api/auth/signup
Content-Type: application/json

{
  "email": "user@example.com",
  "password": "at-least-8-chars",
  "displayName": "User Name"
}
```

The endpoint uses the Firebase Admin SDK to create the Auth user, creates `users/{uid}` with `subscriptionStatus: "inactive"`, and returns a Firebase custom token. On the frontend, call `signInWithCustomToken(auth, customToken)` with the returned token. This avoids the Firebase Web SDK `auth/operation-not-allowed` error that occurs when the Email/Password sign-in provider is disabled for direct client sign-up.

## Setup
1. Copy `.env.example` to `.env` and fill values.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Run in dev:
   ```bash
   npm run dev
   ```

## API flow test
1. Call `POST /api/auth/signup`, sign in with the returned custom token, and get an ID token on the frontend.
2. Ensure `users/{uid}` has `subscriptionStatus: "active"`.
3. Call `POST /api/whispers/generate` with Bearer token and payload.
4. (Optional audio) call `POST /api/whispers/audio-upload-url`, then `PUT` raw audio to returned signed URL.
5. Call `POST /api/whispers/send-consent` with `whisperId`.
6. Open returned unwrap link (or call `GET /api/whispers/unwrap/:token`).
7. Verify `whispers.status` and `recipientEvents` updates.
