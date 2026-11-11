import { Repository } from 'typeorm';
import { ErrorReportEntity } from './entities/error-report.entity';
import { ReportRateLimitError, ReportService } from './report.service';

type MockRepository = {
  count: jest.Mock;
  existsBy: jest.Mock;
  create: jest.Mock;
  save: jest.Mock;
  update: jest.Mock;
  findOneBy: jest.Mock;
  find: jest.Mock;
};

function makeRepo(): MockRepository {
  return {
    count: jest.fn(),
    existsBy: jest.fn(),
    create: jest.fn((value: unknown) => value),
    save: jest.fn((value: Record<string, unknown>) =>
      Promise.resolve({
        ...value,
        id: '11111111-1111-1111-1111-111111111111',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      }),
    ),
    update: jest.fn(),
    findOneBy: jest.fn(),
    find: jest.fn(),
  };
}

function makeReport(
  overrides: Partial<ErrorReportEntity> = {},
): ErrorReportEntity {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    shortId: 'ABC123',
    userTelegramId: 42,
    username: 'jane',
    firstName: 'Jane',
    platform: 'tiktok',
    url: 'https://www.tiktok.com/@jane/video/123',
    errorCode: 'DOWNLOAD_FAILED',
    errorDetail: 'Provider returned an empty media list',
    description: 'The video never arrived.',
    status: 'open',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    resolvedAt: null,
    resolvedBy: null,
    resolvedByName: null,
    ...overrides,
  };
}

describe('ReportService', () => {
  let repo: MockRepository;
  let service: ReportService;

  beforeEach(() => {
    repo = makeRepo();
    service = new ReportService(
      repo as unknown as Repository<ErrorReportEntity>,
    );
  });

  it('creates a report with sanitized fields and a short id', async () => {
    repo.count.mockResolvedValue(0);
    repo.existsBy.mockResolvedValue(false);

    const report = await service.create({
      userTelegramId: 42,
      username: 'jane',
      firstName: 'Jane',
      platform: 'tiktok',
      url: 'https://www.tiktok.com/@jane/video/123',
      errorCode: 'DOWNLOAD_FAILED',
      errorDetail:
        'Fetch failed https://api.telegram.org/bot123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ/getMe',
      description: '  The video never arrived.  ',
    });

    expect(report.shortId).toHaveLength(6);
    expect(repo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        userTelegramId: 42,
        username: 'jane',
        platform: 'tiktok',
        description: 'The video never arrived.',
        status: 'open',
      }),
    );

    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const saved = repo.save.mock.calls[0][0] as ErrorReportEntity;
    expect(saved.errorDetail).not.toContain(
      '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    );
    expect(saved.errorDetail).toContain('/bot<redacted>');
  });

  it('rejects a second report inside the cooldown window', async () => {
    repo.count.mockResolvedValueOnce(1);

    await expect(
      service.create({
        userTelegramId: 42,
        description: 'Another one',
      }),
    ).rejects.toMatchObject({ kind: 'cooldown' });

    expect(repo.save).not.toHaveBeenCalled();
  });

  it('rejects after the daily limit', async () => {
    repo.count.mockResolvedValueOnce(0).mockResolvedValueOnce(5);

    await expect(
      service.create({
        userTelegramId: 42,
        description: 'Sixth report',
      }),
    ).rejects.toMatchObject({ kind: 'daily' });

    expect(repo.save).not.toHaveBeenCalled();
  });

  it('throws a ReportRateLimitError instance', async () => {
    repo.count.mockResolvedValueOnce(1);

    await expect(
      service.create({ userTelegramId: 42, description: 'Hello' }),
    ).rejects.toBeInstanceOf(ReportRateLimitError);
  });

  it('resolves an open report and records the admin', async () => {
    repo.update.mockResolvedValue({ affected: 1 });
    repo.findOneBy.mockResolvedValue(
      makeReport({
        status: 'resolved',
        resolvedBy: 7,
        resolvedByName: '@admin',
        resolvedAt: new Date('2026-01-01T01:00:00.000Z'),
      }),
    );

    const result = await service.resolve('#abc123', {
      id: 7,
      name: '@admin',
    });

    expect(result?.alreadyResolved).toBe(false);
    expect(repo.update).toHaveBeenCalledWith(
      { shortId: 'ABC123', status: 'open' },
      expect.objectContaining({
        status: 'resolved',
        resolvedBy: 7,
        resolvedByName: '@admin',
      }),
    );
  });

  it('reports an already-resolved report without updating it again', async () => {
    repo.update.mockResolvedValue({ affected: 0 });
    repo.findOneBy.mockResolvedValue(
      makeReport({ status: 'resolved', resolvedByName: '@admin' }),
    );

    const result = await service.resolve('ABC123', {
      id: 8,
      name: '@other',
    });

    expect(result?.alreadyResolved).toBe(true);
  });

  it('returns null for an unknown report', async () => {
    repo.update.mockResolvedValue({ affected: 0 });
    repo.findOneBy.mockResolvedValue(null);

    const result = await service.resolve('NOPE00', {
      id: 8,
      name: '@other',
    });

    expect(result).toBeNull();
  });
});
