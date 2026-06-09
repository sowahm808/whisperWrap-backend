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

export interface CreateFirebaseAccountInput {
  email: string;
  password: string;
  displayName?: string;
}

export async function createFirebaseAccount(input: CreateFirebaseAccountInput): Promise<{
  uid: string;
  email: string;
  displayName?: string;
  customToken: string;
}> {
  init();

  const user = await admin.auth().createUser({
    email: input.email,
    password: input.password,
    displayName: input.displayName,
  });

  await admin.firestore().collection('users').doc(user.uid).set({
    email: input.email,
    displayName: input.displayName ?? null,
    subscriptionStatus: 'inactive',
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  const customToken = await admin.auth().createCustomToken(user.uid);

  return {
    uid: user.uid,
    email: input.email,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    customToken,
  };
}

export const firebaseAdmin = admin;
