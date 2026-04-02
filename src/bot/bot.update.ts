import { Injectable } from '@nestjs/common';
import { Ctx, On, Start, Update } from 'nestjs-telegraf';
import { Context } from 'telegraf';
import { BotService } from './bot.service.js';

@Update()
@Injectable()
export class BotUpdate {
  constructor(private readonly botService: BotService) {}

  @Start()
  async onStart(@Ctx() ctx: Context) {
    await ctx.reply(this.botService.getWelcomeMessage());
  }

  @On('text')
  async onText(@Ctx() ctx: Context) {
    const message = ctx.message;

    if (!message || !('text' in message)) {
      return;
    }

    const url = message.text;
    await ctx.reply(this.botService.getDownloadQueuedMessage(url));
  }
}
