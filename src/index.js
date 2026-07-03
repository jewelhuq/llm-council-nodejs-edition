// LLM Council on Cloudflare Workers: serves the SPA from assets and the JSON/SSE API from /api/*.

import { register, login, createSession, getSessionUser, destroySession, ApiError } from './auth.js';
import { encryptString, decryptString, uuid4 } from './crypto.js';
import {
    stage1CollectResponses,
    stage2CollectRankings,
    stage3SynthesizeFinal,
    calculateAggregateRankings,
    generateConversationTitle,
    buildCostSummary,
} from './council.js';

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);

        if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
            try {
                return await handleApi(request, env, ctx, url);
            } catch (e) {
                const status = e instanceof ApiError ? e.status : 500;
                if (status === 500) console.error(e.stack ?? e.message);
                return json({ detail: e.message }, status);
            }
        }

        return env.ASSETS.fetch(request);
    },
};

async function handleApi(request, env, ctx, url) {
    const path = url.pathname.replace(/\/$/, '');
    const method = request.method;
    const isSecure = url.protocol === 'https:';

    // --- Auth (no session required) ---
    if (path === '/api/auth/register' && method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const user = await register(env, body.email, body.password);
        const cookie = await createSession(env, user.id, isSecure);
        return json(publicUser(user), 201, { 'Set-Cookie': cookie });
    }

    if (path === '/api/auth/login' && method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const user = await login(env, body.email, body.password);
        const cookie = await createSession(env, user.id, isSecure);
        return json(publicUser(user), 200, { 'Set-Cookie': cookie });
    }

    if (path === '/api/auth/logout' && method === 'POST') {
        const cookie = await destroySession(env, request, isSecure);
        return json({ ok: true }, 200, { 'Set-Cookie': cookie });
    }

    // --- Everything below requires a session ---
    const user = await getSessionUser(env, request);
    if (!user) throw new ApiError(401, 'Not authenticated');

    if (path === '/api/auth/me' && method === 'GET') {
        return json(publicUser(user));
    }

    if (path === '/api/settings' && method === 'PUT') {
        return updateSettings(request, env, user);
    }

    if (path === '/api/conversations' && method === 'GET') {
        const { results } = await env.DB.prepare(
            `SELECT c.id, c.title, c.created_at, COUNT(m.id) AS message_count
             FROM conversations c LEFT JOIN messages m ON m.conversation_id = c.id
             WHERE c.user_id = ? GROUP BY c.id ORDER BY c.created_at DESC`
        )
            .bind(user.id)
            .all();
        return json(results);
    }

    if (path === '/api/conversations' && method === 'POST') {
        const conversation = {
            id: uuid4(),
            title: 'New Conversation',
            created_at: new Date().toISOString(),
        };
        await env.DB.prepare('INSERT INTO conversations (id, user_id, title, created_at) VALUES (?, ?, ?, ?)')
            .bind(conversation.id, user.id, conversation.title, conversation.created_at)
            .run();
        return json({ ...conversation, messages: [] });
    }

    let m;
    if ((m = path.match(/^\/api\/conversations\/([A-Za-z0-9-]+)$/)) && method === 'GET') {
        const conversation = await getConversation(env, user.id, m[1]);
        return json(conversation);
    }

    if ((m = path.match(/^\/api\/conversations\/([A-Za-z0-9-]+)$/)) && method === 'DELETE') {
        const conversation = await env.DB.prepare('SELECT id FROM conversations WHERE id = ? AND user_id = ?')
            .bind(m[1], user.id)
            .first();
        if (!conversation) throw new ApiError(404, 'Conversation not found');

        await env.DB.batch([
            env.DB.prepare('DELETE FROM messages WHERE conversation_id = ?').bind(m[1]),
            env.DB.prepare('DELETE FROM conversations WHERE id = ?').bind(m[1]),
        ]);
        return json({ ok: true });
    }

    if ((m = path.match(/^\/api\/conversations\/([A-Za-z0-9-]+)\/message\/stream$/)) && method === 'POST') {
        return streamMessage(request, env, ctx, user, m[1]);
    }

    throw new ApiError(404, 'Not found');
}

// --- Handlers ---

