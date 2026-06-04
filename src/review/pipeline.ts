import { collectDiff } from './diff';
import { splitIntoBatches, estimateTokens, getTokenBudget } from './tokens';
import { callLLM, SYSTEM_PROMPT } from './llm';
import { postReview, postFailureComment } from './post';
import { config } from '../config';
import type { ReviewResult } from './llm';

// Compute once at startup so we don't re-tokenize the prompt per request
const SYSTEM_PROMPT_TOKENS = estimateTokens(SYSTEM_PROMPT);

export async function runPipeline(
  octokit: any,
  owner: string,
  repo: string,
  pullNumber: number,
  prTitle: string,
  prBody: string,
): Promise<void> {
  console.log(`[pipeline] Starting ${owner}/${repo}#${pullNumber}`);

  try {
    // Step 1 — collect diff files with commentable-line metadata
    const files = await collectDiff(octokit, owner, repo, pullNumber);

    if (files.length === 0) {
      await postFailureComment(
        octokit,
        owner,
        repo,
        pullNumber,
        '검토할 변경 파일이 없습니다 (바이너리 또는 빈 diff)',
      );
      return;
    }

    // Step 2 — split into token-budget-sized batches
    const budget = getTokenBudget(config.LLM_MAX_CONTEXT_TOKENS);
    const batches = splitIntoBatches(files, SYSTEM_PROMPT_TOKENS, budget);

    // Step 3 — call LLM per batch (sequential to respect rate limits)
    const results: ReviewResult[] = [];
    for (const batch of batches) {
      if (batch.files.length === 0) continue;
      const result = await callLLM(prTitle, prBody, batch.files, batch.note);
      results.push(result);
    }

    if (results.length === 0) throw new Error('LLM 호출 결과가 없습니다');

    // Step 4 — merge multi-batch results
    const merged = mergeResults(results);

    // Step 5 — validate inline positions and post via Reviews API
    await postReview(octokit, owner, repo, pullNumber, files, merged);

    console.log(`[pipeline] Done ${owner}/${repo}#${pullNumber}`);
  } catch (err) {
    const reason = err instanceof Error ? err.message : '알 수 없는 오류';
    console.error(`[pipeline] Failed ${owner}/${repo}#${pullNumber}:`, err);

    await postFailureComment(octokit, owner, repo, pullNumber, reason).catch((postErr: unknown) =>
      console.error('[pipeline] Failed to post failure comment:', postErr),
    );
  }
}

function mergeResults(results: ReviewResult[]): ReviewResult {
  if (results.length === 1) return results[0];

  const summary = results.map((r) => r.summary).join('\n\n---\n\n');
  const comments = results.flatMap((r) => r.comments);

  // Re-sort across batches to keep severity order intact before the cap
  const order: Record<string, number> = { critical: 0, major: 1, minor: 2 };
  comments.sort((a, b) => (order[a.severity] ?? 2) - (order[b.severity] ?? 2));

  return { summary, comments };
}
