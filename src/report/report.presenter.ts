import { Injectable } from '@nestjs/common';
import type { ErrorReportEntity } from './entities/error-report.entity';

const ALERT_DESCRIPTION_BUDGET = 1000;
const ALERT_DETAIL_BUDGET = 400;
const DETAIL_DESCRIPTION_BUDGET = 2200;
const DETAIL_ERROR_BUDGET = 800;
const MAX_LINK_LENGTH = 500;

@Injectable()
export class ReportPresenter {
  formatReportAlert(report: ErrorReportEntity): string {
    return this.formatReport(report, 'alert');
  }

  formatReportDetail(report: ErrorReportEntity): string {
    return this.formatReport(report, 'detail');
  }

  formatReportList(reports: ErrorReportEntity[], all = false): string {
    const title = all ? 'Recent reports' : 'Open reports';
    const lines = [`🛠 <b>${title}</b>`, ''];

    for (const report of reports) {
      const status = report.status === 'resolved' ? '✅' : '🟢';
      lines.push(
        `${status} <code>#${this.escape(report.shortId)}</code> · ` +
          `${this.escape(this.platformName(report.platform))} · ` +
          `${this.formatUserShort(report)} · ${this.formatAge(report.createdAt)}`,
      );
    }

    lines.push('');
    lines.push('Use <code>/reports &lt;short-id&gt;</code> for details.');
    return lines.join('\n');
  }

  private formatReport(
    report: ErrorReportEntity,
    mode: 'alert' | 'detail',
  ): string {
    const lines: string[] = [];
    const title = mode === 'alert' ? 'New error report' : 'Error report';

    lines.push(`🛠 <b>${title} #${this.escape(report.shortId)}</b>`);
    lines.push(`👤 ${this.formatUser(report)}`);
    lines.push(`📱 ${this.escape(this.platformName(report.platform))}`);

    if (report.errorCode) {
      lines.push(`🏷️ <code>${this.escape(report.errorCode)}</code>`);
    }

    if (report.url) {
      const display = this.shortUrl(report.url);
      if (report.url.length <= MAX_LINK_LENGTH) {
        lines.push(
          `🔗 <a href="${this.escapeAttribute(report.url)}">${this.escape(display)}</a>`,
        );
      } else {
        lines.push(`🔗 ${this.escape(display)}`);
      }
    }

    const descriptionBudget =
      mode === 'alert' ? ALERT_DESCRIPTION_BUDGET : DETAIL_DESCRIPTION_BUDGET;
    if (report.description) {
      lines.push(
        `💬 “${this.escapeAndTruncate(report.description, descriptionBudget)}”`,
      );
    }

    if (report.errorDetail) {
      const detailBudget =
        mode === 'alert' ? ALERT_DETAIL_BUDGET : DETAIL_ERROR_BUDGET;
      lines.push(
        `🧾 ${this.escapeAndTruncate(report.errorDetail, detailBudget)}`,
      );
    }

    if (mode === 'detail') {
      lines.push('');
      lines.push(`🕒 Created: ${this.formatDate(report.createdAt)}`);
      lines.push(`📌 Status: ${this.formatStatus(report)}`);
      if (report.status === 'resolved' && report.resolvedAt) {
        lines.push(`🕒 Resolved: ${this.formatDate(report.resolvedAt)}`);
      }
      lines.push(`🆔 Internal ID: <code>${this.escape(report.id)}</code>`);
    } else if (report.status === 'resolved') {
      lines.push('');
      lines.push(
        `✅ <b>Resolved</b>` +
          (report.resolvedByName
            ? ` by ${this.escape(report.resolvedByName)}`
            : '') +
          (report.resolvedAt ? ` · ${this.formatDate(report.resolvedAt)}` : ''),
      );
    }

    return lines.join('\n');
  }

  private formatUser(report: ErrorReportEntity): string {
    const id = this.escape(String(report.userTelegramId));
    if (report.username) {
      return `@${this.escape(report.username)} (<code>${id}</code>)`;
    }
    if (report.firstName) {
      return `${this.escape(report.firstName)} (<code>${id}</code>)`;
    }
    return `<code>${id}</code>`;
  }

  private formatUserShort(report: ErrorReportEntity): string {
    if (report.username) {
      return `@${this.escape(report.username)}`;
    }
    if (report.firstName) {
      return this.escape(report.firstName);
    }
    return `ID ${this.escape(String(report.userTelegramId))}`;
  }

  private platformName(platform: string | null): string {
    if (!platform) {
      return 'Unknown platform';
    }
    if (platform === 'tiktok') {
      return 'TikTok';
    }
    if (platform === 'twitter') {
      return 'Twitter/X';
    }
    if (platform === 'instagram') {
      return 'Instagram';
    }
    return platform;
  }

  private formatStatus(report: ErrorReportEntity): string {
    if (report.status === 'resolved') {
      return (
        '✅ Resolved' +
        (report.resolvedByName
          ? ` by ${this.escape(report.resolvedByName)}`
          : '')
      );
    }
    return '🟢 Open';
  }

  private formatAge(date: Date): string {
    const diffMs = Date.now() - new Date(date).getTime();
    const minutes = Math.max(0, Math.floor(diffMs / 60_000));
    if (minutes < 1) {
      return 'just now';
    }
    if (minutes < 60) {
      return `${minutes}m ago`;
    }
    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
      return `${hours}h ago`;
    }
    return `${Math.floor(hours / 24)}d ago`;
  }

  private formatDate(date: Date): string {
    return `${new Date(date).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
  }

  private shortUrl(url: string): string {
    return url.length > 80 ? `${url.slice(0, 77)}...` : url;
  }

  private escapeAndTruncate(value: string, maxLength: number): string {
    let escaped = '';
    for (const char of value) {
      const next = this.escape(char);
      if (escaped.length + next.length > maxLength) {
        return `${escaped}…`;
      }
      escaped += next;
    }
    return escaped;
  }

  private escape(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  private escapeAttribute(value: string): string {
    return this.escape(value).replace(/"/g, '&quot;');
  }
}
