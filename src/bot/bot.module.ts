import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TelegrafModule } from 'nestjs-telegraf';
import { BullModule } from '@nestjs/bullmq';
import { BotUpdate } from './bot.update';
import { BotService } from './bot.service';
import { BroadcastService } from './broadcast.service';
import { DownloadModule } from '../download/download.module';
import { UserModule } from '../user/user.module';

@Module({
  imports: [
    ConfigModule,
    DownloadModule,
    UserModule,
    TelegrafModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        token: configService.getOrThrow<string>('TELEGRAM_BOT_API_KEY'),
      }),
    }),
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const redisUrl = configService.getOrThrow<string>('REDIS_URL');
        const url = new URL(redisUrl);
        return {
          connection: {
            host: url.hostname,
            port: Number(url.port) || 6379,
            username: url.username || undefined,
            password: url.password || undefined,
            tls: url.protocol === 'rediss:' ? {} : undefined,
            maxRetriesPerRequest: null,
          },
        };
      },
    }),
    BullModule.registerQueue({ name: 'broadcast' }),
  ],
  providers: [BotUpdate, BotService, BroadcastService],
})
export class BotModule {}
