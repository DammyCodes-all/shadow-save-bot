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
        synchronize: true,
        extra: {
          ssl: { rejectUnauthorized: false },
          connectionTimeoutMillis: 30000,
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
