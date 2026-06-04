import 'dotenv/config';
import Fastify from 'fastify';
import { App } from '@octokit/app';
import { config } from './config';
import { registerWebhookHandlers } from './webhook';

const githubApp = new App({
  appId: config.GITHUB_APP_ID,
  privateKey: config.GITHUB_PRIVATE_KEY,
  webhooks: {
    secret: config.GITHUB_WEBHOOK_SECRET,
  },
});

registerWebhookHandlers(githubApp);

const server = Fastify({ logger: true });

// Capture raw body string so @octokit/webhooks can verify HMAC signature
server.addContentTypeParser(
  'application/json',
  { parseAs: 'string' },
  (_req, body, done) => done(null, body),
);

server.post('/webhook', async (request, reply) => {
  const id        = request.headers['x-github-delivery']    as string | undefined;
  const name      = request.headers['x-github-event']       as string | undefined;
  const signature = request.headers['x-hub-signature-256']  as string | undefined;
  const payload   = request.body as string | undefined;

  // Respond immediately — GitHub has a 10-second webhook timeout
  void reply.code(200).send({ ok: true });

  if (!id || !name || !signature || !payload) return;

  server.log.info({ event: name, delivery: id }, 'Webhook received');

  // Process in the background queue (registered in webhook.ts)
  void githubApp.webhooks
    .verifyAndReceive({ id, name: name as Parameters<typeof githubApp.webhooks.verifyAndReceive>[0]['name'], signature, payload })
    .catch((err: unknown) => server.log.error({ err }, 'Webhook processing error'));
});

server.get('/health', async () => ({
  status: 'ok',
  timestamp: new Date().toISOString(),
}));

server.listen({ port: config.PORT, host: '0.0.0.0' }, (err) => {
  if (err) {
    server.log.error(err);
    process.exit(1);
  }
});
