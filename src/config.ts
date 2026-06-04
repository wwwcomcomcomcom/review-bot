import { readFileSync } from 'fs';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Required environment variable ${name} is not set`);
  return value;
}

function loadPrivateKey(): string {
  const key = process.env.GITHUB_PRIVATE_KEY;
  if (key) {
    // Support \n-escaped newlines, common when injecting via env var
    return key.replace(/\\n/g, '\n');
  }
  const keyPath = process.env.GITHUB_PRIVATE_KEY_PATH;
  if (keyPath) {
    return readFileSync(keyPath, 'utf-8');
  }
  throw new Error('GITHUB_PRIVATE_KEY or GITHUB_PRIVATE_KEY_PATH must be set');
}

export const config = {
  GITHUB_APP_ID: parseInt(requireEnv('GITHUB_APP_ID'), 10),
  GITHUB_PRIVATE_KEY: loadPrivateKey(),
  GITHUB_WEBHOOK_SECRET: requireEnv('GITHUB_WEBHOOK_SECRET'),
  LLM_BASE_URL: requireEnv('LLM_BASE_URL'),
  LLM_API_KEY: requireEnv('LLM_API_KEY'),
  LLM_MODEL: requireEnv('LLM_MODEL'),
  LLM_MAX_CONTEXT_TOKENS: parseInt(process.env.LLM_MAX_CONTEXT_TOKENS ?? '128000', 10),
  MAX_INLINE_COMMENTS: parseInt(process.env.MAX_INLINE_COMMENTS ?? '20', 10),
  PORT: parseInt(process.env.PORT ?? '3000', 10),
  QUEUE_CONCURRENCY: parseInt(process.env.QUEUE_CONCURRENCY ?? '2', 10),
} as const;
