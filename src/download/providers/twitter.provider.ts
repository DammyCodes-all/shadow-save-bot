import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import type { MediaInfo } from '../download.types';
import type { SocialMediaProvider } from './social-media-provider.interface';

@Injectable()
export class TwitterProvider implements SocialMediaProvider {
  readonly platform = 'twitter' as const;

  private readonly twitterUrlPattern =
    /^(https?:\/\/)?(www\.)?(twitter\.com|x\.com)\/.+/i;

  canHandle(url: string): boolean {
    return this.twitterUrlPattern.test(url.trim());
  }

  async getMediaInfo(_url: string): Promise<MediaInfo> {
    throw new HttpException(
      'Twitter support is not implemented yet',
      HttpStatus.NOT_IMPLEMENTED,
    );
  }
}
