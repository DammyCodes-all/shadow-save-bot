import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('shadow_save_users')
export class UserEntity {
  @PrimaryColumn({ type: 'bigint' })
  telegramId: number;

  @Column({ type: 'varchar', length: 255, nullable: true })
  username: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'first_name' })
  firstName: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'last_name' })
  lastName: string | null;

  @Column({ type: 'varchar', length: 10, nullable: true, name: 'language_code' })
  languageCode: string | null;

  @CreateDateColumn({ name: 'first_seen_at' })
  firstSeenAt: Date;

  @UpdateDateColumn({ name: 'last_seen_at' })
  lastSeenAt: Date;

  @Column({ type: 'int', default: 0, name: 'total_downloads' })
  totalDownloads: number;

  @Column({ type: 'boolean', default: false, name: 'is_banned' })
  isBanned: boolean;

  @Column({ type: 'boolean', default: false, name: 'opt_out' })
  optOut: boolean;
}
