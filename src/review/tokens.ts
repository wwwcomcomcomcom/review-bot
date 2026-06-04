import { encode } from 'gpt-tokenizer';
import type { DiffFile } from './diff';

const OUTPUT_RESERVE = 8_000;
const SAFETY_MARGIN  = 2_000;

export function estimateTokens(text: string): number {
  try {
    return encode(text).length;
  } catch {
    // Fallback: rough char-based estimate (≈4 chars per token)
    return Math.ceil(text.length / 4);
  }
}

export function getTokenBudget(maxContextTokens: number): number {
  return maxContextTokens - OUTPUT_RESERVE - SAFETY_MARGIN;
}

export function formatFileForPrompt(file: DiffFile): string {
  return `### ${file.filename} (${file.status})\n\`\`\`diff\n${file.patch}\n\`\`\`\n\n`;
}

export interface DiffBatch {
  files: DiffFile[];
  isPartial: boolean;
  note?: string;
}

export function splitIntoBatches(
  files: DiffFile[],
  systemPromptTokens: number,
  budget: number,
): DiffBatch[] {
  const available = budget - systemPromptTokens;

  if (available <= 0) {
    return [{
      files: files.slice(0, 3),
      isPartial: true,
      note: 'PR이 너무 커서 일부만 리뷰함',
    }];
  }

  const batches: DiffBatch[] = [];
  let currentBatch: DiffFile[] = [];
  let currentTokens = 0;
  let includedCount = 0;

  for (const file of files) {
    const text       = formatFileForPrompt(file);
    const fileTokens = estimateTokens(text);

    if (fileTokens > available) {
      // Single file exceeds budget — truncate and emit as its own batch
      if (currentBatch.length > 0) {
        batches.push({ files: currentBatch, isPartial: false });
        currentBatch = [];
        currentTokens = 0;
      }
      batches.push({
        files: [truncatePatch(file, available)],
        isPartial: true,
        note: `${file.filename}: 파일이 너무 커서 일부만 검토됨`,
      });
      includedCount++;
      continue;
    }

    if (currentTokens + fileTokens > available) {
      batches.push({ files: currentBatch, isPartial: false });
      currentBatch   = [file];
      currentTokens  = fileTokens;
    } else {
      currentBatch.push(file);
      currentTokens += fileTokens;
    }
    includedCount++;
  }

  if (currentBatch.length > 0) {
    batches.push({ files: currentBatch, isPartial: false });
  }

  if (includedCount < files.length && batches.length > 0) {
    const last = batches[batches.length - 1];
    last.isPartial = true;
    last.note = `PR이 너무 커서 일부(${includedCount}/${files.length}개 파일)만 리뷰함`;
  }

  return batches.length > 0
    ? batches
    : [{ files: [], isPartial: true, note: '검토할 파일 없음' }];
}

function truncatePatch(file: DiffFile, maxTokens: number): DiffFile {
  const lines: string[] = [];
  let tokens = 0;
  const limit = Math.floor(maxTokens * 0.85);

  for (const line of file.patch.split('\n')) {
    const t = estimateTokens(line + '\n');
    if (tokens + t > limit) break;
    lines.push(line);
    tokens += t;
  }

  return { ...file, patch: lines.join('\n') + '\n... (이하 생략됨)' };
}
