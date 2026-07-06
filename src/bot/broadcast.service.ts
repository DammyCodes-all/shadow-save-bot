import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Telegraf } from 'telegraf';

@Injectable()
export class BroadcastService {
  private readonly logger = new Logger(BroadcastService.name);
  private readonly bot: Telegraf;
  private readonly concurrency = 5;
  private isRunning = false;

  constructor(configService: ConfigService) {
    this.bot = new Telegraf(
      configService.getOrThrow<string>('TELEGRAM_BOT_API_KEY'),
    );
  }

  sendAll(userIds: number[], text: string): void {
    if (this.isRunning) {
      this.logger.warn('Broadcast already in progress, skipping');
      return;
    }

    this.isRunning = true;
    this.logger.log(`Broadcasting to ${userIds.length} users...`);

    setImmediate(() => {
      void this.runBroadcast(userIds, text);
    });
  }

  private async runBroadcast(userIds: number[], text: string): Promise<void> {
    let sent = 0;
    let failed = 0;
    let blocked = 0;

    try {
      for (let i = 0; i < userIds.length; i += this.concurrency) {
        const batch = userIds.slice(i, i + this.concurrency);
        const results = await Promise.allSettled(
          batch.map((chatId) => this.sendOne(chatId, text)),
        );

        for (const r of results) {
          if (r.status === 'fulfilled') {
            if (r.value === 'blocked') blocked++;
            else sent++;
          } else {
            failed++;
            const reason =
              r.reason instanceof Error ? r.reason.message : 'unknown error';
            this.logger.error(`Broadcast failed: ${reason}`);
          }
        }

        if (i + this.concurrency < userIds.length) {
          await new Promise((r) => setTimeout(r, 100));
        }
      }
    } finally {
      this.isRunning = false;
    }

    this.logger.log(
      `Broadcast complete: ${sent} sent, ${blocked} blocked, ${failed} failed`,
    );
  }

  private async sendOne(
    chatId: number,
    text: string,
  ): Promise<'sent' | 'blocked'> {
    try {
      await this.bot.telegram.sendMessage(chatId, text);
      return 'sent';
    } catch (error: unknown) {
      if (
        error &&
        typeof error === 'object' &&
        'response' in error &&
        error.response &&
        typeof error.response === 'object' &&
        'error_code' in error.response &&
        error.response.error_code === 403
      ) {
        this.logger.warn(`User ${chatId} blocked the bot, skipping`);
        return 'blocked';
      }
      throw error;
    }
  }
}
