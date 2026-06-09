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
The backend accepts Firebase ID tokens from the Angular/Firebase client. After signing in or signing up with Firebase Auth, call `currentUser.getIdToken()` and pass it to protected backend endpoints:

```http
Authorization: Bearer <firebase-id-token>
```

The middleware verifies the token with the Firebase Admin SDK and ensures `users/{uid}` exists with `subscriptionStatus: "inactive"` if the frontend did not already create the profile document. This is compatible with a frontend service that uses `createUserWithEmailAndPassword`, writes `users/{uid}`, and reads the user profile from Firestore.

An optional backend signup endpoint is still available if you prefer server-side account creation:

```http
POST /api/auth/signup
Content-Type: application/json

{
  "email": "user@example.com",
  "password": "at-least-8-chars",
  "displayName": "User Name"
}
```

The endpoint uses the Firebase Admin SDK to create the Auth user, creates `users/{uid}` with `subscriptionStatus: "inactive"`, and returns a Firebase custom token. On the frontend, call `signInWithCustomToken(auth, customToken)` with the returned token.

## Setup
1. Copy `.env.example` to `.env` and fill values. Set `CORS_ORIGIN` to your Angular app origin, for example `http://localhost:4200`.
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
