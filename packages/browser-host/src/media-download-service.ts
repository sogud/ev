import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, readdir, rename, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  BrowserDownloadStatusSchema,
  BrowserSubtitleDownloadResultSchema,
  BrowserSubtitleResultSchema,
  type BrowserDownloadDispatch,
  type BrowserDownloadStatus,
  type BrowserSubtitleDownloadResult,
  type BrowserSubtitleResult,
} from '@ev/contracts';
import {
  defaultAddressResolver,
  resolvePublicAddresses,
  type AddressResolver,
} from './network-safety';
import { SafeMediaProxy } from './safe-media-proxy';

const MAX_JOBS = 100;
const MAX_CAPTURED_PATH_CHARS = 4_096;
const MAX_SUBTITLE_PROCESS_OUTPUT_CHARS = 16_384;
const SUBTITLE_TIMEOUT_MS = 120_000;
const LOCAL_ASR_TIMEOUT_MS = 30 * 60_000;

type ExternalDownload = Extract<BrowserDownloadDispatch, { backend: 'external' }>;
type SubtitleRequest = {
  pageUrl: string;
  title?: string;
  language?: string;
  includeAutomatic: boolean;
  format: 'vtt' | 'srt';
  maxChars: number;
  fallback: 'none' | 'local-asr';
  mediaUrl?: string;
  userAgent?: string;
};
type ProcessLauncher = (
  executable: string,
  args: string[],
  options: { stdio: ['pipe', 'pipe', 'pipe']; env: NodeJS.ProcessEnv }
) => ChildProcessWithoutNullStreams;

interface MediaDownloadServiceOptions {
  downloadDirectory: string;
  executable?: string;
  whisperExecutable?: string;
  whisperModel?: string;
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
  private readonly whisperExecutable: string;
  private readonly whisperModel?: string;

