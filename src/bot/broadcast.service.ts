import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Telegraf } from 'telegraf';

@Processor('broadcast')
export class BroadcastService extends WorkerHost {
  private readonly logger = new Logger(BroadcastService.name);
  private readonly bot: Telegraf;

  constructor(configService: ConfigService) {
    super();
    this.bot = new Telegraf(configService.getOrThrow<string>('TELEGRAM_BOT_API_KEY'));
  }

  async process(job: Job<{ chatId: number; text: string }>): Promise<void> {
    try {
      await this.bot.telegram.sendMessage(job.data.chatId, job.data.text);
      this.logger.debug(`Broadcast sent to ${job.data.chatId}`);
    } catch (error: any) {
      if (error?.response?.error_code === 403) {
        this.logger.warn(`User ${job.data.chatId} blocked the bot, skipping`);
        return;
      }
      this.logger.error(`Failed to send to ${job.data.chatId}: ${error.message}`);
      throw error;
    }
  }
}
