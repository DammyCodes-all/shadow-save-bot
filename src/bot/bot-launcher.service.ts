import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectBot } from 'nestjs-telegraf';
import { Telegraf } from 'telegraf';

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

  constructor(@InjectBot() private readonly bot: Telegraf) {}

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
        await this.bot.launch();
        this.logger.log('Telegram bot polling started');
        return;
      } catch (error) {
        const raw =
          error instanceof Error ? error.message : String(error ?? '');
        // Telegraf embeds the request URL (including the bot token) in
        // FetchError messages; never log the token.
        const message = raw.replace(/\/bot[^/\s]+/, '/bot<redacted>');
        this.logger.warn(
          `Telegram bot launch failed (attempt ${attempt}): ${message}. ` +
            `Retrying in ${delayMs}ms. HTTP health endpoint stays available.`,
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        delayMs = Math.min(delayMs * 2, 60000);
      }
    }
  }
}
