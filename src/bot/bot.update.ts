import { randomBytes } from 'crypto';
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Action, Ctx, On, Start, Command, Update } from 'nestjs-telegraf';
import { Context } from 'telegraf';
import { BotService } from './bot.service';
import { BroadcastService } from './broadcast.service';
import { DownloadService } from '../download/download.service';
import type { MediaInfo } from '../download/download.types';
import type { SocialPlatform } from '../download/providers/social-media-provider.interface';
import { UserService } from '../user/user.service';
import { ReportNotifierService } from '../report/report-notifier.service';
import { ReportPresenter } from '../report/report.presenter';
import { ReportRateLimitError, ReportService } from '../report/report.service';
import type { ErrorReportCode } from '../report/report.service';
import { VideoRenderService } from '../video/video-render.service';
import { VideoRequestStore } from '../video/video-request.store';
import { VideoExportError } from '../video/video.types';
import type {
  RenderResult,
  VideoPlatform,
  VideoRequest,
} from '../video/video.types';

type ReportContext = {
  userId: number;
  url: string | null;
  platform: SocialPlatform | null;
  errorCode: ErrorReportCode;
  errorDetail: string | null;
  createdAt: number;
};

type ReportDraft = {
  contextToken: string | null;
  createdAt: number;
};

@Update()
@Injectable()
export class BotUpdate implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BotUpdate.name);
  private readonly broadcastComposers = new Set<number>();
  private readonly audioRequests = new Map<
    string,
    { music: string; title: string }
  >();
  private readonly reportContexts = new Map<string, ReportContext>();
  private readonly reportDrafts = new Map<number, ReportDraft>();
  private draftSweepTimer?: NodeJS.Timeout;

  private static readonly REPORT_CONTEXT_TTL_MS = 30 * 60 * 1000;
  private static readonly REPORT_DRAFT_TTL_MS = 30 * 60 * 1000;
  private static readonly REPORT_DRAFT_SWEEP_MS = 60 * 1000;
  private static readonly MAX_REPORT_CONTEXTS = 500;

  constructor(
    private readonly botService: BotService,
    private readonly downloadService: DownloadService,
    private readonly userService: UserService,
    private readonly broadcastService: BroadcastService,
    private readonly reportService: ReportService,
    private readonly reportNotifier: ReportNotifierService,
    private readonly reportPresenter: ReportPresenter,
    private readonly videoRenderService: VideoRenderService,
    private readonly videoRequestStore: VideoRequestStore,
  ) {}

  onModuleInit(): void {
    this.draftSweepTimer = setInterval(() => {
      this.pruneExpiredReportDrafts();
    }, BotUpdate.REPORT_DRAFT_SWEEP_MS);

    if (
      typeof (this.draftSweepTimer as unknown as { unref?: () => void })
        .unref === 'function'
    ) {
      (this.draftSweepTimer as unknown as { unref: () => void }).unref();
    }
  }

  onModuleDestroy(): void {
    if (this.draftSweepTimer) {
      clearInterval(this.draftSweepTimer);
      this.draftSweepTimer = undefined;
    }
  }

  @Start()
  async onStart(@Ctx() ctx: Context) {
    if (ctx.from && !this.botService.isAdmin(ctx.from.id)) {
      try {
        if (await this.userService.isBanned(ctx.from.id)) {
          await ctx.reply(this.botService.getBannedMessage());
          return;
        }
      } catch (error) {
        this.logger.warn(
          `Ban check failed on /start for ${ctx.from.id}: ${error instanceof Error ? error.message : 'unknown error'}`,
        );
      }
    }

    if (ctx.from) {
      this.clearReportState(ctx.from.id);
    }

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

  @Command('ban')
  async onBan(@Ctx() ctx: Context) {
    if (!ctx.from || !this.botService.isAdmin(ctx.from.id)) {
      return;
    }

    const target = this.parseBanTarget(ctx);
    if (target === null) {
      await ctx.reply('Usage: /ban @username or <telegram_user_id>');
      return;
    }

    try {
      if (target.kind === 'username') {
        const user = await this.userService.banUserByUsername(target.username);
        if (!user) {
          await ctx.reply(`User @${target.username} not found.`);
          return;
        }
        await ctx.reply(
          `🚫 @${user.username ?? target.username} has been banned.`,
        );
      } else {
        const user = await this.userService.banUser(target.telegramId);
        if (!user) {
          await ctx.reply(`User ${target.telegramId} not found.`);
          return;
        }
        const label = user.username
          ? `@${user.username}`
          : `${target.telegramId}`;
        await ctx.reply(`🚫 ${label} has been banned.`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      this.logger.error(`Ban failed for ${JSON.stringify(target)}: ${message}`);
      await ctx.reply('❌ Failed to ban user. Try again.');
    }
  }

  @Command('unban')
  async onUnban(@Ctx() ctx: Context) {
    if (!ctx.from || !this.botService.isAdmin(ctx.from.id)) {
      return;
    }

    const target = this.parseBanTarget(ctx);
    if (target === null) {
      await ctx.reply('Usage: /unban @username or <telegram_user_id>');
      return;
    }

    try {
      if (target.kind === 'username') {
        const user = await this.userService.unbanUserByUsername(
          target.username,
        );
        if (!user) {
          await ctx.reply(`User @${target.username} not found.`);
          return;
        }
        await ctx.reply(
          `✅ @${user.username ?? target.username} has been unbanned.`,
        );
      } else {
        const user = await this.userService.unbanUser(target.telegramId);
        if (!user) {
          await ctx.reply(`User ${target.telegramId} not found.`);
          return;
        }
        const label = user.username
          ? `@${user.username}`
          : `${target.telegramId}`;
        await ctx.reply(`✅ ${label} has been unbanned.`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      this.logger.error(
        `Unban failed for ${JSON.stringify(target)}: ${message}`,
      );
      await ctx.reply('❌ Failed to unban user. Try again.');
    }
  }

  @Command('report')
  async onReport(@Ctx() ctx: Context) {
    if (!ctx.from) {
      return;
    }

    if (this.broadcastComposers.has(ctx.from.id)) {
      await ctx.reply('You are composing a broadcast. Send /exit first.');
      return;
    }

    if (await this.rejectIfBanned(ctx)) {
      return;
    }

    const existingDraft = this.getActiveReportDraft(ctx.from.id);
    if (existingDraft) {
      if (
        existingDraft.contextToken &&
        !this.reportContexts.get(existingDraft.contextToken)
      ) {
        this.reportDrafts.delete(ctx.from.id);
      } else {
        if (existingDraft.contextToken) {
          await ctx.reply(
            this.botService.getReportContextPromptMessage(),
            this.botService.getReportSkipMarkup(
              existingDraft.contextToken,
            ) as never,
          );
        } else {
          await ctx.reply(this.botService.getReportPromptMessage());
        }
        return;
      }
    }

    this.reportDrafts.set(ctx.from.id, {
      contextToken: null,
      createdAt: Date.now(),
    });

    await ctx.reply(this.botService.getReportPromptMessage());
  }

  @Command('reports')
  async onReports(@Ctx() ctx: Context) {
    if (!ctx.from || !this.botService.isAdmin(ctx.from.id)) {
      return;
    }

    const text =
      ctx.message && 'text' in ctx.message ? ctx.message.text.trim() : '';
    const arg = text.split(/\s+/)[1]?.trim();
    const wantsAll = arg?.toLowerCase() === 'all';

    try {
      if (arg && !wantsAll) {
        const report = await this.reportService.findByShortId(arg);
        if (!report) {
          await ctx.reply(this.botService.getReportNotFoundMessage());
          return;
        }

        const extra =
          report.status === 'open'
            ? {
                parse_mode: 'HTML',
                link_preview_options: { is_disabled: true },
                reply_markup: {
                  inline_keyboard: [
                    [
                      {
                        text: '✅ Mark resolved',
                        callback_data: `report:resolve:${report.shortId}`,
                      },
                    ],
                  ],
                },
              }
            : {
                parse_mode: 'HTML',
                link_preview_options: { is_disabled: true },
              };

        await ctx.reply(
          this.reportPresenter.formatReportDetail(report),
          extra as never,
        );
        return;
      }

      const reports = wantsAll
        ? await this.reportService.listAll(10)
        : await this.reportService.listOpen(10);

      if (reports.length === 0) {
        await ctx.reply(this.botService.getReportsEmptyMessage());
        return;
      }

      await ctx.reply(
        this.reportPresenter.formatReportList(reports, wantsAll),
        {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
        } as never,
      );
    } catch (error) {
      this.logger.error(`Reports command failed: ${this.describeError(error)}`);
      await ctx.reply('❌ Failed to load reports. Try again.');
    }
  }

  @Command('resolve')
  async onResolve(@Ctx() ctx: Context) {
    if (!ctx.from || !this.botService.isAdmin(ctx.from.id)) {
      return;
    }

    const text =
      ctx.message && 'text' in ctx.message ? ctx.message.text.trim() : '';
    const shortId = text.split(/\s+/)[1]?.trim();

    if (!shortId) {
      await ctx.reply('Usage: /resolve <report_id>');
      return;
    }

    try {
      const result = await this.reportService.resolve(shortId, {
        id: ctx.from.id,
        name: this.getAdminName(ctx),
      });

      if (!result) {
        await ctx.reply(this.botService.getReportNotFoundMessage());
        return;
      }

      if (result.alreadyResolved) {
        await ctx.reply(
          this.botService.getReportAlreadyResolvedMessage(
            result.report.shortId,
            result.report.resolvedByName,
          ),
        );
        return;
      }

      await ctx.reply(
        this.botService.getReportResolvedMessage(result.report.shortId),
      );
    } catch (error) {
      this.logger.error(`Resolve command failed: ${this.describeError(error)}`);
      await ctx.reply('❌ Failed to resolve report. Try again.');
    }
  }

  @Command('cancel')
  async onCancel(@Ctx() ctx: Context) {
    if (!ctx.from) {
      return;
    }

    const hadReport = this.clearReportState(ctx.from.id);

    if (hadReport) {
      await ctx.reply(this.botService.getReportCancelledMessage());
      return;
    }

    await ctx.reply(this.botService.getReportNothingToCancelMessage());
  }

  @Command('skip')
  async onSkip(@Ctx() ctx: Context) {
    if (!ctx.from) {
      return;
    }

    if (await this.rejectIfBanned(ctx)) {
      return;
    }

    const draft = this.getActiveReportDraft(ctx.from.id);
    if (!draft) {
      await ctx.reply(this.botService.getReportNothingToSkipMessage());
      return;
    }

    if (!draft.contextToken) {
      await ctx.reply(this.botService.getReportSkipNeedsDescriptionMessage());
      return;
    }

    const context = this.reportContexts.get(draft.contextToken);
    if (!context) {
      this.reportDrafts.delete(ctx.from.id);
      await ctx.reply(this.botService.getReportExpiredMessage());
      return;
    }

    await this.submitReportFromDraft(ctx, '');
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

    if (!this.botService.isAdmin(ctx.from.id)) {
      try {
        if (await this.userService.isBanned(ctx.from.id)) {
          await ctx.reply(this.botService.getBannedMessage());
          return;
        }
      } catch (error) {
        this.logger.warn(
          `Ban check failed for ${ctx.from.id}: ${error instanceof Error ? error.message : 'unknown error'}`,
        );
      }
    }

    if (this.broadcastComposers.has(ctx.from.id)) {
      await this.sendBroadcast(ctx, text);
      return;
    }

    if (this.getActiveReportDraft(ctx.from.id)) {
      await this.submitReportFromDraft(ctx, text);
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

              // A single TikTok image with music can still become a video:
              // a still held over the full sound.
              const singleVideoToken =
                mediaInfo.platform === 'tiktok' &&
                mediaInfo.music &&
                this.videoRenderService.isAvailable()
                  ? this.videoRequestStore.create({
                      userId: ctx.from.id,
                      platform: 'tiktok',
                      url,
                      images: mediaInfo.images,
                      music: mediaInfo.music || null,
                      musicDurationSec: mediaInfo.musicDurationSec ?? null,
                      musicTitle: mediaInfo.musicTitle ?? null,
                      title: mediaInfo.title,
                      author: mediaInfo.author,
                    })
                  : null;
              if (singleVideoToken) {
                await ctx
                  .reply(
                    this.botService.getSlideshowActionsMessage('tiktok', true),
                    this.botService.getSlideshowActionsMarkup(
                      singleVideoToken,
                      null,
                    ) as never,
                  )
                  .catch((error) =>
                    this.logger.warn(
                      `Slideshow control message failed: ${error instanceof Error ? error.message : 'unknown error'}`,
                    ),
                  );
              }
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

              const videoToken =
                mediaInfo.images.length >= 2 &&
                this.isVideoPlatform(mediaInfo.platform) &&
                this.videoRenderService.isAvailable()
                  ? this.videoRequestStore.create({
                      userId: ctx.from.id,
                      platform: mediaInfo.platform,
                      url,
                      images: mediaInfo.images,
                      music: mediaInfo.music || null,
                      musicDurationSec: mediaInfo.musicDurationSec ?? null,
                      musicTitle: mediaInfo.musicTitle ?? null,
                      title: mediaInfo.title,
                      author: mediaInfo.author,
                    })
                  : null;
              if (
                (videoToken || tiktokAudioCallback) &&
                this.isVideoPlatform(mediaInfo.platform)
              ) {
                await ctx
                  .reply(
                    this.botService.getSlideshowActionsMessage(
                      mediaInfo.platform,
                      Boolean(mediaInfo.music),
                    ),
                    this.botService.getSlideshowActionsMarkup(
                      videoToken,
                      tiktokAudioCallback,
                    ) as never,
                  )
                  .catch((error) =>
                    this.logger.warn(
                      `Slideshow control message failed: ${error instanceof Error ? error.message : 'unknown error'}`,
                    ),
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

        const reportToken = this.createReportContext({
          userId: ctx.from.id,
          url,
          platform,
          errorCode: 'NO_MEDIA',
          errorDetail: 'Provider returned no playable media',
        });

        await ctx.reply(
          this.botService.getDownloadFailureMessage(platform),
          this.botService.getReportButtonMarkup(reportToken) as never,
        );
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

        const reportToken = this.createReportContext({
          userId: ctx.from.id,
          url,
          platform,
          errorCode: this.isTelegramFetchError(error)
            ? 'TELEGRAM_FETCH_FAILED'
            : 'DOWNLOAD_FAILED',
          errorDetail:
            error instanceof Error
              ? error.message
              : typeof error === 'string'
                ? error
                : 'Unknown error',
        });

        await ctx.reply(
          this.botService.getDownloadFailureMessage(platform),
          this.botService.getReportButtonMarkup(reportToken) as never,
        );
        return;
      }
    }
  }

  private async rejectIfBanned(ctx: Context): Promise<boolean> {
    if (!ctx.from || this.botService.isAdmin(ctx.from.id)) {
      return false;
    }

    try {
      if (await this.userService.isBanned(ctx.from.id)) {
        await ctx.reply(this.botService.getBannedMessage());
        return true;
      }
    } catch (error) {
      this.logger.warn(
        `Ban check failed for ${ctx.from.id}: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
    }

    return false;
  }

  private getActiveReportDraft(userId: number): ReportDraft | null {
    const draft = this.reportDrafts.get(userId);
    if (!draft) {
      return null;
    }

    if (Date.now() - draft.createdAt > BotUpdate.REPORT_DRAFT_TTL_MS) {
      this.reportDrafts.delete(userId);
      return null;
    }

    return draft;
  }

  private clearReportState(userId: number): boolean {
    const draft = this.reportDrafts.get(userId);
    if (draft?.contextToken) {
      this.reportContexts.delete(draft.contextToken);
    }

    return this.reportDrafts.delete(userId);
  }

  private pruneExpiredReportDrafts(): void {
    const now = Date.now();
    for (const [userId, draft] of this.reportDrafts) {
      if (now - draft.createdAt > BotUpdate.REPORT_DRAFT_TTL_MS) {
        this.reportDrafts.delete(userId);
      }
    }
  }

  private async submitReportFromDraft(
    ctx: Context,
    description: string,
  ): Promise<void> {
    if (!ctx.from) {
      return;
    }

    const draft = this.getActiveReportDraft(ctx.from.id);
    if (!draft) {
      await ctx.reply(this.botService.getReportPromptMessage());
      return;
    }

    const context = draft.contextToken
      ? this.reportContexts.get(draft.contextToken)
      : null;

    if (!description.trim() && !context) {
      if (draft.contextToken) {
        this.reportDrafts.delete(ctx.from.id);
        await ctx.reply(this.botService.getReportExpiredMessage());
      } else {
        await ctx.reply(this.botService.getReportPromptMessage());
      }
      return;
    }

    if (context && context.userId !== ctx.from.id) {
      this.reportDrafts.delete(ctx.from.id);
      await ctx.reply(this.botService.getReportExpiredMessage());
      return;
    }

    const saved = await this.submitReport(ctx, description, context ?? null);
    if (!saved) {
      return;
    }

    this.reportDrafts.delete(ctx.from.id);
    if (draft.contextToken) {
      this.reportContexts.delete(draft.contextToken);
    }
  }

  private async submitReport(
    ctx: Context,
    rawDescription: string,
    context: ReportContext | null,
  ): Promise<boolean> {
    if (!ctx.from) {
      return false;
    }

    const description = rawDescription.trim();
    const url = context?.url ?? this.extractUrl(description);
    const platform =
      context?.platform ??
      (url ? this.downloadService.detectPlatform(url) : null);

    try {
      this.userService.recordUser(ctx.from).catch(() => {});

      const report = await this.reportService.create({
        userTelegramId: ctx.from.id,
        username: ctx.from.username ?? null,
        firstName: ctx.from.first_name ?? null,
        platform,
        url,
        errorCode: context?.errorCode ?? 'USER_REPORT',
        errorDetail: context?.errorDetail ?? null,
        description,
      });

      void this.reportNotifier.notify(report).catch((error: unknown) => {
        const message =
          error instanceof Error ? error.message : 'unknown error';
        this.logger.warn(
          `Failed to notify admins about report ${report.shortId}: ${message}`,
        );
      });

      try {
        await ctx.reply(this.botService.getReportThanksMessage(report.shortId));
      } catch (error) {
        // The report is already persisted. A failed confirmation must not
        // make the caller keep the draft and submit a duplicate on retry.
        this.logger.warn(
          `Report ${report.shortId} saved but confirmation reply failed: ${this.describeError(error)}`,
        );
      }
      return true;
    } catch (error) {
      if (error instanceof ReportRateLimitError) {
        await ctx
          .reply(this.botService.getReportRateLimitMessage(error.kind))
          .catch(() => {});
        return false;
      }

      this.logger.error(
        `Failed to save report for ${ctx.from.id}: ${this.describeError(error)}`,
      );
      await ctx
        .reply(this.botService.getReportSaveFailedMessage())
        .catch(() => {});
      return false;
    }
  }

  private createReportContext(params: {
    userId: number;
    url: string | null;
    platform: SocialPlatform | null;
    errorCode: ErrorReportCode;
    errorDetail: string | null;
  }): string {
    if (this.reportContexts.size >= BotUpdate.MAX_REPORT_CONTEXTS) {
      const oldestKey = Array.from(this.reportContexts.keys())[0];
      if (oldestKey) {
        this.reportContexts.delete(oldestKey);
      }
    }

    const token = randomBytes(4).toString('hex');
    this.reportContexts.set(token, {
      ...params,
      createdAt: Date.now(),
    });

    const timer = setTimeout(() => {
      this.reportContexts.delete(token);
    }, BotUpdate.REPORT_CONTEXT_TTL_MS);

    if (
      typeof (timer as unknown as { unref?: () => void }).unref === 'function'
    ) {
      (timer as unknown as { unref: () => void }).unref();
    }

    return token;
  }

  private extractUrl(text: string): string | null {
    const match = /https?:\/\/[^\s<>"']+/i.exec(text);
    if (!match) {
      return null;
    }

    const candidate = match[0].replace(/[),.;!?]+$/g, '');
    try {
      const url = new URL(candidate);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return null;
      }
      return url.toString();
    } catch {
      return null;
    }
  }

  private isVideoPlatform(platform: SocialPlatform): platform is VideoPlatform {
    return platform === 'tiktok' || platform === 'instagram';
  }

  private getCallbackData(ctx: Context): string {
    const callbackQuery = ctx.callbackQuery as unknown as
      | { data?: string }
      | undefined;
    return callbackQuery?.data ?? '';
  }

  private getAdminName(ctx: Context): string {
    if (!ctx.from) {
      return 'admin';
    }
    if (ctx.from.username) {
      return `@${ctx.from.username}`;
    }
    return ctx.from.first_name || `ID ${ctx.from.id}`;
  }

  private describeError(error: unknown): string {
    if (error instanceof AggregateError) {
      const parts = error.errors
        .slice(0, 3)
        .map((inner) =>
          inner instanceof Error
            ? `${inner.name}${inner.message ? `: ${inner.message}` : ''}`
            : String(inner),
        )
        .join('; ');
      return error.message
        ? `${error.message} (${parts})`
        : `${error.name}: ${parts}`;
    }
    if (error instanceof Error) {
      return error.message || error.name;
    }
    return typeof error === 'string' ? error : 'unknown error';
  }

  private parseBanTarget(
    ctx: Context,
  ):
    | { kind: 'username'; username: string }
    | { kind: 'id'; telegramId: number }
    | null {
    const message = ctx.message;
    if (!message || !('text' in message)) {
      return null;
    }
    const parts = message.text.trim().split(/\s+/);
    if (parts.length < 2 || !parts[1]) {
      return null;
    }
    const raw = parts[1].trim();
    if (/^\d+$/.test(raw)) {
      const telegramId = Number(raw);
      if (!Number.isSafeInteger(telegramId) || telegramId <= 0) {
        return null;
      }
      return { kind: 'id', telegramId };
    }
    const username = raw.replace(/^@/, '').trim();
    if (!username || !/^[A-Za-z0-9_]{1,32}$/.test(username)) {
      return null;
    }
    return { kind: 'username', username };
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

  @Action(/^report:new:(.+)$/)
  async onReportNewAction(@Ctx() ctx: Context) {
    if (!ctx.from) {
      return;
    }

    if (await this.rejectIfBanned(ctx)) {
      return;
    }

    const token = /^report:new:(.+)$/.exec(this.getCallbackData(ctx))?.[1];
    if (!token) {
      await ctx.answerCbQuery('Invalid report request').catch(() => {});
      return;
    }

    const context = this.reportContexts.get(token);
    if (!context) {
      await ctx
        .answerCbQuery(this.botService.getReportExpiredMessage())
        .catch(() => {});
      await ctx
        .reply(this.botService.getReportExpiredMessage())
        .catch(() => {});
      return;
    }

    if (context.userId !== ctx.from.id) {
      await ctx
        .answerCbQuery('This report belongs to another user')
        .catch(() => {});
      return;
    }

    if (this.broadcastComposers.has(ctx.from.id)) {
      await ctx
        .answerCbQuery('Finish or cancel your broadcast first')
        .catch(() => {});
      return;
    }

    this.reportDrafts.set(ctx.from.id, {
      contextToken: token,
      createdAt: Date.now(),
    });

    await ctx.answerCbQuery('Tell us what went wrong').catch(() => {});
    await ctx.reply(
      this.botService.getReportContextPromptMessage(),
      this.botService.getReportSkipMarkup(token) as never,
    );
  }

  @Action(/^report:skip:(.+)$/)
  async onReportSkipAction(@Ctx() ctx: Context) {
    if (!ctx.from) {
      return;
    }

    if (await this.rejectIfBanned(ctx)) {
      return;
    }

    const token = /^report:skip:(.+)$/.exec(this.getCallbackData(ctx))?.[1];
    if (!token) {
      await ctx.answerCbQuery('Invalid report request').catch(() => {});
      return;
    }

    const draft = this.getActiveReportDraft(ctx.from.id);
    const context = this.reportContexts.get(token);

    if (!draft || draft.contextToken !== token || !context) {
      // Only clear the draft this button belongs to. A stale Skip button must
      // never cancel a newer report the user has since started.
      if (draft?.contextToken === token) {
        this.reportDrafts.delete(ctx.from.id);
      }
      await ctx
        .answerCbQuery(this.botService.getReportExpiredMessage())
        .catch(() => {});
      return;
    }

    if (context.userId !== ctx.from.id) {
      await ctx
        .answerCbQuery('This report belongs to another user')
        .catch(() => {});
      return;
    }

    await ctx.answerCbQuery('Sending report...').catch(() => {});
    const saved = await this.submitReport(ctx, '', context);
    if (!saved) {
      return;
    }

    this.reportDrafts.delete(ctx.from.id);
    this.reportContexts.delete(token);
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
  }

  @Action(/^report:resolve:(.+)$/)
  async onReportResolveAction(@Ctx() ctx: Context) {
    if (!ctx.from || !this.botService.isAdmin(ctx.from.id)) {
      await ctx.answerCbQuery('Not authorized').catch(() => {});
      return;
    }

    const shortId = /^report:resolve:(.+)$/.exec(
      this.getCallbackData(ctx),
    )?.[1];

    if (!shortId) {
      await ctx.answerCbQuery('Invalid report').catch(() => {});
      return;
    }

    try {
      const result = await this.reportService.resolve(shortId, {
        id: ctx.from.id,
        name: this.getAdminName(ctx),
      });

      if (!result) {
        await ctx
          .answerCbQuery(this.botService.getReportNotFoundMessage())
          .catch(() => {});
        return;
      }

      if (result.alreadyResolved) {
        await ctx
          .answerCbQuery(
            this.botService.getReportAlreadyResolvedMessage(
              result.report.shortId,
              result.report.resolvedByName,
            ),
          )
          .catch(() => {});
      } else {
        await ctx.answerCbQuery('✅ Report resolved').catch(() => {});
      }

      await ctx
        .editMessageText(
          this.reportPresenter.formatReportAlert(result.report),
          {
            parse_mode: 'HTML',
            link_preview_options: { is_disabled: true },
            reply_markup: { inline_keyboard: [] },
          } as never,
        )
        .catch(() => {});
    } catch (error) {
      this.logger.error(
        `Failed to resolve report ${shortId}: ${this.describeError(error)}`,
      );
      await ctx.answerCbQuery('❌ Failed to resolve report').catch(() => {});
    }
  }

  @Action(/^audio:(.+)$/)
  async onAudioAction(@Ctx() ctx: Context) {
    if (ctx.from && !this.botService.isAdmin(ctx.from.id)) {
      try {
        if (await this.userService.isBanned(ctx.from.id)) {
          await ctx.answerCbQuery('You have been banned').catch(() => {});
          await ctx.reply(this.botService.getBannedMessage()).catch(() => {});
          return;
        }
      } catch (error) {
        this.logger.warn(
          `Ban check failed on audio action for ${ctx.from.id}: ${error instanceof Error ? error.message : 'unknown error'}`,
        );
      }
    }

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

  @Action(/^slideshow:video:(.+)$/)
  async onSlideshowVideoAction(@Ctx() ctx: Context) {
    if (!ctx.from) {
      return;
    }

    if (await this.rejectIfBanned(ctx)) {
      return;
    }

    const token = /^slideshow:video:(.+)$/.exec(this.getCallbackData(ctx))?.[1];
    if (!token) {
      await ctx.answerCbQuery('Invalid video request').catch(() => {});
      return;
    }

    const request = this.videoRequestStore.get(token);
    if (!request) {
      await ctx
        .answerCbQuery(this.botService.getVideoExpiredMessage())
        .catch(() => {});
      await ctx.reply(this.botService.getVideoExpiredMessage()).catch(() => {});
      return;
    }

    if (request.userId !== ctx.from.id) {
      await ctx
        .answerCbQuery('This video belongs to another user')
        .catch(() => {});
      return;
    }

    // Marker so a silent tap can be distinguished from a slow render in logs.
    this.logger.log(
      `Slideshow video start user=${ctx.from.id} platform=${request.platform} images=${request.images.length} audio=${request.music ? 'yes' : 'no'}`,
    );

    // Stored CDN URLs expire fast (often within the hour), so re-resolve
    // the original link into fresh URLs before rendering. Falls back to
    // the stored URLs when the refresh fails.
    const liveRequest = await this.refreshSlideshowRequest(request);

    if (!this.videoRenderService.isAvailable()) {
      await ctx
        .answerCbQuery(this.botService.getVideoUnavailableMessage())
        .catch(() => {});
      await ctx
        .reply(this.botService.getVideoUnavailableMessage())
        .catch(() => {});
      return;
    }

    let renderPromise: Promise<RenderResult>;
    try {
      renderPromise = this.videoRenderService.render(liveRequest);
    } catch (error) {
      await this.answerVideoRenderError(ctx, error, liveRequest.platform);
      return;
    }

    await ctx.answerCbQuery('🎬 Rendering your video...').catch(() => {});

    const status = await ctx
      .reply(this.botService.getVideoRenderingMessage())
      .catch(() => null);

    const heartbeat = setInterval(() => {
      ctx.sendChatAction('upload_video').catch(() => {});
    }, 4000);
    if (
      typeof (heartbeat as unknown as { unref?: () => void }).unref ===
      'function'
    ) {
      (heartbeat as unknown as { unref: () => void }).unref();
    }

    let result: RenderResult | null = null;
    try {
      result = await renderPromise;

      const audioCallback =
        liveRequest.platform === 'tiktok' && liveRequest.music
          ? this.createAudioCallback(liveRequest.music, liveRequest.title)
          : null;

      const extra = {
        caption: this.botService.getSlideshowVideoCaption(result, liveRequest),
        width: result.width,
        height: result.height,
        duration: Math.round(result.durationSec),
        supports_streaming: true,
        ...this.botService.getMediaReplyMarkup(audioCallback ?? undefined),
      };

      await ctx.replyWithVideo(
        {
          source: result.filePath,
          filename: `shadowsave-${liveRequest.platform}.mp4`,
        },
        extra as never,
      );

      this.userService
        .recordEvent({
          userTelegramId: ctx.from.id,
          platform: request.platform,
          mediaType: 'video_export',
          url: request.url,
          success: true,
        })
        .catch(() => {});
    } catch (error) {
      this.userService
        .recordEvent({
          userTelegramId: ctx.from.id,
          platform: request.platform,
          mediaType: 'video_export',
          url: request.url,
          success: false,
        })
        .catch(() => {});

      if (error instanceof VideoExportError) {
        if (error.code === 'VIDEO_TOO_LARGE') {
          await ctx
            .reply(this.botService.getFileTooLargeMessage(request.platform))
            .catch(() => {});
        } else if (
          error.code === 'VIDEO_EXPIRED' ||
          error.code === 'VIDEO_DOWNLOAD_FAILED'
        ) {
          await ctx
            .reply(this.botService.getVideoExpiredMessage())
            .catch(() => {});
        } else if (
          error.code === 'VIDEO_UNAVAILABLE' ||
          error.code === 'VIDEO_DISABLED'
        ) {
          await ctx
            .reply(this.botService.getVideoUnavailableMessage())
            .catch(() => {});
        } else if (
          error.code === 'VIDEO_QUEUE_FULL' ||
          error.code === 'VIDEO_ALREADY_RENDERING'
        ) {
          await ctx
            .reply(this.botService.getVideoBusyMessage())
            .catch(() => {});
        } else if (error.code === 'VIDEO_COOLDOWN') {
          await ctx
            .reply(
              this.botService.getVideoCooldownMessage(
                this.parseCooldownSeconds(error),
              ),
            )
            .catch(() => {});
        } else {
          await ctx
            .reply(this.botService.getVideoFailedMessage())
            .catch(() => {});
        }
        this.logger.warn(
          `Video render failed for user ${ctx.from.id} platform ${request.platform} code ${error.code}: ${error.message}`,
        );
        return;
      }

      this.logger.warn(
        `Video render failed for user ${ctx.from.id} platform ${request.platform}: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
      await ctx.reply(this.botService.getVideoFailedMessage()).catch(() => {});
    } finally {
      clearInterval(heartbeat);
      if (status) {
        await ctx.telegram
          .deleteMessage(status.chat.id, status.message_id)
          .catch(() => {});
      }
      await result?.cleanup().catch(() => {});
    }
  }

  private async answerVideoRenderError(
    ctx: Context,
    error: unknown,
    platform: VideoPlatform,
  ): Promise<void> {
    if (error instanceof VideoExportError) {
      if (
        error.code === 'VIDEO_QUEUE_FULL' ||
        error.code === 'VIDEO_ALREADY_RENDERING'
      ) {
        await ctx
          .answerCbQuery(this.botService.getVideoBusyMessage(), {
            show_alert: true,
          } as never)
          .catch(() => {});
        return;
      }
      if (error.code === 'VIDEO_COOLDOWN') {
        await ctx
          .answerCbQuery(
            this.botService.getVideoCooldownMessage(
              this.parseCooldownSeconds(error),
            ),
            { show_alert: true } as never,
          )
          .catch(() => {});
        return;
      }
      if (
        error.code === 'VIDEO_UNAVAILABLE' ||
        error.code === 'VIDEO_DISABLED'
      ) {
        await ctx
          .answerCbQuery(this.botService.getVideoUnavailableMessage(), {
            show_alert: true,
          } as never)
          .catch(() => {});
        return;
      }
      if (error.code === 'VIDEO_EXPIRED') {
        await ctx
          .answerCbQuery(this.botService.getVideoExpiredMessage(), {
            show_alert: true,
          } as never)
          .catch(() => {});
        await ctx
          .reply(this.botService.getVideoExpiredMessage())
          .catch(() => {});
        return;
      }
      if (error.code === 'VIDEO_TOO_LARGE') {
        await ctx
          .answerCbQuery(this.botService.getFileTooLargeMessage(platform), {
            show_alert: true,
          } as never)
          .catch(() => {});
        await ctx
          .reply(this.botService.getFileTooLargeMessage(platform))
          .catch(() => {});
        return;
      }
      this.logger.warn(
        `Video render rejected platform ${platform} code ${error.code}: ${error.message}`,
      );
    } else {
      this.logger.warn(
        `Video render rejected platform ${platform}: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
    await ctx
      .answerCbQuery(this.botService.getVideoFailedMessage(), {
        show_alert: true,
      } as never)
      .catch(() => {});
  }

  private parseCooldownSeconds(error: VideoExportError): number {
    const fromProp =
      (error as unknown as { retryAfterSec?: unknown }).retryAfterSec ??
      (error as unknown as { retryAfterSeconds?: unknown }).retryAfterSeconds;
    if (typeof fromProp === 'number' && Number.isFinite(fromProp)) {
      return Math.max(1, Math.ceil(fromProp));
    }
    const match = /(\d+)\s*s(?:ec(?:ond)?s?)?/i.exec(error.message ?? '');
    if (match?.[1]) {
      const parsed = Number(match[1]);
      if (Number.isFinite(parsed) && parsed > 0) {
        return Math.ceil(parsed);
      }
    }
    return 30;
  }

  private async refreshSlideshowRequest(
    request: VideoRequest,
  ): Promise<VideoRequest> {
    let fresh: MediaInfo;
    try {
      fresh = await this.downloadService.refreshMediaInfo(request.url);
    } catch (error) {
      this.logger.warn(
        `Slideshow refresh failed for ${request.platform}, using stored URLs: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
      return request;
    }
    const minImages = request.platform === 'tiktok' && fresh.music ? 1 : 2;
    if (!fresh.images || fresh.images.length < minImages) {
      this.logger.warn(
        `Slideshow refresh returned ${fresh.images?.length ?? 0} images, using stored URLs`,
      );
      return request;
    }
    this.logger.log(
      `Slideshow URLs refreshed for ${request.platform}: ${fresh.images.length} images audio=${fresh.music ? 'yes' : 'no'}`,
    );
    return {
      ...request,
      images: fresh.images,
      music: fresh.music || null,
      musicDurationSec: fresh.musicDurationSec ?? null,
      musicTitle: fresh.musicTitle ?? null,
    };
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
          return nestedDesc.description;
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
