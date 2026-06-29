import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserEntity } from './entities/user.entity';
import { DownloadEventEntity } from './entities/download-event.entity';
import { UserService } from './user.service';

@Module({
  imports: [TypeOrmModule.forFeature([UserEntity, DownloadEventEntity])],
  providers: [UserService],
  exports: [UserService],
})
export class UserModule {}
