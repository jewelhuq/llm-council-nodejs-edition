// Crypto helpers: password hashing (PBKDF2), session tokens, API-key encryption (AES-GCM).

const enc = new TextEncoder();

function bytesToHex(bytes) {
    return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex) {
    return new Uint8Array(hex.match(/.{2}/g).map((h) => parseInt(h, 16)));
}

function bytesToBase64(bytes) {
    return btoa(String.fromCharCode(...bytes));
}

function base64ToBytes(b64) {
    return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

/**
 * Hash a password with PBKDF2-SHA256. Pass saltHex to verify an existing hash.
 * Returns { hash, salt } as hex strings.
 */
export async function hashPassword(password, saltHex = null) {
    const salt = saltHex ? hexToBytes(saltHex) : crypto.getRandomValues(new Uint8Array(16));
    const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
        { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
        keyMaterial,
        256
    );
    return { hash: bytesToHex(new Uint8Array(bits)), salt: bytesToHex(salt) };
}

/** Constant-time string comparison. */
export function timingSafeEqual(a, b) {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}

/** Random session token (returned to client) and its SHA-256 hash (stored in DB). */
export async function createSessionToken() {
    const token = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
    return { token, tokenHash: await sha256Hex(token) };
}

export async function sha256Hex(text) {
    const digest = await crypto.subtle.digest('SHA-256', enc.encode(text));
    return bytesToHex(new Uint8Array(digest));
}

async function aesKeyFromSecret(secret) {
    const digest = await crypto.subtle.digest('SHA-256', enc.encode(secret));
    return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** Encrypt a string with AES-GCM using a key derived from the given secret. Returns base64(iv || ciphertext). */
export async function encryptString(plain, secret) {
    const key = await aesKeyFromSecret(secret);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plain)));
    const combined = new Uint8Array(iv.length + cipher.length);
    combined.set(iv);
    combined.set(cipher, iv.length);
    return bytesToBase64(combined);
}

/** Decrypt a string produced by encryptString. */
export async function decryptString(b64, secret) {
    const key = await aesKeyFromSecret(secret);
    const combined = base64ToBytes(b64);
    const iv = combined.slice(0, 12);
    const cipher = combined.slice(12);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher);
    return new TextDecoder().decode(plain);
}

export function uuid4() {
    return crypto.randomUUID();
}
