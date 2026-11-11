import { ErrorReportEntity } from './entities/error-report.entity';
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

describe('ReportPresenter', () => {
  const presenter = new ReportPresenter();

  it('escapes user-controlled text in the admin alert', () => {
    const message = presenter.formatReportAlert(
      makeReport({
        username: 'jane<script>',
        description: '<b>not bold</b> & not an entity',
      }),
    );

    expect(message).toContain('&lt;script&gt;');
    expect(message).toContain('&lt;b&gt;not bold&lt;/b&gt;');
    expect(message).toContain('&amp; not an entity');
    expect(message).not.toContain('<script>');
    expect(message).not.toContain('<b>not bold</b>');
  });

  it('includes the report id, status, and link in the detail view', () => {
    const message = presenter.formatReportDetail(
      makeReport({ status: 'resolved', resolvedByName: '@admin' }),
    );

    expect(message).toContain('#ABC123');
    expect(message).toContain('✅ Resolved by @admin');
    expect(message).toContain('https://www.tiktok.com');
  });

  it('lists reports with a short age', () => {
    const message = presenter.formatReportList([
      makeReport({ createdAt: new Date() }),
    ]);

    expect(message).toContain('Open reports');
    expect(message).toContain('#ABC123');
    expect(message).toContain('@jane');
    expect(message).toContain('just now');
  });
});
