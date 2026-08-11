import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const httpAdapter = app.getHttpAdapter();
  httpAdapter.get('/health', (_req, res) => res.json({ status: 'ok' }));
  await app.listen(process.env.PORT ?? 3000, '0.0.0.0');
  console.log(
    `[boot] HTTP listening on 0.0.0.0:${process.env.PORT ?? 3000} (PORT env: ${process.env.PORT ?? '(unset)'})`,
  );
}
bootstrap();
