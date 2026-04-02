import { Injectable } from '@nestjs/common';

@Injectable()
export class BotService {
  getWelcomeMessage(): string {
    return 'Send me a TikTok link and I will download it for you!';
  }

  getDownloadQueuedMessage(url: string): string {
    return `Got it! Downloading... ${url}`;
  }
}
