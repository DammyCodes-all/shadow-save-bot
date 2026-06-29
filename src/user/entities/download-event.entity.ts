import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { UserEntity } from './user.entity';

@Entity('shadow_save_download_events')
export class DownloadEventEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'bigint', name: 'user_telegram_id' })
  userTelegramId: number;

  @ManyToOne(() => UserEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_telegram_id', referencedColumnName: 'telegramId' })
  user: UserEntity;

  @Column({ type: 'varchar', length: 20 })
  platform: string;

  @Column({ type: 'varchar', length: 20, nullable: true, name: 'media_type' })
  mediaType: string | null;

  @Column({ type: 'text' })
  url: string;

  @Column({ type: 'boolean', default: true })
  success: boolean;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
