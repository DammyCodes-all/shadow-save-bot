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

    const downloadingMessage = await ctx.reply('⏳ Downloading...');

    try {
      const mediaInfo = await this.downloadService.getMediaInfo(url);

      if (
        mediaInfo.isSlideshow &&
        mediaInfo.images &&
        mediaInfo.images.length > 0
      ) {
        for (let index = 0; index < mediaInfo.images.length; index += 10) {
          const imageBatch = mediaInfo.images.slice(index, index + 10);

          await ctx.replyWithMediaGroup(
            imageBatch.map((imageUrl) => ({
              type: 'photo',
              media: imageUrl,
            })),
          );
        }

        await ctx.telegram.deleteMessage(
          downloadingMessage.chat.id,
          downloadingMessage.message_id,
        );
        return;
      }

      if (mediaInfo.videoUrl) {
        await ctx.replyWithVideo(mediaInfo.videoUrl);
        await ctx.telegram.deleteMessage(
          downloadingMessage.chat.id,
          downloadingMessage.message_id,
        );
        return;
      }

      await ctx.reply(
        "❌ Failed to download. Make sure it's a valid public TikTok link.",
      );
      try {
        await ctx.telegram.deleteMessage(
          downloadingMessage.chat.id,
          downloadingMessage.message_id,
        );
      } catch {}
    } catch {
      try {
        await ctx.telegram.deleteMessage(
          downloadingMessage.chat.id,
          downloadingMessage.message_id,
        );
      } catch {}

      await ctx.reply(
        "❌ Failed to download. Make sure it's a valid public TikTok link.",
      );
    }
  }
}
