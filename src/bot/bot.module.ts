import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TelegrafModule } from 'nestjs-telegraf';
import { ConfigService } from '@nestjs/config';
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
  ],
  providers: [BotUpdate, BotService, BroadcastService],
})
export class BotModule {}
