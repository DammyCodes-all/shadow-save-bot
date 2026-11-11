import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

const bigintTransformer = {
  to: (value: number | null): number | null => value,
  from: (value: string | null | undefined): number | null =>
    value === null || value === undefined ? null : Number(value),
};

@Entity('shadow_save_error_reports')
@Index('idx_shadow_save_error_reports_status_created', ['status', 'createdAt'])
@Index('idx_shadow_save_error_reports_user_created', [
  'userTelegramId',
  'createdAt',
])
export class ErrorReportEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('ux_shadow_save_error_reports_short_id', { unique: true })
  @Column({ type: 'varchar', length: 10, name: 'short_id' })
  shortId: string;

  @Column({
    type: 'bigint',
    name: 'user_telegram_id',
    transformer: bigintTransformer,
  })
  userTelegramId: number;

  @Column({ type: 'varchar', length: 255, nullable: true })
  username: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'first_name' })
  firstName: string | null;

  @Column({ type: 'varchar', length: 20, nullable: true })
  platform: string | null;

  @Column({ type: 'text', nullable: true })
  url: string | null;

  @Column({ type: 'varchar', length: 50, nullable: true, name: 'error_code' })
  errorCode: string | null;

  @Column({ type: 'text', nullable: true, name: 'error_detail' })
  errorDetail: string | null;

  @Column({ type: 'text' })
  description: string;

  @Column({ type: 'varchar', length: 20, default: 'open' })
  status: 'open' | 'resolved';

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;

  @Column({ type: 'timestamptz', nullable: true, name: 'resolved_at' })
  resolvedAt: Date | null;

  @Column({
    type: 'bigint',
    nullable: true,
    name: 'resolved_by',
    transformer: bigintTransformer,
  })
  resolvedBy: number | null;

  @Column({
    type: 'varchar',
    length: 255,
    nullable: true,
    name: 'resolved_by_name',
  })
  resolvedByName: string | null;
}
