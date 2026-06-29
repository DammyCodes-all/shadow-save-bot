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
        const label = m.type === 'video' ? 'Video' : m.type === 'image' ? 'Image' : m.type;
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

    return platform;
  }
}
