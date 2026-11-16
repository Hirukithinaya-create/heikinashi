import firebaseConfig from '../../firebase-applet-config.json';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function deriveUserVaultKey(uid: string): Promise<CryptoKey> {
  const material = `${uid}::${firebaseConfig.projectId}::${firebaseConfig.appId}::HeikinPulseVault`;
  const keyMaterial = await window.crypto.subtle.importKey(
    'raw',
    encoder.encode(material),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );

  const salt = encoder.encode(`hp-salt-${uid}-${firebaseConfig.firestoreDatabaseId}`);
  return window.crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations: 120_000,
      hash: 'SHA-256'
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function encryptForUser(uid: string, plaintext: string): Promise<string> {
  const key = await deriveUserVaultKey(uid);
  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  const cipherBuffer = await window.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoder.encode(plaintext)
  );
  return `v1:${toBase64(iv)}:${toBase64(new Uint8Array(cipherBuffer))}`;
}

export async function decryptForUser(uid: string, payload: string): Promise<string> {
  const parts = payload.split(':');
  if (parts.length !== 3 || parts[0] !== 'v1') {
    throw new Error('Unsupported encrypted credential format');
  }
  const iv = fromBase64(parts[1]);
  const cipherBytes = fromBase64(parts[2]);
  const key = await deriveUserVaultKey(uid);
  const plainBuffer = await window.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    cipherBytes
  );
  return decoder.decode(plainBuffer);
}

export function maskApiKey(apiKey: string): string {
  const trimmed = apiKey.trim();
  if (trimmed.length <= 8) {
    return `${trimmed.slice(0, 2)}••••${trimmed.slice(-2)}`;
  }
  return `${trimmed.slice(0, 4)}••••••${trimmed.slice(-4)}`;
}
