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
    const platform = this.downloadService.detectPlatform(url);

    if (!platform) {
      await ctx.reply(
        this.botService.getUnsupportedLinkMessage(
          this.downloadService.getSupportedPlatforms(),
        ),
      );
      return;
    }

    const downloadingMessage = await ctx.reply('⏳ Downloading...');

    try {
      const mediaInfo = await this.downloadService.getMediaInfo(url);

      if (mediaInfo.images && mediaInfo.images.length > 0) {
        if (mediaInfo.images.length === 1) {
          await ctx.replyWithPhoto(
            mediaInfo.images[0],
            this.botService.getShareWithFriendsMarkup(),
          );
        } else {
          for (let index = 0; index < mediaInfo.images.length; index += 10) {
            const imageBatch = mediaInfo.images.slice(index, index + 10);

            if (imageBatch.length === 1) {
              await ctx.replyWithPhoto(imageBatch[0]);
            } else {
              await ctx.replyWithMediaGroup(
                imageBatch.map((imageUrl) => ({
                  type: 'photo',
                  media: imageUrl,
                })),
              );
            }
          }
        }

        await ctx.telegram.deleteMessage(
          downloadingMessage.chat.id,
          downloadingMessage.message_id,
        );
        return;
      }

      if (mediaInfo.videoUrl) {
        const videos = mediaInfo.videoUrls?.length
          ? mediaInfo.videoUrls
          : [mediaInfo.videoUrl];

        if (mediaInfo.platform === 'twitter' && videos.length > 1) {
          let sent = false;

          for (const videoUrl of videos) {
            try {
              await ctx.replyWithVideo(
                videoUrl,
                this.botService.getShareWithFriendsMarkup(),
              );
              sent = true;
              break;
            } catch {}
          }

          if (!sent) {
            throw new Error('Failed to send all available video variants');
          }
        } else if (videos.length > 1) {
          for (let index = 0; index < videos.length; index += 10) {
            const videoBatch = videos.slice(index, index + 10);

            await ctx.replyWithMediaGroup(
              videoBatch.map((videoUrl) => ({
                type: 'video',
                media: videoUrl,
              })),
            );
          }
        } else {
          await ctx.replyWithVideo(
            videos[0],
            this.botService.getShareWithFriendsMarkup(),
          );
        }

        await ctx.telegram.deleteMessage(
          downloadingMessage.chat.id,
          downloadingMessage.message_id,
        );
        return;
      }

      await ctx.reply(this.botService.getDownloadFailureMessage(platform));
      try {
        await ctx.telegram.deleteMessage(
          downloadingMessage.chat.id,
          downloadingMessage.message_id,
        );
      } catch {}
    } catch (error: unknown) {
      try {
        await ctx.telegram.deleteMessage(
          downloadingMessage.chat.id,
          downloadingMessage.message_id,
        );
      } catch {}

      if (this.isNotImplementedError(error)) {
        await ctx.reply(this.botService.getNotImplementedMessage(platform));
        return;
      }

      await ctx.reply(this.botService.getDownloadFailureMessage(platform));
    }
  }

  private isNotImplementedError(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
      return false;
    }

    if (!('getStatus' in error) || typeof error.getStatus !== 'function') {
      return false;
    }

    return error.getStatus() === 501;
  }
}
