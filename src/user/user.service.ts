import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, MoreThanOrEqual, In } from 'typeorm';
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
  totalDownloads: number;
  downloadsToday: number;
  downloadsThisWeek: number;
  activeUsersToday: number;
  activeUsersThisWeek: number;
  newUsersToday: number;
  newUsersThisWeek: number;
  perPlatform: { platform: string; count: number }[];
  perMediaType: { type: string; count: number }[];
  topUsers: { username: string | null; downloads: number }[];
  successRate: number;
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
    const now = new Date();
    const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);

    const [
      totalUsers,
      successfulDownloads,
      downloadsToday,
      downloadsThisWeek,
      activeUsersToday,
      activeUsersThisWeek,
      newUsersToday,
      newUsersThisWeek,
      perPlatform,
      perMediaType,
      rawTopUsers,
    ] = await Promise.all([
      this.userRepo.count(),
      this.eventRepo.count({ where: { success: true } }),
      this.eventRepo.count({ where: { createdAt: MoreThanOrEqual(today), success: true } }),
      this.eventRepo.count({ where: { createdAt: MoreThanOrEqual(weekAgo), success: true } }),

      this.countDistinctActiveUsersSince(today),
      this.countDistinctActiveUsersSince(weekAgo),

      this.userRepo.count({ where: { firstSeenAt: MoreThanOrEqual(today) } }),
      this.userRepo.count({ where: { firstSeenAt: MoreThanOrEqual(weekAgo) } }),

      this.eventRepo
        .createQueryBuilder('e')
        .select('e.platform', 'platform')
        .addSelect('COUNT(*)', 'count')
        .where('e.success = true')
        .groupBy('e.platform')
        .orderBy('COUNT(*)', 'DESC')
        .getRawMany<{ platform: string; count: number }>(),

      this.eventRepo
        .createQueryBuilder('e')
        .select('e.mediaType', 'type')
        .addSelect('COUNT(*)', 'count')
        .where('e.mediaType IS NOT NULL')
        .andWhere('e.success = true')
        .groupBy('e.mediaType')
        .orderBy('COUNT(*)', 'DESC')
        .getRawMany<{ type: string; count: number }>(),

      this.eventRepo
        .createQueryBuilder('e')
        .select('e.userTelegramId', 'userTelegramId')
        .addSelect('COUNT(*)', 'downloads')
        .where('e.success = true')
        .groupBy('e.userTelegramId')
        .orderBy('COUNT(*)', 'DESC')
        .take(3)
        .getRawMany<{ userTelegramId: number; downloads: string }>(),
    ]);

    const totalEvents = await this.eventRepo.count();
    const successRate = totalEvents > 0 ? Math.round((successfulDownloads / totalEvents) * 100) : 0;

    const topUserIds = rawTopUsers.map(r => r.userTelegramId);
    const userEntities = topUserIds.length > 0
      ? await this.userRepo.find({
          where: { telegramId: In(topUserIds) },
          select: { telegramId: true, username: true },
        })
      : [];
    const userMap = new Map(userEntities.map(u => [u.telegramId, u.username]));
    const topUsers = rawTopUsers.map(r => ({
      username: userMap.get(r.userTelegramId) ?? null,
      downloads: Number(r.downloads),
    }));

    return {
      totalUsers,
      totalDownloads: successfulDownloads,
      downloadsToday,
      downloadsThisWeek,
      activeUsersToday,
      activeUsersThisWeek,
      newUsersToday,
      newUsersThisWeek,
      perPlatform,
      perMediaType,
      topUsers,
      successRate,
    };
  }

  private async countDistinctActiveUsersSince(since: Date): Promise<number> {
    const result = await this.eventRepo
      .createQueryBuilder('e')
      .select('COUNT(DISTINCT e.userTelegramId)', 'count')
      .where('e.createdAt >= :since', { since })
      .andWhere('e.success = true')
      .getRawOne<{ count: string }>();
    return Number(result?.count ?? 0);
  }
}