  constructor(private readonly options: MediaDownloadServiceOptions) {
    this.executable = options.executable ?? 'yt-dlp';
    this.launch = options.launch ?? (spawn as ProcessLauncher);
    this.resolveAddresses = options.resolveAddresses ?? defaultAddressResolver;
    this.whisperExecutable = options.whisperExecutable ?? 'whisper-cli';
    this.whisperModel =
      options.whisperModel ??
      process.env.EV_WHISPER_MODEL ??
      path.join(os.homedir(), '.ev', 'models', 'whisper', 'ggml-small.bin');
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

  async readSubtitles(request: SubtitleRequest): Promise<BrowserSubtitleResult> {
    try {
      const extracted = await this.extractSubtitle(request);
      const plainText = this.subtitleToPlainText(extracted.content);
      return BrowserSubtitleResultSchema.parse({
        pageUrl: request.pageUrl,
        title: request.title,
        source: 'subtitle',
        language: extracted.language,
        format: request.format,
        text: plainText.slice(0, request.maxChars),
        truncated: plainText.length > request.maxChars,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (request.fallback !== 'local-asr' || !message.startsWith('No matching subtitles')) {
        throw error;
      }
      return this.transcribeWithLocalAsr(request);
    }
  }

  async downloadSubtitles(request: SubtitleRequest): Promise<BrowserSubtitleDownloadResult> {
    const extracted = await this.extractSubtitle(request, true);
    return BrowserSubtitleDownloadResultSchema.parse({
      pageUrl: request.pageUrl,
      title: request.title,
      language: extracted.language,
      format: request.format,
      filename: extracted.filename,
    });
  }

  private async transcribeWithLocalAsr(request: SubtitleRequest): Promise<BrowserSubtitleResult> {
    if (!this.whisperModel) {
      throw new Error('Local ASR requires a whisper.cpp ggml model file');
    }
    await access(this.whisperModel).catch(() => {
      throw new Error(
        'Whisper model is missing; set EV_WHISPER_MODEL or install ggml-small.bin under ~/.ev/models/whisper/'
      );
    });
    const pageUrl = this.parseWebUrl(request.pageUrl);
    const audioUrl = request.mediaUrl ? this.parseWebUrl(request.mediaUrl) : pageUrl;
    await this.assertPublicMediaUrl(pageUrl);
    if (audioUrl !== pageUrl) await this.assertPublicMediaUrl(audioUrl);
    const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'ev-local-asr-'));
    const proxy = new SafeMediaProxy(this.resolveAddresses);
    await proxy.start();
    try {
      const audioTemplate = path.join(temporaryDirectory, 'audio.%(ext)s');
      const downloader = this.launch(
        await this.resolveExecutable(),
        [
          '--no-playlist',
          '--quiet',
          '--no-warnings',
          '--no-progress',
          '--extract-audio',
          ...(new URL(audioUrl).hostname.endsWith('youtube.com')
            ? ['--extractor-args', 'youtube:player_client=web_embedded']
            : []),
          '--audio-format',
          'wav',
          '--audio-quality',
          '0',
          '--output',
          audioTemplate,
          '--add-header',
          `Referer:${new URL(pageUrl).origin}/`,
          ...(request.userAgent ? ['--user-agent', request.userAgent] : []),
          '--proxy',
          proxy.endpoint,
          '--batch-file',
          '-',
        ],
        { stdio: ['pipe', 'pipe', 'pipe'], env: this.helperEnvironment(this.executable) }
      );
      await this.waitForProcess(downloader, audioUrl, SUBTITLE_TIMEOUT_MS, 'Audio extraction');
      const audioFile = (await readdir(temporaryDirectory)).find(file => file.endsWith('.wav'));
      if (!audioFile) throw new Error('Audio extraction produced no WAV file');

      const outputPrefix = path.join(temporaryDirectory, 'transcript');
      const whisper = this.launch(
        this.whisperExecutable,
        [
          '-m',
          this.whisperModel,
          '-f',
          path.join(temporaryDirectory, audioFile),
          '-l',
          request.language ?? 'auto',
          '-oj',
          '-of',
          outputPrefix,
          '-np',
        ],
        { stdio: ['pipe', 'pipe', 'pipe'], env: this.helperEnvironment(this.whisperExecutable) }
      );
      await this.waitForProcess(whisper, undefined, LOCAL_ASR_TIMEOUT_MS, 'Local ASR');
      const parsed = JSON.parse(await readFile(`${outputPrefix}.json`, 'utf8')) as {
        result?: { language?: string };
        transcription?: Array<{
          text?: string;
          offsets?: { from?: number; to?: number };
        }>;
      };
      const segments = (parsed.transcription ?? []).flatMap(segment => {
        const text = segment.text?.trim();
        if (!text) return [];
        return [
          {
            start: Math.max(0, (segment.offsets?.from ?? 0) / 1_000),
            end: Math.max(0, (segment.offsets?.to ?? 0) / 1_000),
            text,
          },
        ];
      });
      const text = segments.map(segment => segment.text).join('\n');
      return BrowserSubtitleResultSchema.parse({
        pageUrl: request.pageUrl,
        title: request.title,
        source: 'local-asr',
        language: parsed.result?.language ?? request.language ?? 'auto',
        format: 'text',
        text: text.slice(0, request.maxChars),
        segments,
        truncated: text.length > request.maxChars,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error('Local ASR requires whisper-cli from whisper.cpp on PATH');
      }
      throw error;
    } finally {
      await proxy.stop();
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }

  private helperEnvironment(executable: string): NodeJS.ProcessEnv {
    const executableDirectory = path.isAbsolute(executable) ? path.dirname(executable) : null;
    return {
      ...process.env,
      NO_PROXY: '',
      no_proxy: '',
      PATH: [executableDirectory, process.env.PATH].filter(Boolean).join(path.delimiter),
    };
  }

  private async waitForProcess(
    child: ChildProcessWithoutNullStreams,
    input: string | undefined,
    timeoutMs: number,
    label: string
  ): Promise<string> {
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    const append = (chunk: unknown): void => {
      output = `${output}${String(chunk)}`.slice(-MAX_SUBTITLE_PROCESS_OUTPUT_CHARS);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const close = new Promise<number | null>((resolve, reject) => {
      child.once('spawn', () => child.stdin.end(input === undefined ? undefined : `${input}\n`));
      child.once('error', reject);
      child.once('close', resolve);
    });
    let timeout: NodeJS.Timeout | undefined;
    try {
      const code = await Promise.race([
        close,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            child.kill();
            reject(new Error(`${label} timed out`));
          }, timeoutMs);
        }),
      ]);
      if (code !== 0) {
        const detail = output.trim();
        throw new Error(
          `${label} exited with code ${code ?? 'unknown'}${detail ? `: ${detail}` : ''}`
        );
      }
      return output;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private async extractSubtitle(
    request: SubtitleRequest,
    keepFile = false
  ): Promise<{ content: string; filename: string; language: string }> {
    const pageUrl = this.parseWebUrl(request.pageUrl);
    await this.assertPublicMediaUrl(pageUrl);
    const executable = await this.resolveExecutable();
    const executableDirectory = path.isAbsolute(executable) ? path.dirname(executable) : null;
    const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'ev-subtitles-'));
    const proxy = new SafeMediaProxy(this.resolveAddresses);
    await proxy.start();
    try {
      const args = [
        '--no-playlist',
        '--quiet',
        '--no-warnings',
        '--no-progress',
        '--windows-filenames',
        '--skip-download',
        '--write-subs',
        ...(request.includeAutomatic ? ['--write-auto-subs'] : []),
        '--sub-format',
        request.format,
        ...(request.language ? ['--sub-langs', request.language] : []),
        '--paths',
        temporaryDirectory,
        '--output',
        '%(title).120B [%(id)s].%(ext)s',
        '--proxy',
        proxy.endpoint,
        '--batch-file',
        '-',
      ];
      const child = this.launch(executable, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          NO_PROXY: '',
          no_proxy: '',
          PATH: [executableDirectory, process.env.PATH].filter(Boolean).join(path.delimiter),
        },
      });
      const processOutput = await this.waitForSubtitleProcess(child, pageUrl);
      const files = (await readdir(temporaryDirectory)).filter(file =>
        file.toLowerCase().endsWith(`.${request.format}`)
      );
      const selected = files.sort()[0];
      if (!selected) {
        const detail = processOutput.trim().split(/\r?\n/).filter(Boolean).at(-1);
        throw new Error(
          detail ? `No matching subtitles: ${detail}` : 'No matching subtitles found'
        );
      }
      const temporaryFilename = path.join(temporaryDirectory, selected);
      const content = await readFile(temporaryFilename, 'utf8');
      const language = this.subtitleLanguage(selected, request.format, request.language);
      if (!keepFile) return { content, filename: temporaryFilename, language };

