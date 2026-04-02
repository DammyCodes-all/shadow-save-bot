import { Module } from '@nestjs/common';
import { DownloadService } from './download.service';

@Module({
  providers: [DownloadService]
})
export class DownloadModule {}
