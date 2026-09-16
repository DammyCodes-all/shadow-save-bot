import { INestApplication, Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { createServer, IncomingMessage, ServerResponse } from 'http';
import { AppModule } from './app.module';

type HealthHandler = (
  req: unknown,
  res: { json: (body: { status: string }) => void },
) => void;

type HttpAdapterLike = {
  get: (path: string, handler: HealthHandler) => void;
};

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return String(error);
}

/** Short single-line cause for the fallback /health body (logs keep the stack). */
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
  const logger = new Logger('Bootstrap');
  const port = Number(process.env.PORT ?? 3000) || 3000;

  process.on('unhandledRejection', (reason) => {
    logger.error(`Unhandled rejection: ${toErrorMessage(reason)}`);
  });
  process.on('uncaughtException', (error) => {
    logger.error(`Uncaught exception: ${toErrorMessage(error)}`);
  });

  let app: INestApplication;
  try {
    // abortOnError:false is required so init failures (DB unreachable,
    // missing env vars) reject here instead of Nest calling process.exit(1),
    // which would bypass this handler and leave no port listening.
    app = await NestFactory.create(AppModule, { abortOnError: false });
  } catch (error) {
    logger.error(
      `Nest application failed to initialize: ${toErrorMessage(error)}. ` +
        `Starting fallback health server so the platform port check passes; fix the error above.`,
    );
    startFallbackServer(port, logger, error);
    return;
  }

  try {
    const httpAdapter = app.getHttpAdapter() as unknown as HttpAdapterLike;
    httpAdapter.get('/health', (_req, res) => res.json({ status: 'ok' }));
    app.enableShutdownHooks();
    await app.listen(port, '0.0.0.0');
    console.log(
      `[boot] HTTP listening on 0.0.0.0:${port} (PORT env: ${process.env.PORT ?? '(unset)'})`,
    );
  } catch (error) {
    logger.error(
      `Nest application failed to listen on port ${port}: ${toErrorMessage(error)}`,
    );
    startFallbackServer(port, logger, error);
  }
}

/**
 * Binds PORT even when Nest cannot start (missing env vars, DB unreachable,
 * ...). The platform TCP check then passes and /health returns 503 with the
 * real cause instead of the cryptic "no TCP listeners" failure.
 */
function startFallbackServer(
  port: number,
  logger: Logger,
  error: unknown,
): void {
  const detail = toErrorDetail(error);
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const body = JSON.stringify({ status: 'error', error: detail });
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(body);
  });
  server.on('error', (serverError) => {
    logger.error(
      `Fallback health server failed to bind port ${port}: ${serverError.message}`,
    );
    process.exitCode = 1;
  });
  server.listen(port, '0.0.0.0', () => {
    console.log(
      `[boot] Fallback health server listening on 0.0.0.0:${port} (PORT env: ${process.env.PORT ?? '(unset)'})`,
    );
  });
}

void bootstrap();
