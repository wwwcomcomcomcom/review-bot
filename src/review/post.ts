import type { DiffFile } from './diff';
import type { ReviewComment, ReviewResult } from './llm';
import { buildCommentableSet } from './diff';
import { config } from '../config';

export async function postReview(
  octokit: any,
  owner: string,
  repo: string,
  pullNumber: number,
  files: DiffFile[],
  result: ReviewResult,
): Promise<void> {
  const commentable = buildCommentableSet(files);

  const valid: ReviewComment[] = [];
  const demoted: ReviewComment[] = [];

  for (const c of result.comments) {
    if (commentable.get(`${c.path}:${c.side}`)?.has(c.line)) {
      valid.push(c);
    } else {
      demoted.push(c);
    }
  }

  // Comments arrive severity-sorted from LLM; trim lowest-priority overflow
  const capped = valid.slice(0, config.MAX_INLINE_COMMENTS);
  const trimmedCount = valid.length - capped.length;

  let body = result.summary;

  if (demoted.length > 0) {
    body += '\n\n---\n**위치를 특정할 수 없는 지적 (인라인 앵커 불가):**\n';
    for (const c of demoted) {
      body += `- \`${c.path}:${c.line}\` **[${c.severity.toUpperCase()}]** ${c.body}\n`;
    }
  }

  if (trimmedCount > 0) {
    body += `\n\n> 그 외 ${trimmedCount}건의 경미한 지적은 생략되었습니다.`;
  }

  const comments = capped.map((c) => ({
    path: c.path,
    line: c.line,
    side: c.side,
    body: `**[${c.severity.toUpperCase()}]** ${c.body}`,
  }));

  await octokit.request('POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews', {
    owner,
    repo,
    pull_number: pullNumber,
    event: 'COMMENT',
    body,
    comments,
  });
}

export async function postFailureComment(
  octokit: any,
  owner: string,
  repo: string,
  pullNumber: number,
  reason: string,
): Promise<void> {
  await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
    owner,
    repo,
    issue_number: pullNumber,
    body: `⚠️ 자동 리뷰 실패: ${reason}. \`/review\` 로 다시 시도할 수 있습니다.`,
  });
}
