# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- **Dev**: `npm run dev` — runs `ts-node src/index.ts` directly (no build step)
- **Build**: `npm run build` — compiles TypeScript to `./dist` via `tsc`
- **Production**: `npm start` — runs `node dist/index.js` (build first)
- **Docker**: `docker compose up --build`
- **Lint**: `npm run lint` — ESLint (`eslint.config.mjs`, TypeScript rules)
- **Format**: `npm run format` — Prettier (`singleQuote`, `trailingComma: all`, `printWidth: 100`)

No test suite exists yet.

## Environment Variables

Copy `.env.example` to `.env`. All variables marked required must be set before the app starts.

| Variable | Required | Default | Notes |
|---|---|---|---|
| `GITHUB_APP_ID` | ✅ | — | Numeric App ID from GitHub App settings |
| `GITHUB_PRIVATE_KEY` | ✅* | — | Full PEM content with literal `\n` escaping (see below) |
| `GITHUB_PRIVATE_KEY_PATH` | ✅* | — | Alternative: path to `.pem` file on disk |
| `GITHUB_WEBHOOK_SECRET` | ✅ | — | Secret set in GitHub App webhook config |
| `LLM_BASE_URL` | ✅ | — | OpenAI-compatible endpoint (e.g. `https://api.openai.com/v1`) |
| `LLM_API_KEY` | ✅ | — | API key for LLM provider |
| `LLM_MODEL` | ✅ | — | Model name (e.g. `gpt-4o`) |
| `LLM_MAX_CONTEXT_TOKENS` | ❌ | 128000 | Token budget for diff batching |
| `MAX_INLINE_COMMENTS` | ❌ | 20 | Per-review inline comment cap |
| `PORT` | ❌ | 3000 | HTTP listen port |
| `QUEUE_CONCURRENCY` | ❌ | 2 | Max concurrent LLM calls |

*One of `GITHUB_PRIVATE_KEY` or `GITHUB_PRIVATE_KEY_PATH` is required.

**PEM 인라인 주입 시**: 줄바꿈을 `\n`으로 이스케이프해야 한다.
```
GITHUB_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----"
```
`config.ts`가 `\n` → 실제 개행으로 변환한다. 파일 경로를 쓰려면 `GITHUB_PRIVATE_KEY_PATH=/path/to/key.pem`만 설정하면 된다.

## Architecture Decisions

- **Stateless**: No database. Previous bot reviews are never dismissed — each run appends a new review (intentional).
- **In-process queue**: `p-queue` (concurrency=2). In-flight jobs are lost on restart; retry via `/review` comment.
- **Webhook flow**: POST /webhook → immediate 200 → background queue → LLM → Reviews API. GitHub has a 10-second webhook timeout.
- **LLM structured output**: Uses tool calling (`submit_review`) to force `{summary, comments[]}`. Falls back to regex JSON extraction if tool call parsing fails.
- **Inline comment validation**: Patch hunks are parsed to build commentable-line sets. Invalid LLM-suggested lines are demoted to summary text (not dropped silently).
- **Token batching**: If diff exceeds `LLM_MAX_CONTEXT_TOKENS − 10K`, files are split into batches, results merged and re-sorted by severity.

## Commit Convention

Conventional Commits: `feat:`, `fix:`, `chore:`, `refactor:`, `docs:` prefixes.
