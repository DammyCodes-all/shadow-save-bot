import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TelegrafModule } from 'nestjs-telegraf';
import { BotUpdate } from './bot.update';
import { BotService } from './bot.service';

@Module({
  imports: [
    ConfigModule,
    TelegrafModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        token: configService.getOrThrow<string>('TELEGRAM_BOT_API_KEY'),
      }),
    }),
  ],
  providers: [BotUpdate, BotService],
})
export class BotModule {}