async function updateSettings(request, env, user) {
    const body = await request.json().catch(() => ({}));
    const updated = { ...user };

    if (body.openrouter_api_key !== undefined) {
        const key = String(body.openrouter_api_key).trim();
        if (key === '') throw new ApiError(422, 'API key cannot be empty');
        requireEncryptionKey(env);
        updated.api_key_enc = await encryptString(key, env.ENCRYPTION_KEY);
    }

    if (body.council_models !== undefined) {
        const models = Array.isArray(body.council_models)
            ? body.council_models.map((s) => String(s).trim()).filter(Boolean)
            : [];
        if (models.length === 0) throw new ApiError(422, 'council_models must be a non-empty list');
        updated.council_models = JSON.stringify(models);
    }

    if (body.chairman_model !== undefined) {
        const model = String(body.chairman_model).trim();
        if (model === '') throw new ApiError(422, 'chairman_model cannot be empty');
        updated.chairman_model = model;
    }

    if (body.title_model !== undefined) {
        const model = String(body.title_model).trim();
        if (model === '') throw new ApiError(422, 'title_model cannot be empty');
        updated.title_model = model;
    }

    await env.DB.prepare(
        'UPDATE users SET api_key_enc = ?, council_models = ?, chairman_model = ?, title_model = ? WHERE id = ?'
    )
        .bind(updated.api_key_enc, updated.council_models, updated.chairman_model, updated.title_model, user.id)
        .run();

    return json(publicUser(updated));
}

async function getConversation(env, userId, conversationId) {
    const conversation = await env.DB.prepare('SELECT id, title, created_at FROM conversations WHERE id = ? AND user_id = ?')
        .bind(conversationId, userId)
        .first();
    if (!conversation) throw new ApiError(404, 'Conversation not found');

    const { results } = await env.DB.prepare('SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY id')
        .bind(conversationId)
        .all();

    conversation.messages = results.map((row) => ({ role: row.role, ...JSON.parse(row.content) }));
    return conversation;
}

async function streamMessage(request, env, ctx, user, conversationId) {
    const conversation = await getConversation(env, user.id, conversationId);

    const body = await request.json().catch(() => ({}));
    const content = typeof body.content === 'string' ? body.content : null;
    if (!content) throw new ApiError(422, 'Field "content" is required');

    if (!user.api_key_enc) throw new ApiError(400, 'Set your OpenRouter API key in Settings first');
    requireEncryptionKey(env);
    const apiKey = await decryptString(user.api_key_enc, env.ENCRYPTION_KEY);

    const councilModels = JSON.parse(user.council_models);
    const isFirstMessage = conversation.messages.length === 0;

    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();
    const send = (event) => writer.write(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));

    ctx.waitUntil(
        (async () => {
            try {
                await addMessage(env, conversationId, 'user', { content });

                await send({ type: 'stage1_start' });
                const stage1 = await stage1CollectResponses(apiKey, councilModels, content);
                await send({ type: 'stage1_complete', data: stage1 });

                await send({ type: 'stage2_start' });
                const [stage2, labelToModel] = await stage2CollectRankings(apiKey, councilModels, content, stage1);
                const aggregateRankings = calculateAggregateRankings(stage2, labelToModel);
                await send({
                    type: 'stage2_complete',
                    data: stage2,
                    metadata: { label_to_model: labelToModel, aggregate_rankings: aggregateRankings },
                });

                await send({ type: 'stage3_start' });
                const stage3 = await stage3SynthesizeFinal(apiKey, user.chairman_model, content, stage1, stage2);
                await send({ type: 'stage3_complete', data: stage3 });

                let titleCost = null;
                if (isFirstMessage) {
                    const { title, cost } = await generateConversationTitle(apiKey, user.title_model, content);
                    titleCost = cost;
                    await env.DB.prepare('UPDATE conversations SET title = ? WHERE id = ?').bind(title, conversationId).run();
                    await send({ type: 'title_complete', data: { title } });
                }

                const costs = buildCostSummary(
                    stage1,
                    stage2,
                    stage3,
                    isFirstMessage ? user.title_model : null,
                    titleCost
                );
                await send({ type: 'costs_complete', data: costs });

                await addMessage(env, conversationId, 'assistant', { stage1, stage2, stage3, costs });

                await send({ type: 'complete' });
            } catch (e) {
                console.error(e.stack ?? e.message);
                await send({ type: 'error', message: e.message }).catch(() => {});
            } finally {
                await writer.close().catch(() => {});
            }
        })()
    );

    return new Response(readable, {
        headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
        },
    });
}

// --- Helpers ---

async function addMessage(env, conversationId, role, content) {
    await env.DB.prepare('INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)')
        .bind(conversationId, role, JSON.stringify(content), new Date().toISOString())
        .run();
}

function requireEncryptionKey(env) {
    if (!env.ENCRYPTION_KEY) {
        throw new ApiError(500, 'Server is missing the ENCRYPTION_KEY secret');
    }
}

function publicUser(user) {
    return {
        email: user.email,
        has_api_key: Boolean(user.api_key_enc),
        council_models: JSON.parse(user.council_models),
        chairman_model: user.chairman_model,
        title_model: user.title_model,
    };
}

function json(data, status = 200, extraHeaders = {}) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json', ...extraHeaders },
    });
}
