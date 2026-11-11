import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThanOrEqual, Repository } from 'typeorm';
import { randomBytes } from 'crypto';
import { ErrorReportEntity } from './entities/error-report.entity';
import type { SocialPlatform } from '../download/providers/social-media-provider.interface';

const MAX_DESCRIPTION_LENGTH = 2000;
const MAX_ERROR_DETAIL_LENGTH = 500;
const MAX_URL_LENGTH = 2048;
const MAX_USERNAME_LENGTH = 255;
const MAX_FIRST_NAME_LENGTH = 255;
const SHORT_ID_BYTES = 3;
const SHORT_ID_ATTEMPTS = 5;
const REPORT_COOLDOWN_MS = 60_000;
const REPORT_DAILY_LIMIT = 5;
const DAILY_WINDOW_MS = 24 * 60 * 60 * 1000;

export type ErrorReportCode =
  | 'DOWNLOAD_FAILED'
  | 'NO_MEDIA'
  | 'TELEGRAM_FETCH_FAILED'
  | 'USER_REPORT';

export type CreateReportParams = {
  userTelegramId: number;
  username?: string | null;
  firstName?: string | null;
  platform?: SocialPlatform | null;
  url?: string | null;
  errorCode?: ErrorReportCode | null;
  errorDetail?: string | null;
  description?: string | null;
};

export class ReportRateLimitError extends Error {
  constructor(public readonly kind: 'cooldown' | 'daily') {
    super(`Report rate limit reached: ${kind}`);
    this.name = 'ReportRateLimitError';
  }
}

@Injectable()
export class ReportService {
  constructor(
    @InjectRepository(ErrorReportEntity)
    private readonly reportRepo: Repository<ErrorReportEntity>,
  ) {}

  async create(params: CreateReportParams): Promise<ErrorReportEntity> {
    const description = this.cleanText(
      this.redactSecrets(params.description ?? ''),
      MAX_DESCRIPTION_LENGTH,
    );
    const url = this.cleanUrl(params.url);

    if (!description && !url && !params.errorCode) {
      throw new BadRequestException(
        'A report needs a description, a link, or error context',
      );
    }

    await this.assertWithinRateLimit(params.userTelegramId);

    const report = this.reportRepo.create({
      shortId: await this.generateShortId(),
      userTelegramId: params.userTelegramId,
      username: this.cleanSingleLineOptional(
        params.username,
        MAX_USERNAME_LENGTH,
      ),
      firstName: this.cleanSingleLineOptional(
        params.firstName,
        MAX_FIRST_NAME_LENGTH,
      ),
      platform: params.platform ?? null,
      url,
      errorCode: params.errorCode ?? null,
      errorDetail: this.cleanSingleLineOptional(
        this.redactSecrets(params.errorDetail ?? ''),
        MAX_ERROR_DETAIL_LENGTH,
      ),
      description,
      status: 'open',
      resolvedAt: null,
      resolvedBy: null,
      resolvedByName: null,
    });

    return this.reportRepo.save(report);
  }

  async listOpen(limit = 10): Promise<ErrorReportEntity[]> {
    return this.reportRepo.find({
      where: { status: 'open' },
      order: { createdAt: 'DESC' },
      take: limit,
    });
  }

  async listAll(limit = 10): Promise<ErrorReportEntity[]> {
    return this.reportRepo.find({
      order: { createdAt: 'DESC' },
      take: limit,
    });
  }

  async findByShortId(shortId: string): Promise<ErrorReportEntity | null> {
    const normalized = this.normalizeShortId(shortId);
    if (!normalized) {
      return null;
    }
    return this.reportRepo.findOneBy({ shortId: normalized });
  }

  async resolve(
    shortId: string,
    admin: { id: number; name: string },
  ): Promise<{ report: ErrorReportEntity; alreadyResolved: boolean } | null> {
    const normalized = this.normalizeShortId(shortId);
    if (!normalized) {
      return null;
    }

    const result = await this.reportRepo.update(
      { shortId: normalized, status: 'open' },
      {
        status: 'resolved',
        resolvedAt: new Date(),
        resolvedBy: admin.id,
        resolvedByName: admin.name,
      },
    );

    const report = await this.reportRepo.findOneBy({ shortId: normalized });
    if (!report) {
      return null;
    }

    return {
      report,
      alreadyResolved: (result.affected ?? 0) === 0,
    };
  }

  private async assertWithinRateLimit(userTelegramId: number): Promise<void> {
    const now = Date.now();

    const recentCount = await this.reportRepo.count({
      where: {
        userTelegramId,
        createdAt: MoreThanOrEqual(new Date(now - REPORT_COOLDOWN_MS)),
      },
    });
    if (recentCount > 0) {
      throw new ReportRateLimitError('cooldown');
    }

    const dailyCount = await this.reportRepo.count({
      where: {
        userTelegramId,
        createdAt: MoreThanOrEqual(new Date(now - DAILY_WINDOW_MS)),
      },
    });
    if (dailyCount >= REPORT_DAILY_LIMIT) {
      throw new ReportRateLimitError('daily');
    }
  }

  private async generateShortId(): Promise<string> {
    for (let attempt = 0; attempt < SHORT_ID_ATTEMPTS; attempt += 1) {
      const shortId = randomBytes(SHORT_ID_BYTES).toString('hex').toUpperCase();
      const exists = await this.reportRepo.existsBy({ shortId });
      if (!exists) {
        return shortId;
      }
    }

    throw new Error('Could not generate a unique report ID');
  }

  private normalizeShortId(shortId: string): string | null {
    const normalized = shortId.trim().replace(/^#/, '').toUpperCase();
    return normalized.length > 0 ? normalized : null;
  }

  private cleanText(value: string, maxLength: number): string {
    return (
      value
        .replace(/\r\n?/g, '\n')
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
        .slice(0, maxLength)
    );
  }

  private cleanSingleLine(value: string, maxLength: number): string {
    return this.cleanText(value.replace(/\s+/g, ' '), maxLength);
  }

  private cleanSingleLineOptional(
    value: string | null | undefined,
    maxLength: number,
  ): string | null {
    if (!value) {
      return null;
    }
    const cleaned = this.cleanSingleLine(value, maxLength);
    return cleaned.length > 0 ? cleaned : null;
  }

  private cleanUrl(value: string | null | undefined): string | null {
    if (!value) {
      return null;
    }
    const trimmed = value.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_URL_LENGTH) {
      return null;
    }
    try {
      const url = new URL(trimmed);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return null;
      }
      return url.toString();
    } catch {
      return null;
    }
  }

  private redactSecrets(value: string): string {
    return value
      .replace(/\/bot[^/\s]+/gi, '/bot<redacted>')
      .replace(/\b\d{6,12}:[A-Za-z0-9_-]{20,}\b/g, '<redacted-token>');
  }
}
