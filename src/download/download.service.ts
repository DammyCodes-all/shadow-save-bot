import { Injectable } from '@nestjs/common';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';

@Injectable()
export class DownloadService {
	getVideoStream(url: string): Readable {
		const process = spawn('yt-dlp', ['-o', '-', url], {
			stdio: ['ignore', 'pipe', 'pipe'],
		});

		if (!process.stdout) {
			throw new Error('Failed to open yt-dlp output stream');
		}

		let stderr = '';

		process.stderr?.on('data', (chunk: Buffer) => {
			stderr += chunk.toString();
		});

		process.on('error', () => {
			process.stdout?.destroy(new Error('yt-dlp process failed to start'));
		});

		process.on('close', (code) => {
			if (code !== 0) {
				process.stdout?.destroy(
					new Error(`yt-dlp failed with exit code ${code}: ${stderr.trim()}`),
				);
			}
		});

		return process.stdout;
	}
}
