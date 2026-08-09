import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  BrowserDownloadStatusSchema,
  type BrowserDownloadDispatch,
  type BrowserDownloadStatus,
} from '@ev/contracts';
import {
  defaultAddressResolver,
  resolvePublicAddresses,
  type AddressResolver,
} from './network-safety';
import { SafeMediaProxy } from './safe-media-proxy';

const MAX_JOBS = 100;
const MAX_CAPTURED_PATH_CHARS = 4_096;

type ExternalDownload = Extract<BrowserDownloadDispatch, { backend: 'external' }>;
type ProcessLauncher = (
  executable: string,
  args: string[],
  options: { stdio: ['pipe', 'pipe', 'pipe']; env: NodeJS.ProcessEnv }
) => ChildProcessWithoutNullStreams;

interface MediaDownloadServiceOptions {
  downloadDirectory: string;
  executable?: string;
  launch?: ProcessLauncher;
  resolveAddresses?: AddressResolver;
  maxJobs?: number;
}

interface DownloadJob extends BrowserDownloadStatus {
  process: ChildProcessWithoutNullStreams;
  proxy: SafeMediaProxy;
  output: string;
}

export class MediaDownloadService {
  private readonly jobs = new Map<string, DownloadJob>();
  private startingJobs = 0;
  private readonly executable: string;
  private readonly launch: ProcessLauncher;
  private readonly resolveAddresses: AddressResolver;

  constructor(private readonly options: MediaDownloadServiceOptions) {
    this.executable = options.executable ?? 'yt-dlp';
    this.launch = options.launch ?? (spawn as ProcessLauncher);
    this.resolveAddresses = options.resolveAddresses ?? defaultAddressResolver;
  }

  async start(request: ExternalDownload): Promise<BrowserDownloadStatus> {
    this.trimTerminalJobs();
    if (this.jobs.size + this.startingJobs >= (this.options.maxJobs ?? MAX_JOBS)) {
      throw new Error('Too many active media downloads');
    }
    this.startingJobs += 1;
    try {
      return await this.startReserved(request);
    } finally {
      this.startingJobs -= 1;
    }
  }

  private async startReserved(request: ExternalDownload): Promise<BrowserDownloadStatus> {
    await mkdir(this.options.downloadDirectory, { recursive: true, mode: 0o700 });
    const downloadId = `local:${randomUUID()}`;
    const pageUrl = new URL(request.pageUrl).href;
    const mediaUrl = new URL(request.url).href;
    await this.assertPublicMediaUrl(mediaUrl);
    const executable = await this.resolveExecutable();
    const executableDirectory = path.isAbsolute(executable) ? path.dirname(executable) : null;
    const proxy = new SafeMediaProxy(this.resolveAddresses);
    await proxy.start();
    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.launch(
        executable,
        [
          '--no-playlist',
          '--quiet',
          '--no-warnings',
          '--no-progress',
          '--windows-filenames',
          '--paths',
          this.options.downloadDirectory,
          '--output',
          '%(title).120B [%(id)s].%(ext)s',
          '--print',
          'after_move:filepath',
          '--referer',
          pageUrl,
          '--proxy',
          proxy.endpoint,
          '--batch-file',
          '-',
        ],
        {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: {
            ...process.env,
            NO_PROXY: '',
            no_proxy: '',
            PATH: [executableDirectory, process.env.PATH].filter(Boolean).join(path.delimiter),
          },
        }
      );
    } catch (error) {
      await proxy.stop();
      throw error;
    }
    const job: DownloadJob = {
      downloadId,
      backend: 'local',
      state: 'in_progress',
      process: child,
      proxy,
      output: '',
    };
    this.jobs.set(downloadId, job);

    child.stdout.setEncoding('utf8');
    child.stderr.resume();
    child.stdout.on('data', chunk => {
      job.output = `${job.output}${String(chunk)}`.slice(-MAX_CAPTURED_PATH_CHARS);
    });
    child.once('close', code => {
      void job.proxy.stop();
      if (job.state !== 'in_progress') return;
      if (code !== 0) {
        job.state = 'error';
        job.error = `yt-dlp exited with code ${code ?? 'unknown'}`;
        return;
      }
      const filename = job.output.trim().split(/\r?\n/).filter(Boolean).at(-1);
      if (!filename || !this.isInsideDownloadDirectory(filename)) {
        job.state = 'error';
        job.error = 'yt-dlp did not report a valid downloaded file';
        return;
      }
      job.state = 'complete';
      job.filename = path.resolve(filename);
    });

    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', error => {
        void job.proxy.stop();
        job.state = 'error';
        job.error =
          (error as NodeJS.ErrnoException).code === 'ENOENT'
            ? 'yt-dlp is not installed or is unavailable on PATH'
            : 'Unable to start yt-dlp';
        reject(new Error(job.error));
      });
    });
    child.stdin.end(`${mediaUrl}\n`);
    return this.status(downloadId);
  }

  status(downloadId: string): BrowserDownloadStatus {
    const job = this.jobs.get(downloadId);
    if (!job) throw new Error(`Download not found: ${downloadId}`);
    return BrowserDownloadStatusSchema.parse({
      downloadId: job.downloadId,
      backend: job.backend,
      state: job.state,
      ...(job.filename ? { filename: job.filename } : {}),
      ...(job.error ? { error: job.error } : {}),
    });
  }

  dispose(): void {
    for (const job of this.jobs.values()) {
      if (job.state !== 'in_progress') continue;
      job.state = 'interrupted';
      job.error = 'Browser Host stopped before the download completed';
      job.process.kill();
      void job.proxy.stop();
    }
  }

  private async assertPublicMediaUrl(value: string): Promise<void> {
    await resolvePublicAddresses(new URL(value).hostname, this.resolveAddresses);
  }

  private async resolveExecutable(): Promise<string> {
    if (this.options.launch || this.options.executable) return this.executable;
    const executableName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
    const pathDirectories = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
    const candidates = [
      ...pathDirectories.map(directory => path.join(directory, executableName)),
      path.join(os.homedir(), '.local', 'bin', executableName),
      path.join('/opt/homebrew/bin', executableName),
      path.join('/usr/local/bin', executableName),
    ];
    for (const candidate of candidates) {
      try {
        await access(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Continue through the fixed executable search path.
      }
    }
    return executableName;
  }

  private isInsideDownloadDirectory(filename: string): boolean {
    const directory = `${path.resolve(this.options.downloadDirectory)}${path.sep}`;
    return path.resolve(filename).startsWith(directory);
  }

  private trimTerminalJobs(): void {
    while (this.jobs.size >= (this.options.maxJobs ?? MAX_JOBS)) {
      const terminal = [...this.jobs.entries()].find(([, job]) => job.state !== 'in_progress');
      if (!terminal) return;
      this.jobs.delete(terminal[0]);
    }
  }
}
