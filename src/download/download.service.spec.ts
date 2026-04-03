import { Test, TestingModule } from '@nestjs/testing';
import { DownloadService } from './download.service';
mport { MediaCacheService } from './media-cache.service';
import { SOCIAL_MEDIA_PROVIDERS } from './providers/provider.constants';
import type { SocialMediaProvider } from './providers/social-media-provider.interface';

describe('DownloadService', () => {
  let service: DownloadService;
  const mediaCacheServiceMock = {
    get: jest.fn(),
    set: jest.fn(),
  };

  const providersMock: SocialMediaProvider[] = [
    {
      platform: 'tiktok',
      canHandle: jest.fn().mockReturnValue(false),
      getMediaInfo: jest.fn(),
    },
  ];

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DownloadService,
        {
          provide: MediaCacheService,
          useValue: mediaCacheServiceMock,
        },
        {
          provide: SOCIAL_MEDIA_PROVIDERS,
          useValue: providersMock,
        },
      ],
    }).compile();

    service = module.get<DownloadService>(DownloadService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should expose supported platforms', () => {
    expect(service.getSupportedPlatforms()).toEqual(['tiktok']);
  });
});
