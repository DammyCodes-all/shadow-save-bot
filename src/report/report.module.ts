import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ErrorReportEntity } from './entities/error-report.entity';
import { ReportNotifierService } from './report-notifier.service';
import { ReportPresenter } from './report.presenter';
import { ReportService } from './report.service';

@Module({
  imports: [ConfigModule, TypeOrmModule.forFeature([ErrorReportEntity])],
  providers: [ReportService, ReportPresenter, ReportNotifierService],
  exports: [ReportService, ReportPresenter, ReportNotifierService],
})
export class ReportModule {}
