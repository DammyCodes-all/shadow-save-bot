import { Injectable } from '@nestjs/common';

@Injectable()
export class BotService {
  private readonly tiktokUrlPattern =
    /^(https?:\/\/)?(www\.)?(vm\.|vt\.)?tiktok\.com\/.+/i;

  getWelcomeMessage(): string {
    return "Hi there! Welcome to Shadow Save Bot.\n\nSend me a TikTok link and I'll help you download the video in just a moment.\n\nExample:\nhttps://vm.tiktok.com/XXXXXXX/";
  }

  isTikTokUrl(text: string): boolean {
    return this.tiktokUrlPattern.test(text.trim());
  }

  getUnsupportedLinkMessage(): string {
    return 'Incorrect Tik Tok link.\n\nTo download the video, send the link in the format:\nhttps://vm.tiktok.com/XXXXXXX/';
  }

  getDownloadQueuedMessage(url: string): string {
    return `Got it! Downloading... ${url}`;
  }
}
