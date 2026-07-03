# LLM Council — Cloudflare Workers

A multi-user web app that sends your question to a **council of LLMs** (GPT, Gemini, Claude, Grok — configurable), has them **anonymously peer-review and rank each other's answers**, and lets a **Chairman model synthesize the final response**. Based on [karpathy/llm-council](https://github.com/karpathy/llm-council), rebuilt for Cloudflare Workers + D1.

## How it works

1. **Stage 1 — First opinions.** Your question goes to every council model in parallel. Each answer is shown in its own tab.
2. **Stage 2 — Peer review.** Each model sees the other answers anonymized as "Response A/B/C…" (so it can't play favorites), critiques them, and ranks them by accuracy and insight. Rankings are aggregated into a leaderboard.
3. **Stage 3 — Synthesis.** The Chairman model reads everything and writes the final answer.

All three stages stream live to the browser via Server-Sent Events, with a **cost breakdown** (per model, per stage, and combined — real amounts billed by OpenRouter) shown at the top of every answer.

## Features

- **Login / registration** — email + password (PBKDF2 hashing, cookie sessions stored in D1)
- **Bring your own key** — every user saves their *own* OpenRouter API key (AES-GCM encrypted at rest), so each user pays for their own queries
- **Per-user model settings** — council members, chairman, and title model are editable in the UI
- **Conversation history** in D1, with per-conversation delete
- **Zero frameworks** — one Worker serves both the static UI and the API

## Project structure

```
├── wrangler.jsonc        # Worker config (D1 binding, static assets)
├── schema.sql            # D1 tables: users, sessions, conversations, messages
├── public/
│   └── index.html        # entire UI (vanilla JS single page)
└── src/
    ├── index.js          # fetch handler + API routes + SSE streaming
    ├── auth.js           # register / login / sessions
    ├── council.js        # 3-stage council orchestration + cost summary
    └── crypto.js         # PBKDF2, AES-GCM, session tokens
```

## Prerequisites

- [Node.js](https://nodejs.org/) 20+
- A [Cloudflare account](https://dash.cloudflare.com/sign-up) (free plan is enough)
- An [OpenRouter](https://openrouter.ai/) API key with some credits (entered per-user in the app, not at deploy time)

## Run locally

```bash
npm install

# create local dev secrets
cp .dev.vars.example .dev.vars

# create the local D1 tables
npm run db:init:local

# start the dev server
npm run dev
```

Open http://localhost:8787, register an account, then open **Settings** and paste your OpenRouter API key.

> Local mode uses a simulated D1 database on your machine — no Cloudflare resources are touched.

## Connect Wrangler & deploy

**1. Log in to Cloudflare** (opens a browser window to authorize):

```bash
npx wrangler login
npx wrangler whoami   # verify: shows your account name and id
```

**2. Create the D1 database:**

```bash
npx wrangler d1 create llm-council
```

Copy the printed `database_id` into `wrangler.jsonc`:

```jsonc
"d1_databases": [
    {
        "binding": "DB",
        "database_name": "llm-council",
        "database_id": "<paste-your-id-here>"
    }
]
```

**3. Create the tables in the remote database:**

```bash
npm run db:init:remote
```

**4. Set the encryption secret** (used to encrypt users' stored OpenRouter keys — pick a long random string and keep a copy somewhere safe; if you lose it, stored keys can't be decrypted):

```bash
openssl rand -hex 32          # generate one
npx wrangler secret put ENCRYPTION_KEY   # paste it when prompted
```

**5. Deploy:**

```bash
npm run deploy
```

Wrangler prints your live URL (`https://llm-council.<your-subdomain>.workers.dev`). Open it, register, add your OpenRouter key in Settings, and ask your first question.

To ship updates later, just run `npm run deploy` again.

## Configuration reference

| Where | Name | Purpose |
|---|---|---|
| Secret (`wrangler secret put`) | `ENCRYPTION_KEY` | Encrypts stored OpenRouter API keys at rest |
| `.dev.vars` (local only) | `ENCRYPTION_KEY` | Same, for `wrangler dev` |
| Per-user (Settings UI) | OpenRouter API key | Pays for that user's queries |
| Per-user (Settings UI) | Council / Chairman / Title models | Any OpenRouter model ids |

Default models (editable per user): `openai/gpt-5.1`, `google/gemini-3.1-pro-preview`, `anthropic/claude-sonnet-4.5`, `x-ai/grok-4.3`; chairman `google/gemini-3.1-pro-preview`; titles `google/gemini-2.5-flash`.

## API

| Method | Route | Description |
|---|---|---|
| POST | `/api/auth/register` | Create account `{email, password}` |
| POST | `/api/auth/login` | Log in, sets session cookie |
| POST | `/api/auth/logout` | Invalidate session |
| GET | `/api/auth/me` | Current user + settings |
| PUT | `/api/settings` | Update API key / models |
| GET | `/api/conversations` | List conversations |
| POST | `/api/conversations` | Create conversation |
| GET | `/api/conversations/:id` | Get conversation with messages |
| DELETE | `/api/conversations/:id` | Delete conversation + messages |
| POST | `/api/conversations/:id/message/stream` | Run the council (SSE stream) |

## Notes & caveats

- **Open registration**: anyone with the URL can create an account, but they can only spend their own OpenRouter credits. Put [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/) in front if you want to restrict access entirely.
- No email verification or password reset (yet).
- Each question costs roughly `2 × (council size) + 2` model calls (answers + reviews + chairman + title).
- Cloudflare free plan limits (100k requests/day, D1 5 GB) are far above personal usage.

## Credits

Council concept and prompts from [karpathy/llm-council](https://github.com/karpathy/llm-council) (MIT-style "do whatever you want with it" vibe-code). This port: Cloudflare Workers, D1, multi-user auth, encrypted per-user keys, cost tracking.
