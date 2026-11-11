import { Context } from 'telegraf';
import { BotUpdate } from './bot.update';

type BotUpdateInternals = {
  reportDrafts: Map<number, { contextToken: string | null; createdAt: number }>;
  reportContexts: Map<
    string,
    {
      userId: number;
      url: string | null;
      platform: string | null;
      errorCode: string;
      errorDetail: string | null;
      createdAt: number;
    }
  >;
  pruneExpiredReportDrafts(): void;
  submitReport(
    ctx: Context,
    rawDescription: string,
    context: null,
  ): Promise<boolean>;
};

function makeBotService() {
  return {
    isAdmin: jest.fn().mockReturnValue(false),
    getBannedMessage: jest.fn().mockReturnValue('banned'),
    getReportPromptMessage: jest.fn().mockReturnValue('prompt'),
    getReportContextPromptMessage: jest.fn().mockReturnValue('context prompt'),
    getReportSkipMarkup: jest.fn().mockReturnValue({}),
    getReportExpiredMessage: jest.fn().mockReturnValue('expired'),
    getReportNothingToSkipMessage: jest.fn().mockReturnValue('nothing to skip'),
    getReportSkipNeedsDescriptionMessage: jest
      .fn()
      .mockReturnValue('needs description'),
    getReportThanksMessage: jest.fn().mockReturnValue('thanks'),
    getReportRateLimitMessage: jest.fn().mockReturnValue('rate limited'),
    getReportSaveFailedMessage: jest.fn().mockReturnValue('save failed'),
    getWelcomeMessage: jest.fn().mockReturnValue('welcome'),
  };
}

function makeUpdate() {
  const botService = makeBotService();
  const userService = {
    isBanned: jest.fn().mockResolvedValue(false),
    recordUser: jest.fn().mockResolvedValue(undefined),
  };
  const reportService = {
    create: jest.fn(),
  };
  const reportNotifier = {
    notify: jest.fn().mockResolvedValue(undefined),
  };

  const update = new BotUpdate(
    botService as never,
    {} as never,
    userService as never,
    {} as never,
    reportService as never,
    reportNotifier as never,
    {} as never,
    { isAvailable: () => false } as never,
    { get: () => null, create: () => null, delete: () => {} } as never,
  );

  return {
    update,
    internals: update as unknown as BotUpdateInternals,
    botService,
    userService,
    reportService,
    reportNotifier,
  };
}

function makeContext(data = '') {
  const reply = jest.fn().mockResolvedValue({});
  const answerCbQuery = jest.fn().mockResolvedValue(true);
  const editMessageReplyMarkup = jest.fn().mockResolvedValue(true);

  const ctx = {
    from: { id: 42, username: 'jane', first_name: 'Jane' },
    reply,
    answerCbQuery,
    editMessageReplyMarkup,
    callbackQuery: { data },
  };

  return {
    ctx: ctx as unknown as Context,
    reply,
    answerCbQuery,
    editMessageReplyMarkup,
  };
}

function makeContextEntry(userId = 42) {
  return {
    userId,
    url: 'https://www.tiktok.com/@jane/video/123',
    platform: 'tiktok',
    errorCode: 'DOWNLOAD_FAILED',
    errorDetail: 'Provider returned an empty media list',
    createdAt: Date.now(),
  };
}

describe('BotUpdate report flow', () => {
  it('keeps a plain /report draft when the user sends /skip', async () => {
    const { update, internals, botService } = makeUpdate();
    const { ctx, reply } = makeContext();

    internals.reportDrafts.set(42, {
      contextToken: null,
      createdAt: Date.now(),
    });

    await update.onSkip(ctx);

    expect(botService.getReportSkipNeedsDescriptionMessage).toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith('needs description');
    expect(internals.reportDrafts.has(42)).toBe(true);
  });

  it('does not cancel a newer draft when a stale Skip button is tapped', async () => {
    const { update, internals } = makeUpdate();
    const { ctx, answerCbQuery } = makeContext('report:skip:token-a');

    internals.reportDrafts.set(42, {
      contextToken: 'token-b',
      createdAt: Date.now(),
    });
    internals.reportContexts.set('token-a', makeContextEntry());

    await update.onReportSkipAction(ctx);

    expect(answerCbQuery).toHaveBeenCalledWith('expired');
    expect(internals.reportDrafts.get(42)?.contextToken).toBe('token-b');
  });

  it('treats a saved report as successful even if the confirmation reply fails', async () => {
    const { internals, reportService, reportNotifier } = makeUpdate();
    const { ctx, reply } = makeContext();
    const report = { shortId: 'ABC123' };

    reportService.create.mockResolvedValue(report);
    reply.mockRejectedValueOnce(new Error('network down'));

    const saved = await internals.submitReport(
      ctx,
      'The video never arrived.',
      null,
    );

    expect(saved).toBe(true);
    expect(reportNotifier.notify).toHaveBeenCalledWith(report);
  });

  it('clears an in-progress report on /start', async () => {
    const { update, internals } = makeUpdate();
    const { ctx, reply } = makeContext();

    internals.reportDrafts.set(42, {
      contextToken: 'token-a',
      createdAt: Date.now(),
    });
    internals.reportContexts.set('token-a', makeContextEntry());

    await update.onStart(ctx);

    expect(internals.reportDrafts.has(42)).toBe(false);
    expect(internals.reportContexts.has('token-a')).toBe(false);
    expect(reply).toHaveBeenCalledWith('welcome');
  });

  it('sweeps expired drafts without touching fresh ones', () => {
    const { internals } = makeUpdate();
    const now = Date.now();

    internals.reportDrafts.set(1, {
      contextToken: null,
      createdAt: now - 31 * 60 * 1000,
    });
    internals.reportDrafts.set(2, {
      contextToken: null,
      createdAt: now,
    });

    internals.pruneExpiredReportDrafts();

    expect(internals.reportDrafts.has(1)).toBe(false);
    expect(internals.reportDrafts.has(2)).toBe(true);
  });
});
