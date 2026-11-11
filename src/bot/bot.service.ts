import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { SocialPlatform } from '../download/providers/social-media-provider.interface';

@Injectable()
export class BotService {
  constructor(private readonly configService: ConfigService) {}

  getWelcomeMessage(): string {
    return "Hi there! Welcome to Shadow Save Bot.\n\nSend a supported social media link and I'll try to fetch the media for you.\n\nCurrently best supported: TikTok\nTwitter/X support is integrated.\n\nExample:\nhttps://vm.tiktok.com/XXXXXXX/";
  }

  getUnsupportedLinkMessage(supportedPlatforms: SocialPlatform[]): string {
    const supported = this.getPlatformDisplayText(supportedPlatforms);

    return `Unsupported link.\n\nSupported platforms: ${supported}\n\nExample:\nhttps://vm.tiktok.com/XXXXXXX/`;
  }

  getNotImplementedMessage(platform: SocialPlatform): string {
    if (platform === 'twitter') {
      return 'Twitter/X support is coming soon. Please send a TikTok link for now.';
    }

    return `${this.getPlatformName(platform)} support is coming soon.`;
  }

  getDownloadFailureMessage(platform: SocialPlatform): string {
    return `❌ Failed to download. Make sure it's a valid public ${this.getPlatformName(platform)} link.`;
  }

  getFileTooLargeMessage(_platform: SocialPlatform): string {
    return `😔 This file is a bit too large to send here (Telegram's 50 MB limit).\nSend me a shorter video and I'll grab it for you!`;
  }

  getBannedMessage(): string {
    return (
      `🚫 You have been banned.\n\n` +
      `You have been banned due to misuse or a violation of our fair-use policy.\n` +
      `You can no longer download media with this bot.`
    );
  }

  getAudioFileTooLargeMessage(_platform: SocialPlatform): string {
    return `😔 This audio is a bit too large to send (50 MB limit).\nTry another video — I'll get it for you right away!`;
  }

  getDownloadQueuedMessage(url: string): string {
    return `Got it! Downloading... ${url}`;
  }

  isAdmin(telegramId: number): boolean {
    const adminIds = this.configService.get<number[]>('ADMIN_IDS');
    if (!Array.isArray(adminIds)) {
      return false;
    }
    return adminIds.includes(telegramId);
  }

  getUserCommands(): Array<{ command: string; description: string }> {
    return [
      { command: 'start', description: 'Start the bot' },
      {
        command: 'report',
        description: 'Report a problem to the admins',
      },
      {
        command: 'cancel',
        description: 'Cancel a report in progress',
      },
    ];
  }

  getAdminCommands(): Array<{ command: string; description: string }> {
    return [
      { command: 'start', description: 'Start the bot' },
      {
        command: 'report',
        description: 'Report a problem to the admins',
      },
      {
        command: 'reports',
        description: 'List open error reports',
      },
      {
        command: 'resolve',
        description: 'Resolve an error report',
      },
      {
        command: 'cancel',
        description: 'Cancel a report in progress',
      },
      { command: 'stats', description: 'Show bot statistics' },
      {
        command: 'broadcast',
        description: 'Send a message to all users',
      },
      { command: 'exit', description: 'Exit broadcast mode' },
      { command: 'ban', description: 'Ban a user' },
      { command: 'unban', description: 'Unban a user' },
    ];
  }

  getStatsMessage(stats: {
    totalUsers: number;
    totalDownloads: number;
    downloadsToday: number;
    downloadsThisWeek: number;
    activeUsersToday: number;
    activeUsersThisWeek: number;
    newUsersToday: number;
    newUsersThisWeek: number;
    perPlatform: { platform: string; count: number }[];
    perMediaType: { type: string; count: number }[];
    topUsers: { username: string | null; downloads: number }[];
    successRate: number;
  }): string {
    const lines = [
      '📊 Bot Statistics',
      '',
      `👥 Total users: ${stats.totalUsers.toLocaleString()}`,
      `📥 Total downloads: ${stats.totalDownloads.toLocaleString()}`,
      `✅ Success rate: ${stats.successRate}%`,
      '',
      '📈 Activity',
      `   Today: ${stats.downloadsToday.toLocaleString()} downloads · ${stats.activeUsersToday} users`,
      `   This week: ${stats.downloadsThisWeek.toLocaleString()} downloads · ${stats.activeUsersThisWeek} users`,
      '',
      '🆕 New users',
      `   Today: ${stats.newUsersToday}`,
      `   This week: ${stats.newUsersThisWeek}`,
    ];

    if (stats.perPlatform.length > 0) {
      lines.push('');
      lines.push('📱 By platform:');
      for (const p of stats.perPlatform) {
        lines.push(`   • ${p.platform}: ${p.count.toLocaleString()}`);
      }
    }

    if (stats.perMediaType.length > 0) {
      lines.push('');
      lines.push('🎞️ By type:');
      for (const m of stats.perMediaType) {
        const label =
          m.type === 'video' ? 'Video' : m.type === 'image' ? 'Image' : m.type;
        lines.push(`   • ${label}: ${m.count.toLocaleString()}`);
      }
    }

    if (stats.topUsers.length > 0) {
      lines.push('');
      lines.push('🏆 Top downloaders:');
      for (const u of stats.topUsers) {
        const name = u.username ?? 'Unknown';
        lines.push(`   • @${name}: ${u.downloads} downloads`);
      }
    }

    return lines.join('\n');
  }

