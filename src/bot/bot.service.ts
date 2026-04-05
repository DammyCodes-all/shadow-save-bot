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
