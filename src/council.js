// 3-stage LLM Council orchestration over OpenRouter (port of karpathy/llm-council).

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';

export const DEFAULT_COUNCIL_MODELS = [
    'openai/gpt-5.1',
    'google/gemini-3.1-pro-preview',
    'anthropic/claude-sonnet-4.5',
    'x-ai/grok-4.3',
];
export const DEFAULT_CHAIRMAN_MODEL = 'google/gemini-3.1-pro-preview';
export const DEFAULT_TITLE_MODEL = 'google/gemini-2.5-flash';

/** Query a single model. Returns { content, reasoning_details } or null on failure. */
export async function queryModel(apiKey, model, messages, timeoutMs = 120000) {
    try {
        const response = await fetch(OPENROUTER_API_URL, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ model, messages, usage: { include: true } }),
            signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) {
            console.error(`Error querying model ${model}: HTTP ${response.status} ${await response.text()}`);
            return null;
        }
        const data = await response.json();
        const message = data.choices[0].message;
        return {
            content: message.content ?? null,
            reasoning_details: message.reasoning_details ?? null,
            cost: data.usage?.cost ?? null,
            tokens: data.usage?.total_tokens ?? null,
        };
    } catch (e) {
        console.error(`Error querying model ${model}: ${e.message}`);
        return null;
    }
}

/** Query multiple models in parallel. Returns a Map of model => response|null. */
export async function queryModelsParallel(apiKey, models, messages) {
    const responses = await Promise.all(models.map((model) => queryModel(apiKey, model, messages)));
    return new Map(models.map((model, i) => [model, responses[i]]));
}

/** Stage 1: individual responses from all council models. */
export async function stage1CollectResponses(apiKey, councilModels, userQuery) {
    const messages = [{ role: 'user', content: userQuery }];
    const responses = await queryModelsParallel(apiKey, councilModels, messages);

    const results = [];
    for (const [model, response] of responses) {
        if (response !== null) {
            results.push({ model, response: response.content ?? '', cost: response.cost, tokens: response.tokens });
        }
    }
    return results;
}

/** Stage 2: each model ranks the anonymized responses. Returns [rankings, labelToModel]. */
export async function stage2CollectRankings(apiKey, councilModels, userQuery, stage1Results) {
    const labelToModel = {};
    const responseBlocks = [];
    stage1Results.forEach((result, i) => {
        const label = String.fromCharCode(65 + i);
        labelToModel[`Response ${label}`] = result.model;
        responseBlocks.push(`Response ${label}:\n${result.response}`);
    });
    const responsesText = responseBlocks.join('\n\n');

    const rankingPrompt = `You are evaluating different responses to the following question:

Question: ${userQuery}

Here are the responses from different models (anonymized):

${responsesText}

Your task:
1. First, evaluate each response individually. For each response, explain what it does well and what it does poorly.
2. Then, at the very end of your response, provide a final ranking.

IMPORTANT: Your final ranking MUST be formatted EXACTLY as follows:
- Start with the line "FINAL RANKING:" (all caps, with colon)
- Then list the responses from best to worst as a numbered list
- Each line should be: number, period, space, then ONLY the response label (e.g., "1. Response A")
- Do not add any other text or explanations in the ranking section

Example of the correct format for your ENTIRE response:

Response A provides good detail on X but misses Y...
Response B is accurate but lacks depth on Z...
Response C offers the most comprehensive answer...

FINAL RANKING:
1. Response C
2. Response A
3. Response B

Now provide your evaluation and ranking:`;

    const messages = [{ role: 'user', content: rankingPrompt }];
    const responses = await queryModelsParallel(apiKey, councilModels, messages);

    const results = [];
    for (const [model, response] of responses) {
        if (response !== null) {
            const fullText = response.content ?? '';
            results.push({
                model,
                ranking: fullText,
                parsed_ranking: parseRankingFromText(fullText),
                cost: response.cost,
                tokens: response.tokens,
            });
        }
    }
    return [results, labelToModel];
}

