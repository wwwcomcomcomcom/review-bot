import OpenAI from 'openai';
import { config } from '../config';
import type { DiffFile } from './diff';
import { formatFileForPrompt } from './tokens';

const client = new OpenAI({
  baseURL: config.LLM_BASE_URL,
  apiKey:  config.LLM_API_KEY,
});

export const SYSTEM_PROMPT = `당신은 시니어 코드 리뷰어입니다. PR의 diff를 분석하고 한국어로 코드 리뷰를 작성합니다.

**리뷰 초점 (이것만):**
- 버그 및 로직 오류
- 보안 취약점 (SQL 인젝션, XSS, 인증/인가 문제 등)
- 성능 및 효율성 문제

**절대 하지 말 것:**
- 순수한 코드 스타일, 포매팅, 취향 지적
- 확신 없는 추측성 지적
- diff에 등장하지 않은 라인에 대한 코멘트

각 comment는 diff에 실제로 등장한 라인을 가리켜야 합니다.
comments 배열은 심각도(critical > major > minor) 순으로 정렬하여 반환하세요.
반드시 submit_review 함수를 호출하여 결과를 제출하세요.`;

const SUBMIT_REVIEW_TOOL: OpenAI.Chat.ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'submit_review',
    description: 'Submit the structured PR review',
    parameters: {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description: 'PR 전체에 대한 한국어 요약 평가',
        },
        comments: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              path:     { type: 'string' },
              line:     { type: 'integer', description: 'new-file 기준 라인 번호' },
              side:     { type: 'string', enum: ['RIGHT', 'LEFT'] },
              severity: { type: 'string', enum: ['critical', 'major', 'minor'] },
              body:     { type: 'string', description: '한국어 지적/제안' },
            },
            required: ['path', 'line', 'side', 'severity', 'body'],
          },
        },
      },
      required: ['summary', 'comments'],
    },
  },
};

export interface ReviewComment {
  path:     string;
  line:     number;
  side:     'RIGHT' | 'LEFT';
  severity: 'critical' | 'major' | 'minor';
  body:     string;
}

export interface ReviewResult {
  summary:  string;
  comments: ReviewComment[];
}

export async function callLLM(
  prTitle: string,
  prBody:  string,
  files:   DiffFile[],
  partialNote?: string,
): Promise<ReviewResult> {
  const diffText = files.map(formatFileForPrompt).join('');

  const parts = [
    `## PR 제목\n${prTitle}`,
    `## PR 설명\n${prBody || '(없음)'}`,
    `## 변경 파일\n${diffText}`,
  ];
  if (partialNote) parts.push(`> 참고: ${partialNote}`);

  return callWithRetry(parts.join('\n\n'), 3);
}

async function callWithRetry(userContent: string, maxRetries: number): Promise<ReviewResult> {
  let lastError: unknown;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (attempt > 0) {
      await sleep(Math.pow(2, attempt) * 1_000);
    }

    try {
      const response = await client.chat.completions.create(
        {
          model:       config.LLM_MODEL,
          messages:    [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user',   content: userContent   },
          ],
          tools:       [SUBMIT_REVIEW_TOOL],
          tool_choice: { type: 'function', function: { name: 'submit_review' } },
        },
        { timeout: 120_000 },
      );

      const toolCall = response.choices[0]?.message?.tool_calls?.[0];

      if (toolCall?.function?.name === 'submit_review') {
        try {
          return parseAndValidate(toolCall.function.arguments);
        } catch {
          const fb = tryFallbackParse(toolCall.function.arguments);
          if (fb) return fb;
          throw new Error('tool call arguments가 파싱되지 않습니다');
        }
      }

      // Fallback: try to find JSON in text content
      const content = response.choices[0]?.message?.content ?? '';
      const fb = tryFallbackParse(content);
      if (fb) return fb;

      throw new Error('LLM이 submit_review를 호출하지 않았습니다');
    } catch (err) {
      lastError = err;
      console.error(
        `[llm] Attempt ${attempt + 1}/${maxRetries} failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`LLM 호출이 ${maxRetries}회 모두 실패했습니다`);
}

function parseAndValidate(raw: string): ReviewResult {
  return validate(JSON.parse(raw) as unknown);
}

function tryFallbackParse(text: string): ReviewResult | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return validate(JSON.parse(match[0]) as unknown);
  } catch {
    return null;
  }
}

function validate(raw: unknown): ReviewResult {
  if (typeof raw !== 'object' || raw === null) throw new Error('응답이 객체가 아닙니다');
  const obj = raw as Record<string, unknown>;
  if (typeof obj.summary !== 'string') throw new Error('summary 필드가 없습니다');

  const rawComments = Array.isArray(obj.comments) ? obj.comments : [];
  const comments: ReviewComment[] = rawComments
    .filter((c): c is Record<string, unknown> => typeof c === 'object' && c !== null)
    .flatMap((c) => {
      const path     = String(c.path ?? '');
      const line     = Number(c.line);
      const side     = c.side === 'LEFT' ? 'LEFT' : 'RIGHT';
      const rawSev   = String(c.severity ?? 'minor');
      const severity = (['critical', 'major', 'minor'].includes(rawSev) ? rawSev : 'minor') as ReviewComment['severity'];
      const body     = String(c.body ?? '');
      if (!path || !Number.isInteger(line) || line <= 0 || !body) return [];
      return [{ path, line, side, severity, body }];
    });

  return { summary: obj.summary, comments };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
