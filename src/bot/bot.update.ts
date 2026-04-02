import { Injectable } from '@nestjs/common';
import { Ctx, On, Start, Update } from 'nestjs-telegraf';
import { Context } from 'telegraf';
import { BotService } from './bot.service.js';
import { DownloadService } from '../download/download.service';

@Update()
@Injectable()
export class BotUpdate {
  constructor(
    private readonly botService: BotService,
    private readonly downloadService: DownloadService,
  ) {}

  @Start()
  async onStart(@Ctx() ctx: Context) {
    await ctx.reply(this.botService.getWelcomeMessage());
  }

  @On('text')
  async onText(@Ctx() ctx: Context) {
    const message = ctx.message;

    if (!message || !('text' in message)) {
      return;
    }

    const url = message.text.trim();

    if (!this.botService.isTikTokUrl(url)) {
      await ctx.reply(this.botService.getUnsupportedLinkMessage());
      return;
    }

    const downloadingMessage = await ctx.reply(
      this.botService.getDownloadQueuedMessage(url),
    );

    try {
      const stream = this.downloadService.getVideoStream(url);
      await ctx.replyWithVideo({ source: stream });

      await ctx.telegram.deleteMessage(
        downloadingMessage.chat.id,
        downloadingMessage.message_id,
      );
    } catch {
      try {
        await ctx.telegram.deleteMessage(
          downloadingMessage.chat.id,
          downloadingMessage.message_id,
        );
      } catch {}

      await ctx.reply(
        'Sorry, I could not download this video right now. Please try again or use another TikTok link in a moment.',
      );
    }
  }
}