/** Stage 3: chairman synthesizes the final response. */
export async function stage3SynthesizeFinal(apiKey, chairmanModel, userQuery, stage1Results, stage2Results) {
    const stage1Text = stage1Results.map((r) => `Model: ${r.model}\nResponse: ${r.response}`).join('\n\n');
    const stage2Text = stage2Results.map((r) => `Model: ${r.model}\nRanking: ${r.ranking}`).join('\n\n');

    const chairmanPrompt = `You are the Chairman of an LLM Council. Multiple AI models have provided responses to a user's question, and then ranked each other's responses.

Original Question: ${userQuery}

STAGE 1 - Individual Responses:
${stage1Text}

STAGE 2 - Peer Rankings:
${stage2Text}

Your task as Chairman is to synthesize all of this information into a single, comprehensive, accurate answer to the user's original question. Consider:
- The individual responses and their insights
- The peer rankings and what they reveal about response quality
- Any patterns of agreement or disagreement

Provide a clear, well-reasoned final answer that represents the council's collective wisdom:`;

    const messages = [{ role: 'user', content: chairmanPrompt }];
    const response = await queryModel(apiKey, chairmanModel, messages);

    if (response === null) {
        return { model: chairmanModel, response: 'Error: Unable to generate final synthesis.', cost: null, tokens: null };
    }
    return { model: chairmanModel, response: response.content ?? '', cost: response.cost, tokens: response.tokens };
}

/** Parse the FINAL RANKING section from a model's response. Returns labels in ranked order. */
export function parseRankingFromText(rankingText) {
    if (rankingText.includes('FINAL RANKING:')) {
        const section = rankingText.split('FINAL RANKING:').slice(1).join('FINAL RANKING:');

        const numbered = section.match(/\d+\.\s*Response [A-Z]/g);
        if (numbered && numbered.length > 0) {
            return numbered.map((m) => m.match(/Response [A-Z]/)[0]);
        }

        return section.match(/Response [A-Z]/g) ?? [];
    }
    return rankingText.match(/Response [A-Z]/g) ?? [];
}

/** Aggregate rankings across all models, sorted best (lowest average) first. */
export function calculateAggregateRankings(stage2Results, labelToModel) {
    const positions = {};

    for (const ranking of stage2Results) {
        const parsed = parseRankingFromText(ranking.ranking);
        parsed.forEach((label, index) => {
            const model = labelToModel[label];
            if (model) {
                (positions[model] ??= []).push(index + 1);
            }
        });
    }

    return Object.entries(positions)
        .map(([model, ranks]) => ({
            model,
            average_rank: Math.round((ranks.reduce((a, b) => a + b, 0) / ranks.length) * 100) / 100,
            rankings_count: ranks.length,
        }))
        .sort((a, b) => a.average_rank - b.average_rank);
}

/** Generate a short conversation title (3-5 words) from the first user message. */
export async function generateConversationTitle(apiKey, titleModel, userQuery) {
    const titlePrompt = `Generate a very short title (3-5 words maximum) that summarizes the following question.
The title should be concise and descriptive. Do not use quotes or punctuation in the title.

Question: ${userQuery}

Title:`;

    const response = await queryModel(apiKey, titleModel, [{ role: 'user', content: titlePrompt }], 30000);
    if (response === null) return { title: 'New Conversation', cost: null };

    let title = (response.content ?? 'New Conversation').trim().replace(/^["']+|["']+$/g, '');
    if (title.length > 50) title = title.slice(0, 47) + '...';
    return { title, cost: response.cost };
}

/**
 * Build a per-model / combined cost summary for one council run.
 * Costs are USD as reported by OpenRouter; null when a provider didn't report one.
 */
export function buildCostSummary(stage1, stage2, stage3, titleModel = null, titleCost = null) {
    const perModel = {};
    for (const r of stage1) (perModel[r.model] ??= { stage1: null, stage2: null }).stage1 = r.cost;
    for (const r of stage2) (perModel[r.model] ??= { stage1: null, stage2: null }).stage2 = r.cost;

    const models = Object.entries(perModel).map(([model, c]) => ({
        model,
        stage1_cost: c.stage1,
        stage2_cost: c.stage2,
        total: (c.stage1 ?? 0) + (c.stage2 ?? 0),
    }));

    let total = models.reduce((sum, m) => sum + m.total, 0);
    total += stage3.cost ?? 0;
    if (titleCost !== null) total += titleCost;

    return {
        models,
        chairman: { model: stage3.model, cost: stage3.cost },
        title: titleModel ? { model: titleModel, cost: titleCost } : null,
        total,
    };
}
