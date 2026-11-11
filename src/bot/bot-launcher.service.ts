import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectBot } from 'nestjs-telegraf';
import { Telegraf } from 'telegraf';
import { BotService } from './bot.service';

/**
 * Starts Telegram long-polling in the background with retries.
 *
 * Rationale: `nestjs-telegraf` auto-launch fires `bot.launch()` without
 * awaiting it, so a Telegram API failure (timeout, blocked egress, bad
 * network) becomes an unhandled rejection that kills the Node process
 * BEFORE `app.listen()` runs. The platform then reports "no TCP listeners"
 * even though the HTTP code is correct. Disabling auto-launch (see
 * BotModule `launchOptions: false`) and launching here keeps the HTTP
 * health endpoint available while Telegram connectivity recovers.
 */
@Injectable()
export class BotLauncherService implements OnApplicationBootstrap {
  private readonly logger = new Logger(BotLauncherService.name);
  private stopped = false;
  private commandsRegistered = false;

  constructor(
    @InjectBot() private readonly bot: Telegraf,
    private readonly botService: BotService,
    private readonly configService: ConfigService,
  ) {}

  onApplicationBootstrap(): void {
    // Fire-and-forget on purpose: must never block or fail HTTP startup.
    void this.launchWithRetry();
  }

  onApplicationShutdown(): void {
    this.stopped = true;
    try {
      this.bot.stop();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Error stopping Telegram bot: ${message}`);
    }
  }

  private async launchWithRetry(): Promise<void> {
    let delayMs = 2000;
    let attempt = 0;

    while (!this.stopped) {
      attempt += 1;
      try {
        await this.registerCommands();
        await this.bot.launch();
        this.logger.log('Telegram bot polling started');
        return;
      } catch (error) {
        const message = this.redactError(error);
        this.logger.warn(
          `Telegram bot launch failed (attempt ${attempt}): ${message}. ` +
            `Retrying in ${delayMs}ms. HTTP health endpoint stays available.`,
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        delayMs = Math.min(delayMs * 2, 60000);
      }
    }
  }

  /**
   * Publishes the "/" command menu. The default scope covers every user;
   * each admin also gets a chat-scoped menu with the admin commands.
   * Failures are non-fatal: the bot still launches and buttons keep working.
   */
  private async registerCommands(): Promise<void> {
    if (this.commandsRegistered) {
      return;
    }

    try {
      await this.bot.telegram.setMyCommands(this.botService.getUserCommands());

      const adminIds = this.configService.get<number[]>('ADMIN_IDS') ?? [];
      for (const adminId of adminIds) {
        await this.bot.telegram.setMyCommands(
          this.botService.getAdminCommands(),
          { scope: { type: 'chat', chat_id: adminId } },
        );
      }

      this.commandsRegistered = true;
      this.logger.log(
        `Telegram command menu registered for users and ${adminIds.length} admin chat(s)`,
      );
    } catch (error) {
      const message = this.redactError(error);
      this.logger.warn(`Failed to register Telegram command menu: ${message}`);
    }
  }

  private redactError(error: unknown): string {
    const raw =
      error instanceof Error
        ? error.message
        : typeof error === 'string'
          ? error
          : 'Unknown error';
    // Telegraf embeds the request URL (including the bot token) in FetchError
    // messages; never log the token.
    return raw.replace(/\/bot[^/\s]+/, '/bot<redacted>');
  }
}
