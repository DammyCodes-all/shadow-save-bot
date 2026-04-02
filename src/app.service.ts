import { Injectable } from '@nestjs/common';

@Injectable()
export class AppService {
  getHello(): string {
    return 'Welcome to Shadow Save Bot! \n\nThis bot allows you to download TikTok videos without watermarks. \n\n To gets started access the bot from https://t.me/shadow_save_bot and send a TikTok video link. \n\nExample:\nhttps://vm.tiktok.com/XXXXXXX/';
  }
}
