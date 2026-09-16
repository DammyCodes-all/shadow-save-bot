import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { BotModule } from './bot/bot.module';
import { DownloadModule } from './download/download.module';
import { UserModule } from './user/user.module';
import { validateEnvironment } from './config/env.validation';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnvironment,
    }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        type: 'postgres',
        url: configService.getOrThrow<string>('DATABASE_URL'),
        autoLoadEntities: true,
        // Never auto-sync schema in production: it needs extra DB round
        // trips on boot (slower cold start) and can alter data. Use
        // migrations for prod; keep sync for local dev only.
        synchronize: process.env.NODE_ENV !== 'production',
        extra: {
          ssl: { rejectUnauthorized: false },
          // Fail fast so a dead Neon endpoint rejects instead of holding
          // NestFactory.create (and the port handover) for 30s+. The
          // placeholder /health keeps answering while this retries.
          connectionTimeoutMillis: 10000,
          idleTimeoutMillis: 60000,
          keepAlive: true,
          keepAliveInitialDelayMillis: 10000,
          max: 3,
        },
        maxQueryExecutionTime: 10000,
        retryDelay: 3000,
        retryAttempts: 3,
      }),
    }),
    UserModule,
    BotModule,
    DownloadModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
