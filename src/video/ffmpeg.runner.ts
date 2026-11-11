import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { spawn, type ChildProcess } from 'child_process';
import * as os from 'os';
import { VideoConfigService } from './video.config';
import { VideoExportError } from './video.types';

const STDERR_TAIL_BYTES = 8 * 1024;

function runOnce(
  binary: string,
  args: string[],
  timeoutMs: number,
): Promise<{ exitCode: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore kill failures; process already exited
        }
        resolve({ exitCode: null, stderr: stderr.slice(-STDERR_TAIL_BYTES) });
      }
    }, timeoutMs);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
      if (stderr.length > STDERR_TAIL_BYTES * 2) {
        stderr = stderr.slice(-STDERR_TAIL_BYTES * 2);
      }
    });
    child.on('error', () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ exitCode: null, stderr: stderr.slice(-STDERR_TAIL_BYTES) });
      }
    });
    child.on('close', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ exitCode: code, stderr: stderr.slice(-STDERR_TAIL_BYTES) });
      }
    });
  });
}

@Injectable()
export class FfmpegRunner implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FfmpegRunner.name);
  private readonly binary: string;
  private available = false;
  private readonly children = new Set<ChildProcess>();

  constructor(private readonly videoConfig: VideoConfigService) {
    this.binary = videoConfig.config.ffmpegPath ?? 'ffmpeg';
  }

  async onModuleInit(): Promise<void> {
    try {
      const { exitCode } = await runOnce(this.binary, ['-version'], 5000);
      this.available = exitCode === 0;
    } catch {
      this.available = false;
    }
    if (!this.available) {
      this.logger.warn(
        `ffmpeg not available at "${this.binary}". Video export is disabled.`,
      );
    }
  }

  isAvailable(): boolean {
    return this.available;
  }

  async probeDuration(file: string): Promise<number | null> {
    try {
      const { exitCode, stderr } = await runOnce(
        this.binary,
        ['-hide_banner', '-i', file],
        10000,
      );
      void exitCode;
      const match = /Duration:\s*(\d+):(\d+):([\d.]+)/.exec(stderr);
      if (!match) {
        return null;
      }
      const hours = Number(match[1]);
      const minutes = Number(match[2]);
      const seconds = Number(match[3]);
      if (
        !Number.isFinite(hours) ||
        !Number.isFinite(minutes) ||
        !Number.isFinite(seconds)
      ) {
        return null;
      }
      const total = hours * 3600 + minutes * 60 + seconds;
      return total > 0 ? total : null;
    } catch {
      return null;
    }
  }

  async run(args: string[], timeoutMs: number): Promise<void> {
    const child = spawn(this.binary, args, {
      shell: false,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    this.children.add(child);
    try {
      try {
        if (typeof child.pid === 'number') {
          os.setPriority(child.pid, 10);
        }
      } catch {
        // lowering priority is best-effort only
      }
      let stderr = '';
      const onData = (chunk: Buffer): void => {
        stderr += chunk.toString('utf8');
        if (stderr.length > STDERR_TAIL_BYTES * 2) {
          stderr = stderr.slice(-STDERR_TAIL_BYTES * 2);
        }
      };
      child.stderr?.on('data', onData);
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (!settled) {
            settled = true;
            try {
              child.kill('SIGKILL');
            } catch {
              // ignore
            }
            reject(
              new VideoExportError(
                'VIDEO_RENDER_FAILED',
                `ffmpeg timed out after ${timeoutMs}ms. ${stderr.slice(-STDERR_TAIL_BYTES)}`,
              ),
            );
          }
        }, timeoutMs);
        if (typeof timer.unref === 'function') {
          timer.unref();
        }
        child.on('error', (err) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(
              new VideoExportError(
                'VIDEO_RENDER_FAILED',
                'ffmpeg failed to start',
                {
                  cause: err,
                },
              ),
            );
          }
        });
        child.on('close', (code, signal) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            if (code === 0) {
              resolve();
            } else {
              const killed = code === null && signal ? ` by ${signal}` : '';
              const oomHint =
                signal === 'SIGKILL'
                  ? ' The process was killed, most likely out of memory — try VIDEO_PRESET=ultrafast or a smaller VIDEO_WIDTH/VIDEO_HEIGHT.'
                  : '';
              reject(
                new VideoExportError(
                  'VIDEO_RENDER_FAILED',
                  `ffmpeg exited${killed} with code ${code}.${oomHint} ${stderr.slice(-STDERR_TAIL_BYTES)}`,
                ),
              );
            }
          }
        });
      });
    } finally {
      this.children.delete(child);
    }
  }

  onModuleDestroy(): void {
    for (const child of this.children) {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore kill failures during shutdown
      }
    }
    this.children.clear();
  }
}