  getShareWithFriendsMarkup() {
    const botUsername = this.configService.getOrThrow<string>(
      'TELEGRAM_BOT_USERNAME',
    );

    return {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: 'Share bot with friends',
              url: `https://t.me/share/url?url=${encodeURIComponent(`https://t.me/${botUsername}`)}&text=${encodeURIComponent('Check out this bot for downloading TikTok videos and slideshows!')}`,
            },
          ],
        ],
      },
    };
  }

  getMediaReplyMarkup(audioCallbackData?: string) {
    const botUsername = this.configService.getOrThrow<string>(
      'TELEGRAM_BOT_USERNAME',
    );

    const keyboard: Array<
      Array<
        { text: string; url: string } | { text: string; callback_data: string }
      >
    > = [
      [
        {
          text: 'Share bot with friends',
          url: `https://t.me/share/url?url=${encodeURIComponent(`https://t.me/${botUsername}`)}&text=${encodeURIComponent('Check out this bot for downloading TikTok videos and slideshows!')}`,
        },
      ],
    ] as unknown as Array<
      Array<
        { text: string; url: string } | { text: string; callback_data: string }
      >
    >;

    if (audioCallbackData) {
      (keyboard as Array<Array<{ text: string; callback_data: string }>>).push([
        {
          text: '🎧 Get audio',
          callback_data: audioCallbackData,
        },
      ]);
    }

    return {
      reply_markup: {
        inline_keyboard: keyboard as unknown as Array<
          Array<
            | { text: string; url: string }
            | { text: string; callback_data: string }
          >
        >,
      },
    } as const;
  }

  getAudioButtonMarkup(audioCallbackData: string): {
    reply_markup: {
      inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
    };
  } {
    return {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: '🎧 Get audio',
              callback_data: audioCallbackData,
            },
          ],
        ],
      },
    };
  }

  getReportPromptMessage(): string {
    return '🛠 What went wrong?\n\nSend me a short description of the problem. If you can, include the link you tried.\n\nSend /cancel to stop.';
  }

  getReportContextPromptMessage(): string {
    return "🛠 What went wrong?\n\nI've already attached the link and error details. Send me a short description, or tap Skip.";
  }

  getReportThanksMessage(shortId: string): string {
    return `✅ Thanks — report #${shortId} sent to the admins.`;
  }

  getReportSaveFailedMessage(): string {
    return "❌ Couldn't save your report right now. Please try again in a minute.";
  }

  getReportRateLimitMessage(kind: 'cooldown' | 'daily'): string {
    if (kind === 'cooldown') {
      return '⏳ You just sent a report. Please wait a minute before sending another.';
    }

    return "You've reached today's report limit (5). Please try again tomorrow.";
  }

  getReportCancelledMessage(): string {
    return 'Report cancelled.';
  }

  getReportNothingToCancelMessage(): string {
    return 'Nothing to cancel.';
  }

  getReportNothingToSkipMessage(): string {
    return 'There is no report to skip. Use /report to start one.';
  }

  getReportSkipNeedsDescriptionMessage(): string {
    return 'There is nothing to skip yet. Send a short description of the problem, or /cancel to stop.';
  }

  getReportExpiredMessage(): string {
    return 'This report link expired. Use /report to send a new one.';
  }

  getReportNotFoundMessage(): string {
    return 'Report not found.';
  }

  getReportsEmptyMessage(): string {
    return '🛠 No open reports. 🎉';
  }

  getReportResolvedMessage(shortId: string): string {
    return `✅ Report #${shortId} marked as resolved.`;
  }

  getReportAlreadyResolvedMessage(
    shortId: string,
    resolvedByName?: string | null,
  ): string {
    const by = resolvedByName ? ` by ${resolvedByName}` : '';
    return `Report #${shortId} is already resolved${by}.`;
  }

  getReportButtonMarkup(reportToken: string): {
    reply_markup: {
      inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
    };
  } {
    return {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: '🛠 Report this problem',
              callback_data: `report:new:${reportToken}`,
            },
          ],
        ],
      },
    };
  }

  getReportSkipMarkup(reportToken: string): {
    reply_markup: {
      inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
    };
  } {
    return {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: 'Skip',
              callback_data: `report:skip:${reportToken}`,
            },
          ],
        ],
      },
    };
  }

  private getPlatformDisplayText(platforms: SocialPlatform[]): string {
    return platforms
      .map((platform) => this.getPlatformName(platform))
      .join(', ');
  }

  private getPlatformName(platform: SocialPlatform): string {
    if (platform === 'tiktok') {
      return 'TikTok';
    }

    if (platform === 'twitter') {
      return 'Twitter/X';
    }

    if (platform === 'instagram') {
      return 'Instagram';
    }

    return platform;
  }
}
