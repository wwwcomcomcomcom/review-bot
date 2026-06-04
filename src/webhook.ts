import PQueue from 'p-queue';
import type { App } from '@octokit/app';
import { config } from './config';
import { runPipeline } from './review/pipeline';

const queue = new PQueue({ concurrency: config.QUEUE_CONCURRENCY });

export function registerWebhookHandlers(app: App): void {
  // Full review on PR open/reopen
  const onPR = ({ octokit, payload }: { octokit: any; payload: any }) => {
    const owner = payload.repository.owner.login as string;
    const repo = payload.repository.name as string;
    const pr = payload.pull_request;
    const action = payload.action as string;

    console.info(
      `[webhook] pull_request.${action} ${owner}/${repo}#${pr.number as number} — "${pr.title as string}"`,
    );

    void queue.add(() =>
      runPipeline(
        octokit,
        owner,
        repo,
        pr.number as number,
        pr.title as string,
        (pr.body as string | null) ?? '',
      ).catch((err: unknown) =>
        console.error(`[queue] Pipeline error ${owner}/${repo}#${pr.number as number}:`, err),
      ),
    );
  };

  app.webhooks.on('pull_request.opened', onPR as any);
  app.webhooks.on('pull_request.reopened', onPR as any);

  // Manual /review command via issue comment on a PR
  app.webhooks.on(
    'issue_comment.created',
    ({ octokit, payload }: { octokit: any; payload: any }) => {
      if (!payload.issue.pull_request) return; // not a PR comment
      if ((payload.comment.body as string).trim() !== '/review') return;

      const owner = payload.repository.owner.login as string;
      const repo = payload.repository.name as string;
      const prNum = payload.issue.number as number;

      console.info(`[webhook] issue_comment /review ${owner}/${repo}#${prNum}`);

      void queue.add(async () => {
        try {
          const { data: pr } = await octokit.rest.pulls.get({ owner, repo, pull_number: prNum });
          await runPipeline(
            octokit,
            owner,
            repo,
            prNum,
            pr.title as string,
            (pr.body as string | null) ?? '',
          );
        } catch (err: unknown) {
          console.error(`[queue] Pipeline error ${owner}/${repo}#${prNum} (/review):`, err);
        }
      });
    },
  );
}
