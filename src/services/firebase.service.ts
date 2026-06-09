import admin from 'firebase-admin';

let initialized = false;

function getPrivateKey(): string {
  const value = process.env.FIREBASE_PRIVATE_KEY;
  if (!value) {
    throw new Error('Missing FIREBASE_PRIVATE_KEY');
  }
  return value.replace(/\\n/g, '\n');
}

function init(): void {
  if (initialized) return;

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;

  if (!projectId || !clientEmail) {
    throw new Error('Missing Firebase config env variables');
  }

  admin.initializeApp({
    credential: admin.credential.cert({
      projectId,
      clientEmail,
      privateKey: getPrivateKey(),
    }),
    storageBucket: `${projectId}.appspot.com`,
  });

  initialized = true;
}
export function getFirestore(): FirebaseFirestore.Firestore {
  init();
  return admin.firestore();
}

export function getStorageBucket(): ReturnType<ReturnType<typeof admin.storage>['bucket']> {
  init();
  return admin.storage().bucket();
}

export async function verifyFirebaseToken(idToken: string): Promise<admin.auth.DecodedIdToken> {
  init();
  return admin.auth().verifyIdToken(idToken);
}

export const firebaseAdmin = admin;