      await mkdir(this.options.downloadDirectory, { recursive: true, mode: 0o700 });
      const destination = path.join(this.options.downloadDirectory, selected);
      const filename = await access(destination)
        .then(() =>
          path.join(
            this.options.downloadDirectory,
            `${path.basename(selected, `.${request.format}`)}-${randomUUID().slice(0, 8)}.${request.format}`
          )
        )
        .catch(() => destination);
      await rename(temporaryFilename, filename);
      return { content, filename, language };
    } finally {
      await proxy.stop();
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }

  private async waitForSubtitleProcess(
    child: ChildProcessWithoutNullStreams,
    pageUrl: string
  ): Promise<string> {
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    const append = (chunk: unknown): void => {
      output = `${output}${String(chunk)}`.slice(-MAX_SUBTITLE_PROCESS_OUTPUT_CHARS);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const close = new Promise<number | null>((resolve, reject) => {
      child.once('spawn', () => child.stdin.end(`${pageUrl}\n`));
      child.once('error', error => {
        reject(
          new Error(
            (error as NodeJS.ErrnoException).code === 'ENOENT'
              ? 'yt-dlp is not installed or is unavailable on PATH'
              : 'Unable to start yt-dlp'
          )
        );
      });
      child.once('close', resolve);
    });
    let timeout: NodeJS.Timeout | undefined;
    try {
      const code = await Promise.race([
        close,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            child.kill();
            reject(new Error('Subtitle extraction timed out'));
          }, SUBTITLE_TIMEOUT_MS);
        }),
      ]);
      if (code !== 0) throw new Error(`yt-dlp exited with code ${code ?? 'unknown'}`);
      return output;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private subtitleLanguage(filename: string, format: string, fallback?: string): string {
    const suffix = filename.match(new RegExp(`\\.([A-Za-z0-9._-]+)\\.${format}$`))?.[1];
    return suffix ?? fallback ?? 'default';
  }

  private subtitleToPlainText(content: string): string {
    const lines = content.replace(/^\uFEFF/, '').split(/\r?\n/);
    const plain: string[] = [];
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (
        !line ||
        line === 'WEBVTT' ||
        /^\d+$/.test(line) ||
        line.includes('-->') ||
        /^(Kind|Language|NOTE|STYLE|REGION):?/i.test(line)
      ) {
        continue;
      }
      const clean = line
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .trim();
      if (clean && clean !== plain.at(-1)) plain.push(clean);
    }
    return plain.join('\n');
  }

  private async startReserved(request: ExternalDownload): Promise<BrowserDownloadStatus> {
    await mkdir(this.options.downloadDirectory, { recursive: true, mode: 0o700 });
    const downloadId = `local:${randomUUID()}`;
    const pageUrl = this.parseWebUrl(request.pageUrl);
    const mediaUrl = this.parseWebUrl(request.url);
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

  private parseWebUrl(value: string): string {
    const parsed = URL.parse(value);
    if (!parsed) throw new Error('Invalid media URL');
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('Only HTTP(S) media URLs are supported');
    }
    return parsed.href;
  }

  private async assertPublicMediaUrl(value: string): Promise<void> {
    const parsed = URL.parse(this.parseWebUrl(value));
    if (!parsed) throw new Error('Invalid media URL');
    await resolvePublicAddresses(parsed.hostname, this.resolveAddresses);
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
