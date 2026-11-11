import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectBot } from 'nestjs-telegraf';
import { Telegraf } from 'telegraf';
import type { ErrorReportEntity } from './entities/error-report.entity';
import { ReportPresenter } from './report.presenter';

@Injectable()
export class ReportNotifierService {
  private readonly logger = new Logger(ReportNotifierService.name);

  constructor(
    @InjectBot() private readonly bot: Telegraf,
    private readonly configService: ConfigService,
    private readonly presenter: ReportPresenter,
  ) {}

  async notify(report: ErrorReportEntity): Promise<void> {
    const adminIds = this.configService.get<number[]>('ADMIN_IDS') ?? [];

    if (adminIds.length === 0) {
      this.logger.warn(
        `No ADMIN_IDS configured; report ${report.shortId} was saved without notification`,
      );
      return;
    }

    const text = this.presenter.formatReportAlert(report);
    const replyMarkup = {
      inline_keyboard: [
        [
          {
            text: '✅ Mark resolved',
            callback_data: `report:resolve:${report.shortId}`,
          },
        ],
      ],
    };

    const results = await Promise.allSettled(
      adminIds.map((adminId) =>
        this.bot.telegram.sendMessage(adminId, text, {
          parse_mode: 'HTML',
          reply_markup: replyMarkup,
          link_preview_options: { is_disabled: true },
        }),
      ),
    );

    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        const message =
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason);
        this.logger.warn(
          `Failed to notify admin ${adminIds[index]} about report ${report.shortId}: ${message}`,
        );
      }
    });
  }
}
