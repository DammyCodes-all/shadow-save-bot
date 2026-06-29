import { Injectable, Logger } from '@nestjs/common';
import { Ctx, On, Start, Command, Update } from 'nestjs-telegraf';
import { Context } from 'telegraf';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { BotService } from './bot.service.js';
import { DownloadService } from '../download/download.service';
import { UserService } from '../user/user.service';

@Update()
@Injectable()
export class BotUpdate {
  private readonly logger = new Logger(BotUpdate.name);
  private readonly broadcastComposers = new Set<number>();

  constructor(
    private readonly botService: BotService,
    private readonly downloadService: DownloadService,
    private readonly userService: UserService,
    @InjectQueue('broadcast') private readonly broadcastQueue: Queue,
  ) {}

  @Start()
  async onStart(@Ctx() ctx: Context) {
    await ctx.reply(this.botService.getWelcomeMessage());
  }

  @Command('stats')
  async onStats(@Ctx() ctx: Context) {
    if (!ctx.from || !this.botService.isAdmin(ctx.from.id)) {
      return;
    }

    await ctx.reply('⏳ Calculating stats...');

    try {
      const stats = await this.userService.getStats();
      await ctx.reply(
        this.botService.getStatsMessage(
          stats.totalUsers,
          stats.downloadsToday,
          stats.perPlatform,
        ),
      );
    } catch (error: any) {
      this.logger.error(`Stats error: ${error.message}`);
      await ctx.reply('❌ Failed to fetch stats. Try again.');
    }
  }

  @Command('broadcast')
  async onBroadcast(@Ctx() ctx: Context) {
    if (!ctx.from || !this.botService.isAdmin(ctx.from.id)) {
      return;
    }

    this.broadcastComposers.add(ctx.from.id);
    await ctx.reply('Send the message you want to broadcast to all users:');
  }

  @On('text')
  async onText(@Ctx() ctx: Context) {
    const message = ctx.message;

    if (!message || !('text' in message) || !ctx.from) {
      return;
    }

    const text = message.text.trim();

    if (text.startsWith('/')) {
      return;
    }

    if (this.broadcastComposers.has(ctx.from.id)) {
      await this.sendBroadcast(ctx, text);
      return;
    }

    const url = text;
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

      const mediaType =
        mediaInfo.videoUrl ? 'video'
        : mediaInfo.images && mediaInfo.images.length > 0 ? 'image'
        : null;
      this.userService.recordUser(ctx.from).catch(() => {});
      this.userService.recordEvent({
        userTelegramId: ctx.from.id,
        platform: mediaInfo.platform,
        mediaType,
        url,
        success: true,
      }).catch(() => {});
      this.userService.incrementDownloadCount(ctx.from.id).catch(() => {});

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

  private async sendBroadcast(ctx: Context, text: string): Promise<void> {
    this.broadcastComposers.delete(ctx.from!.id);

    try {
      const userIds = await this.userService.getAllNonBannedUserIds();

      if (userIds.length === 0) {
        await ctx.reply('No users to broadcast to.');
        return;
      }

      const jobs = userIds.map((chatId) => ({
        name: `broadcast:${chatId}`,
        data: { chatId, text },
      }));

      await this.broadcastQueue.addBulk(jobs);
      this.logger.log(`Broadcast queued for ${userIds.length} users: "${text.substring(0, 50)}..."`);
      await ctx.reply(`📢 Broadcast queued for ${userIds.length} users.`);
    } catch (error: any) {
      this.logger.error(`Broadcast error: ${error.message}`);
      await ctx.reply('❌ Failed to prepare broadcast. Try again.');
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
