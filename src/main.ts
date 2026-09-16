import { createServer, IncomingMessage, ServerResponse } from 'http';

// NOTE: this entry intentionally has NO static Nest/TypeORM imports.
// Static imports are hoisted and would force Node to load the whole
// dependency graph (~seconds) before we can bind PORT. The platform TCP
// check fails with "no TCP listeners" if nothing listens during that
// window, so we bind a placeholder with only node:http first and
// dynamic-import the heavy graph afterwards.
type HealthHandler = (
  req: unknown,
  res: { json: (body: { status: string }) => void },
) => void;

type HttpAdapterLike = {
  get: (path: string, handler: HealthHandler) => void;
};

type LoggerLike = { error: (msg: string) => void; log: (msg: string) => void };

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return String(error);
}

/** Short single-line cause for the degraded /health body (logs keep the stack). */
function toErrorDetail(error: unknown): string {
  if (error instanceof AggregateError) {
    const parts = error.errors
      .slice(0, 3)
      .map((e) =>
        e instanceof Error
          ? `${e.name}${e.message ? `: ${e.message}` : ''}`
          : String(e),
      );
    return `AggregateError: ${parts.join('; ')}`;
  }
  if (error instanceof Error) {
    return error.message || error.name;
  }
  return String(error);
}

async function bootstrap() {
  const port = Number(process.env.PORT ?? 3000) || 3000;

  process.on('unhandledRejection', (reason) => {
    console.error(`[Bootstrap] Unhandled rejection: ${toErrorMessage(reason)}`);
  });
  process.on('uncaughtException', (error) => {
    console.error(`[Bootstrap] Uncaught exception: ${toErrorMessage(error)}`);
  });

  // Bind PORT before any heavy imports or network I/O (DB, Telegram, ...).
  // The platform TCP check fails with "no TCP listeners" if nothing is
  // listening during module load / TypeORM retries / Neon cold starts, so
  // this placeholder must answer /health with 200 from the first milliseconds.
  const placeholder = startPlaceholderServer(port);

  let NestFactory: typeof import('@nestjs/core').NestFactory;
  let Logger: typeof import('@nestjs/common').Logger;
  let AppModule: typeof import('./app.module.js').AppModule;
  try {
    [{ NestFactory }, { Logger }, { AppModule }] = await Promise.all([
      import('@nestjs/core'),
      import('@nestjs/common'),
      import('./app.module.js'),
    ]);
  } catch (error) {
    console.error(
      `[Bootstrap] Failed to load application modules: ${toErrorMessage(error)}. ` +
        `Keeping placeholder server so the platform port check passes.`,
    );
    placeholder.setDegraded(toErrorDetail(error));
    return;
  }
  const logger = new Logger('Bootstrap');

  let app: import('@nestjs/common').INestApplication;
  try {
    // abortOnError:false is required so init failures (DB unreachable,
    // missing env vars) reject here instead of Nest calling process.exit(1),
    // which would bypass this handler and leave no port listening.
    app = await NestFactory.create(AppModule, { abortOnError: false });
  } catch (error) {
    logger.error(
      `Nest application failed to initialize: ${toErrorMessage(error)}. ` +
        `Keeping placeholder server so the platform port check passes; fix the error above.`,
    );
    placeholder.setDegraded(toErrorDetail(error));
    return;
  }

  try {
    const httpAdapter = app.getHttpAdapter() as unknown as HttpAdapterLike;
    httpAdapter.get('/health', (_req, res) => res.json({ status: 'ok' }));
    app.enableShutdownHooks();
    // Free the port before handing it to Nest; gap is a few ms.
    await placeholder.close();
    await app.listen(port, '0.0.0.0');
    console.log(
      `[boot] HTTP listening on 0.0.0.0:${port} (PORT env: ${process.env.PORT ?? '(unset)'})`,
    );
  } catch (error) {
    const message = toErrorMessage(error);
    try {
      logger.error(
        `Nest application failed to listen on port ${port}: ${message}`,
      );
    } catch {
      console.error(
        `[Bootstrap] Nest application failed to listen on port ${port}: ${message}`,
      );
    }
    placeholder.setDegraded(toErrorDetail(error));
  }
}

/**
 * Binds PORT immediately and answers /health with 200 so platform TCP +
 * HTTP checks pass while Nest/TypeORM are still starting. Call close()
 * before app.listen() to hand the port over, or setDegraded() to keep
 * serving liveness (200) with the real cause when Nest cannot start.
 * /ready returns 503 in degraded state for readiness gating.
 */
function startPlaceholderServer(port: number) {
  let degradedDetail: string | null = null;
  const log: LoggerLike = {
    error: (msg) => console.error(`[Bootstrap] ${msg}`),
    log: (msg) => console.log(`[Bootstrap] ${msg}`),
  };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = (req.url ?? '/').split('?')[0];
    if (url === '/health') {
      if (degradedDetail === null) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'starting' }));
      } else {
        // Liveness stays 200 so the proxy route activates; the cause is
        // in the body and logs, and /ready reports 503 for readiness.
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'degraded', error: degradedDetail }));
      }
      return;
    }
    if (url === '/ready') {
      if (degradedDetail === null) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'starting' }));
      } else {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'error', error: degradedDetail }));
      }
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'not-found' }));
  });
  server.on('error', (serverError) => {
    log.error(
      `Placeholder health server failed to bind port ${port}: ${serverError.message}`,
    );
    process.exitCode = 1;
  });
  server.listen(port, '0.0.0.0', () => {
    console.log(
      `[boot] Placeholder health server listening on 0.0.0.0:${port} (PORT env: ${process.env.PORT ?? '(unset)'})`,
    );
  });
  return {
    setDegraded(detail: string): void {
      degradedDetail = detail;
      log.error(
        `Serving degraded /health (200) with cause: ${detail}. See /ready for 503 readiness.`,
      );
    },
    close(): Promise<void> {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

void bootstrap();
