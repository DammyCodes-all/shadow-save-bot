import { Injectable, Logger } from '@nestjs/common';
import { Action, Ctx, On, Start, Command, Update } from 'nestjs-telegraf';
import { Context } from 'telegraf';
import { BotService } from './bot.service.js';
import { BroadcastService } from './broadcast.service';
import { DownloadService } from '../download/download.service';
import { UserService } from '../user/user.service';

@Update()
@Injectable()
export class BotUpdate {
  private readonly logger = new Logger(BotUpdate.name);
  private readonly broadcastComposers = new Set<number>();
  private readonly audioRequests = new Map<
    string,
    { music: string; title: string }
  >();

  constructor(
    private readonly botService: BotService,
    private readonly downloadService: DownloadService,
    private readonly userService: UserService,
    private readonly broadcastService: BroadcastService,
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
      await ctx.reply(this.botService.getStatsMessage(stats));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      this.logger.error(`Stats error: ${message}`);
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

  @Command('exit')
  async onExit(@Ctx() ctx: Context) {
    if (!ctx.from || !this.botService.isAdmin(ctx.from.id)) {
      return;
    }

    if (this.broadcastComposers.delete(ctx.from.id)) {
      await ctx.reply('Broadcast cancelled. You are back to normal mode.');
    } else {
      await ctx.reply('No active broadcast to cancel.');
    }
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

    let refreshed = false;

    while (true) {
      try {
        const mediaInfo = await this.downloadService.getMediaInfo(url);

        const mediaType =
          mediaInfo.images && mediaInfo.images.length > 0
            ? 'image'
            : mediaInfo.videoUrl
              ? 'video'
              : null;
        this.userService.recordUser(ctx.from).catch(() => {});

        if (mediaInfo.images && mediaInfo.images.length > 0) {
          const tiktokAudioCallback =
            mediaInfo.platform === 'tiktok' && mediaInfo.music
              ? this.createAudioCallback(mediaInfo.music, mediaInfo.title)
              : null;

          try {
            if (mediaInfo.images.length === 1) {
              const markup = tiktokAudioCallback
                ? this.botService.getMediaReplyMarkup(tiktokAudioCallback)
                : this.botService.getShareWithFriendsMarkup();
              await ctx.replyWithPhoto(mediaInfo.images[0], markup as never);
            } else {
              for (
                let index = 0;
                index < mediaInfo.images.length;
                index += 10
              ) {
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

              if (tiktokAudioCallback) {
                await ctx.reply(
                  '🎵 Audio for this slideshow',
                  this.botService.getAudioButtonMarkup(
                    tiktokAudioCallback,
                  ) as never,
                );
              }
            }
          } catch (error) {
            if (this.isFileTooLargeError(error)) {
              await ctx.reply(
                this.botService.getFileTooLargeMessage(mediaInfo.platform),
              );
              await ctx.telegram
                .deleteMessage(
                  downloadingMessage.chat.id,
                  downloadingMessage.message_id,
                )
                .catch(() => {});

              this.userService
                .recordEvent({
                  userTelegramId: ctx.from.id,
                  platform: mediaInfo.platform,
                  mediaType,
                  url,
                  success: false,
                })
                .catch(() => {});

              return;
            }
            throw error;
          }

          this.userService
            .recordEvent({
              userTelegramId: ctx.from.id,
              platform: mediaInfo.platform,
              mediaType,
              url,
              success: true,
            })
            .catch(() => {});
          this.userService.incrementDownloadCount(ctx.from.id).catch(() => {});

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

          const tiktokAudioCallback =
            mediaInfo.platform === 'tiktok' && mediaInfo.music
              ? this.createAudioCallback(mediaInfo.music, mediaInfo.title)
              : null;
          const videoMarkup = tiktokAudioCallback
            ? this.botService.getMediaReplyMarkup(tiktokAudioCallback)
            : this.botService.getShareWithFriendsMarkup();

          try {
            if (mediaInfo.platform === 'twitter' && videos.length > 1) {
              let sent = false;
              let lastError: unknown;

              for (const videoUrl of videos) {
                try {
                  await ctx.replyWithVideo(videoUrl, videoMarkup as never);
                  sent = true;
                  break;
                } catch (error) {
                  if (this.isFileTooLargeError(error)) {
                    lastError = error;
                    continue;
                  }
                  lastError = error;
                }
              }

              if (!sent) {
                if (this.isFileTooLargeError(lastError)) {
                  throw Object.assign(new Error('FILE_TOO_LARGE'), {
                    cause: lastError,
                  });
                }
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

              if (tiktokAudioCallback) {
                await ctx.reply(
                  '🎵 Audio for this video',
                  this.botService.getAudioButtonMarkup(
                    tiktokAudioCallback,
                  ) as never,
                );
              }
            } else {
              await ctx.replyWithVideo(videos[0], videoMarkup as never);
            }
          } catch (error) {
            if (this.isFileTooLargeError(error)) {
              await ctx.reply(
                this.botService.getFileTooLargeMessage(mediaInfo.platform),
              );
              await ctx.telegram
                .deleteMessage(
                  downloadingMessage.chat.id,
                  downloadingMessage.message_id,
                )
                .catch(() => {});

              this.userService
                .recordEvent({
                  userTelegramId: ctx.from.id,
                  platform: mediaInfo.platform,
                  mediaType,
                  url,
                  success: false,
                })
                .catch(() => {});

              return;
            }
            throw error;
          }

          this.userService
            .recordEvent({
              userTelegramId: ctx.from.id,
              platform: mediaInfo.platform,
              mediaType,
              url,
              success: true,
            })
            .catch(() => {});
          this.userService.incrementDownloadCount(ctx.from.id).catch(() => {});

          await ctx.telegram.deleteMessage(
            downloadingMessage.chat.id,
            downloadingMessage.message_id,
          );
          return;
        }

        this.userService
          .recordEvent({
            userTelegramId: ctx.from.id,
            platform,
            mediaType: null,
            url,
            success: false,
          })
          .catch(() => {});

        await ctx.reply(this.botService.getDownloadFailureMessage(platform));
        try {
          await ctx.telegram.deleteMessage(
            downloadingMessage.chat.id,
            downloadingMessage.message_id,
          );
        } catch {}

        return;
      } catch (error: unknown) {
        if (!refreshed && this.isTelegramFetchError(error)) {
          refreshed = true;
          this.logger.warn(
            `Telegram could not fetch media for ${url}, evicting cache and re-extracting once`,
          );

          try {
            await this.downloadService.refreshMediaInfo(url);
          } catch {
            // ignore here; the retry below surfaces the real error
          }

          continue;
        }

        const errorMessage =
          error instanceof Error ? error.message : 'unknown error';
        this.logger.error(
          `Download failed for ${url} (platform: ${platform}): ${errorMessage}`,
        );

        this.userService
          .recordEvent({
            userTelegramId: ctx.from.id,
            platform,
            mediaType: null,
            url,
            success: false,
          })
          .catch(() => {});

        try {
          await ctx.telegram.deleteMessage(
            downloadingMessage.chat.id,
            downloadingMessage.message_id,
          );
        } catch {}

        if (this.isFileTooLargeError(error)) {
          await ctx
            .reply(this.botService.getFileTooLargeMessage(platform))
            .catch(() => {});
          return;
        }

        if (this.isNotImplementedError(error)) {
          await ctx.reply(this.botService.getNotImplementedMessage(platform));
          return;
        }

        await ctx.reply(this.botService.getDownloadFailureMessage(platform));
        return;
      }
    }
  }

  private isTelegramFetchError(error: unknown): boolean {
    const message =
      error instanceof Error
        ? error.message
        : typeof error === 'string'
          ? error
          : error &&
              typeof error === 'object' &&
              typeof (error as Record<string, unknown>).description === 'string'
            ? ((error as Record<string, unknown>).description as string)
            : String(error ?? '');

    return message.toLowerCase().includes('failed to get http url content');
  }

  private async sendBroadcast(ctx: Context, text: string): Promise<void> {
    this.broadcastComposers.delete(ctx.from!.id);

    try {
      const userIds = await this.userService.getAllNonBannedUserIds();

      if (userIds.length === 0) {
        await ctx.reply('No users to broadcast to.');
        return;
      }

      this.broadcastService.sendAll(userIds, text);
      this.logger.log(
        `Broadcast started for ${userIds.length} users: "${text.substring(0, 50)}..."`,
      );
      await ctx.reply(
        `📢 Broadcasting to ${userIds.length} users. This may take a moment.`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      this.logger.error(`Broadcast error: ${message}`);
      await ctx.reply('❌ Failed to prepare broadcast. Try again.');
    }
  }

  @Action(/^audio:(.+)$/)
  async onAudioAction(@Ctx() ctx: Context) {
    const callbackQuery = ctx.callbackQuery as unknown as
      | { data?: string }
      | undefined;
    const data = callbackQuery?.data ?? '';
    const match = /^audio:(.+)$/.exec(data);
    const requestId = match?.[1];

    if (!requestId) {
      await ctx.answerCbQuery('Invalid audio request').catch(() => {});
      return;
    }

    const entry = this.audioRequests.get(requestId);

    if (!entry) {
      await ctx
        .answerCbQuery('Audio expired — please resend the link')
        .catch(() => {});
      return;
    }

    try {
      await ctx.answerCbQuery('Sending audio...').catch(() => {});

      await ctx.replyWithAudio(entry.music, {
        title: entry.title || undefined,
      } as unknown as Parameters<Context['replyWithAudio']>[1]);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      this.logger.error(`Audio send failed for ${requestId}: ${message}`);

      if (this.isFileTooLargeError(error)) {
        await ctx.answerCbQuery('Audio too large for Telegram').catch(() => {});
        await ctx
          .reply(this.botService.getAudioFileTooLargeMessage('tiktok'))
          .catch(() => {});
        return;
      }

      await ctx.answerCbQuery('Failed to send audio').catch(() => {});
      await ctx
        .reply('❌ Failed to send audio. The track may be unavailable.')
        .catch(() => {});
    }
  }

  private createAudioCallback(music: string, title: string): string {
    const id = Math.random().toString(36).slice(2, 10);
    this.audioRequests.set(id, { music, title });

    const timer = setTimeout(
      () => {
        this.audioRequests.delete(id);
      },
      2 * 60 * 60 * 1000,
    );

    if (
      typeof (timer as unknown as { unref?: () => void }).unref === 'function'
    ) {
      (timer as unknown as { unref: () => void }).unref();
    }

    return `audio:${id}`;
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

  private isFileTooLargeError(error: unknown): boolean {
    const extractMessage = (err: unknown): string => {
      if (err instanceof Error) {
        const causeMsg =
          err.cause instanceof Error ? ` ${err.cause.message}` : '';
        return `${err.message}${causeMsg}`;
      }
      if (typeof err === 'string') {
        return err;
      }
      if (err && typeof err === 'object') {
        const maybe = err as Record<string, unknown>;
        const desc =
          (maybe.description as string | undefined) ??
          (maybe.response as Record<string, unknown> | undefined)?.description;
        if (typeof desc === 'string') {
          return desc;
        }
        const nested = maybe.response as Record<string, unknown> | undefined;
        const nestedDesc = nested?.data as Record<string, unknown> | undefined;
        if (typeof nestedDesc?.description === 'string') {
          return nestedDesc.description as string;
        }
      }
      return String(err ?? '');
    };

    const raw = extractMessage(error).toLowerCase();
    return (
      raw.includes('file is too large') ||
      raw.includes('file_too_large') ||
      raw.includes('too large') ||
      raw.includes('request entity too large') ||
      raw.includes('payload too large') ||
      raw.includes('413')
    );
  }
}
