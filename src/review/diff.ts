export interface CommentableLine {
  line: number;
  side: 'RIGHT' | 'LEFT';
}

export interface DiffFile {
  filename: string;
  status: string;
  patch: string;
  commentableLines: CommentableLine[];
}

export async function collectDiff(
  octokit: any,
  owner: string,
  repo: string,
  pullNumber: number,
): Promise<DiffFile[]> {
  const files: DiffFile[] = [];
  let page = 1;

  for (;;) {
    const response = await octokit.rest.pulls.listFiles({
      owner,
      repo,
      pull_number: pullNumber,
      per_page: 100,
      page,
    });

    for (const file of response.data) {
      if (!file.patch) continue; // binary or deleted-without-content
      files.push({
        filename: file.filename as string,
        status: file.status as string,
        patch: file.patch as string,
        commentableLines: parseCommentableLines(file.patch as string),
      });
    }

    if ((response.data as unknown[]).length < 100) break;
    page++;
  }

  return files;
}

// Returns the set of (path, side) → lines that GitHub Reviews API will accept.
export function buildCommentableSet(files: DiffFile[]): Map<string, Set<number>> {
  const map = new Map<string, Set<number>>();
  for (const file of files) {
    for (const { line, side } of file.commentableLines) {
      const key = `${file.filename}:${side}`;
      const bucket = map.get(key);
      if (bucket) {
        bucket.add(line);
      } else {
        map.set(key, new Set([line]));
      }
    }
  }
  return map;
}

export function parseCommentableLines(patch: string): CommentableLine[] {
  const result: CommentableLine[] = [];
  let newLine = 0;
  let oldLine = 0;

  for (const raw of patch.split('\n')) {
    if (raw.startsWith('@@')) {
      // @@ -old_start[,count] +new_start[,count] @@
      const m = raw.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) {
        oldLine = parseInt(m[1], 10) - 1;
        newLine = parseInt(m[2], 10) - 1;
      }
    } else if (raw.startsWith('+')) {
      newLine++;
      result.push({ line: newLine, side: 'RIGHT' });
    } else if (raw.startsWith('-')) {
      oldLine++;
      result.push({ line: oldLine, side: 'LEFT' });
    } else {
      // Context line — exists on both sides; expose RIGHT (new file)
      oldLine++;
      newLine++;
      result.push({ line: newLine, side: 'RIGHT' });
    }
  }

  return result;
}
