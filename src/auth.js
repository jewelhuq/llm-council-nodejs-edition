// Registration, login, and cookie-session handling backed by D1.

import { hashPassword, timingSafeEqual, createSessionToken, sha256Hex, uuid4 } from './crypto.js';
import { DEFAULT_COUNCIL_MODELS, DEFAULT_CHAIRMAN_MODEL, DEFAULT_TITLE_MODEL } from './council.js';

const SESSION_COOKIE = 'session';
const SESSION_TTL_DAYS = 30;

export async function register(env, email, password) {
    email = String(email ?? '').trim().toLowerCase();
    password = String(password ?? '');

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ApiError(422, 'Invalid email address');
    if (password.length < 8) throw new ApiError(422, 'Password must be at least 8 characters');

    const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
    if (existing) throw new ApiError(409, 'An account with this email already exists');

    const { hash, salt } = await hashPassword(password);
    const user = {
        id: uuid4(),
        email,
        council_models: JSON.stringify(DEFAULT_COUNCIL_MODELS),
        chairman_model: DEFAULT_CHAIRMAN_MODEL,
        title_model: DEFAULT_TITLE_MODEL,
    };

    await env.DB.prepare(
        `INSERT INTO users (id, email, password_hash, password_salt, api_key_enc, council_models, chairman_model, title_model, created_at)
         VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?)`
    )
        .bind(user.id, email, hash, salt, user.council_models, user.chairman_model, user.title_model, new Date().toISOString())
        .run();

    return user;
}

export async function login(env, email, password) {
    email = String(email ?? '').trim().toLowerCase();

    const user = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
    if (!user) throw new ApiError(401, 'Invalid email or password');

    const { hash } = await hashPassword(String(password ?? ''), user.password_salt);
    if (!timingSafeEqual(hash, user.password_hash)) throw new ApiError(401, 'Invalid email or password');

    return user;
}

/** Create a session row and return the Set-Cookie header value. */
export async function createSession(env, userId, isSecure) {
    const { token, tokenHash } = await createSessionToken();
    const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 3600 * 1000).toISOString();

    await env.DB.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
        .bind(tokenHash, userId, expiresAt)
        .run();

    return sessionCookie(token, SESSION_TTL_DAYS * 24 * 3600, isSecure);
}

/** Resolve the current user from the request's session cookie, or null. */
export async function getSessionUser(env, request) {
    const token = readCookie(request, SESSION_COOKIE);
    if (!token) return null;

    const tokenHash = await sha256Hex(token);
    const row = await env.DB.prepare(
        `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ? AND s.expires_at > ?`
    )
        .bind(tokenHash, new Date().toISOString())
        .first();

    return row ?? null;
}

/** Delete the session and return an expiring Set-Cookie header value. */
export async function destroySession(env, request, isSecure) {
    const token = readCookie(request, SESSION_COOKIE);
    if (token) {
        await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256Hex(token)).run();
    }
    return sessionCookie('', 0, isSecure);
}

function sessionCookie(value, maxAge, isSecure) {
    return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${isSecure ? '; Secure' : ''}`;
}

function readCookie(request, name) {
    const header = request.headers.get('Cookie') ?? '';
    for (const part of header.split(';')) {
        const [k, ...v] = part.trim().split('=');
        if (k === name) return v.join('=');
    }
    return null;
}

export class ApiError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}
