import { ConfigService } from '@nestjs/config';
import { Telegraf } from 'telegraf';
import { ErrorReportEntity } from './entities/error-report.entity';
import { ReportNotifierService } from './report-notifier.service';
import { ReportPresenter } from './report.presenter';

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

describe('ReportNotifierService', () => {
  it('sends an alert with a resolve button to every admin', async () => {
    const sendMessage = jest.fn().mockResolvedValue({});
    const bot = {
      telegram: { sendMessage },
    } as unknown as Telegraf;
    const config = {
      get: jest.fn().mockReturnValue([11, 22]),
    } as unknown as ConfigService;

    const service = new ReportNotifierService(
      bot,
      config,
      new ReportPresenter(),
    );

    await service.notify(makeReport());

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenCalledWith(
      11,
      expect.stringContaining('#ABC123'),
      expect.objectContaining({
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: '✅ Mark resolved',
                callback_data: 'report:resolve:ABC123',
              },
            ],
          ],
        },
      }),
    );
  });

  it('does not reject when one admin cannot be reached', async () => {
    const sendMessage = jest
      .fn()
      .mockRejectedValueOnce(new Error('403: bot was blocked by the user'))
      .mockResolvedValueOnce({});
    const bot = {
      telegram: { sendMessage },
    } as unknown as Telegraf;
    const config = {
      get: jest.fn().mockReturnValue([11, 22]),
    } as unknown as ConfigService;

    const service = new ReportNotifierService(
      bot,
      config,
      new ReportPresenter(),
    );

    await expect(service.notify(makeReport())).resolves.toBeUndefined();
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it('does nothing when there are no admins configured', async () => {
    const sendMessage = jest.fn();
    const bot = {
      telegram: { sendMessage },
    } as unknown as Telegraf;
    const config = {
      get: jest.fn().mockReturnValue([]),
    } as unknown as ConfigService;

    const service = new ReportNotifierService(
      bot,
      config,
      new ReportPresenter(),
    );

    await service.notify(makeReport());

    expect(sendMessage).not.toHaveBeenCalled();
  });
});
