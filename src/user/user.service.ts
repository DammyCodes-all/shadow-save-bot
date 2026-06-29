import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, MoreThanOrEqual } from 'typeorm';
import { UserEntity } from './entities/user.entity';
import { DownloadEventEntity } from './entities/download-event.entity';
import type { SocialPlatform } from '../download/providers/social-media-provider.interface';

export type RecordDownloadEventParams = {
  userTelegramId: number;
  platform: SocialPlatform;
  mediaType?: string | null;
  url: string;
  success: boolean;
};

export type UserStats = {
  totalUsers: number;
  downloadsToday: number;
  perPlatform: { platform: string; count: number }[];
};

@Injectable()
export class UserService implements OnModuleInit {
  private readonly logger = new Logger(UserService.name);

  constructor(
    @InjectRepository(UserEntity)
    private readonly userRepo: Repository<UserEntity>,
    @InjectRepository(DownloadEventEntity)
    private readonly eventRepo: Repository<DownloadEventEntity>,
    private readonly dataSource: DataSource,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.dataSource.query('SELECT 1');
      this.logger.log('Database pool warmed');
    } catch {
      this.logger.warn('Database pool warmup failed, will retry on first query');
    }
  }

  async recordUser(telegramUser: {
    id: number;
    username?: string;
    first_name?: string;
    last_name?: string;
    language_code?: string;
  }): Promise<UserEntity> {
    const existing = await this.userRepo.findOneBy({
      telegramId: telegramUser.id,
    });

    if (existing) {
      existing.lastSeenAt = new Date();
      existing.username = telegramUser.username ?? existing.username;
      existing.firstName = telegramUser.first_name ?? existing.firstName;
      existing.lastName = telegramUser.last_name ?? existing.lastName;
      existing.languageCode = telegramUser.language_code ?? existing.languageCode;
      return this.userRepo.save(existing);
    }

    return this.userRepo.save({
      telegramId: telegramUser.id,
      username: telegramUser.username ?? null,
      firstName: telegramUser.first_name ?? null,
      lastName: telegramUser.last_name ?? null,
      languageCode: telegramUser.language_code ?? null,
    });
  }

  async recordEvent(params: RecordDownloadEventParams): Promise<DownloadEventEntity> {
    const event = this.eventRepo.create({
      userTelegramId: params.userTelegramId,
      platform: params.platform,
      mediaType: params.mediaType ?? null,
      url: params.url,
      success: params.success,
    });
    return this.eventRepo.save(event);
  }

  async incrementDownloadCount(telegramId: number): Promise<void> {
    await this.userRepo.increment({ telegramId }, 'totalDownloads', 1);
  }

  async getAllNonBannedUserIds(): Promise<number[]> {
    const users = await this.userRepo.find({
      where: { isBanned: false, optOut: false },
      select: { telegramId: true },
    });
    return users.map((u) => u.telegramId);
  }

  async getStats(): Promise<UserStats> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [totalUsers, downloadsToday, perPlatform] = await Promise.all([
      this.userRepo.count(),
      this.eventRepo.count({ where: { createdAt: MoreThanOrEqual(today) } }),
      this.eventRepo
        .createQueryBuilder('e')
        .select('e.platform', 'platform')
        .addSelect('COUNT(*)', 'count')
        .groupBy('e.platform')
        .orderBy('COUNT(*)', 'DESC')
        .getRawMany<{ platform: string; count: number }>(),
    ]);

    return { totalUsers, downloadsToday, perPlatform };
  }
}
