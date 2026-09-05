import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MediaDownloadService } from '../media-download-service';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true })));
});

function fakeProcess(): ChildProcessWithoutNullStreams {
  const process = new EventEmitter() as ChildProcessWithoutNullStreams;
  process.stdin = new PassThrough();
  process.stdout = new PassThrough();
  process.stderr = new PassThrough();
  process.kill = vi.fn(() => true);
  return process;
}

describe('MediaDownloadService', () => {
  it('extracts a bounded plain-text transcript without exposing the page URL in arguments', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ev-media-download-'));
    directories.push(root);
    const child = fakeProcess();
    let input = '';
    const stdin = child.stdin as PassThrough;
    stdin.setEncoding('utf8');
    stdin.on('data', chunk => {
      input += String(chunk);
    });
    const launch = vi.fn((_executable: string, args: string[]) => {
      const temporaryDirectory = args[args.indexOf('--paths') + 1];
      queueMicrotask(async () => {
        child.emit('spawn');
        await writeFile(
          path.join(temporaryDirectory, 'Example [abc].en.vtt'),
          'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHello\n\n00:00:01.000 --> 00:00:02.000\nHello\nworld\n'
        );
        child.emit('close', 0);
      });
      return child;
    });
    const service = new MediaDownloadService({
      downloadDirectory: path.join(root, 'Downloads', 'EV'),
      launch,
      resolveAddresses: async () => ['93.184.216.34'],
    });

    await expect(
      service.readSubtitles({
        pageUrl: 'https://example.com/watch?signature=secret',
        title: 'Example',
        language: 'en',
        includeAutomatic: true,
        format: 'vtt',
        maxChars: 100_000,
        fallback: 'none',
      })
    ).resolves.toEqual({
      pageUrl: 'https://example.com/watch?signature=secret',
      title: 'Example',
      source: 'subtitle',
      language: 'en',
      format: 'vtt',
      text: 'Hello\nworld',
      truncated: false,
    });
    const [, args] = launch.mock.calls[0];
    expect(args).toContain('--write-auto-subs');
    expect(args).toContain('--proxy');
    expect(args.join(' ')).not.toContain('signature=secret');
    expect(input).toBe('https://example.com/watch?signature=secret\n');
  });

  it('reads Bilibili AI subtitles for the requested multi-part page without exposing the URL in process arguments', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ev-media-download-'));
    directories.push(root);
    const child = fakeProcess();
    let input = '';
    const stdin = child.stdin as PassThrough;
    stdin.setEncoding('utf8');
    stdin.on('data', chunk => {
      input += String(chunk);
    });
    const launch = vi.fn((_executable: string, args: string[]) => {
      const cookieFile = args[args.indexOf('--cookies') + 1];
      queueMicrotask(async () => {
        child.emit('spawn');
        await writeFile(
          cookieFile,
          '#HttpOnly_.bilibili.com\tTRUE\t/\tFALSE\t0\tSESSDATA\tsecret-cookie\n'
        );
        child.emit('close', 0);
      });
      return child;
    });
    const service = new MediaDownloadService({
      downloadDirectory: path.join(root, 'Downloads', 'EV'),
      launch,
      resolveAddresses: async () => ['93.184.216.34'],
    });
    const requestJson = vi.spyOn(
      service as unknown as {
        bilibiliRequest(url: string, cookieHeader: string): Promise<Record<string, unknown>>;
      },
      'bilibiliRequest'
    );
    requestJson.mockImplementation(async url => {
      if (url.includes('/x/web-interface/view')) {
        return {
          code: 0,
          data: {
            cid: 101,
            pages: [
              { page: 1, cid: 101 },
              { page: 2, cid: 202 },
            ],
          },
        };
      }
      if (url.includes('/x/player/wbi/v2')) {
        return {
          code: 0,
          data: {
            subtitle: {
              subtitles: [
                {
                  id: 1,
                  lan: 'ai-zh',
                  lan_doc: '中文（自动生成）',
                  subtitle_url: '//subtitle.example.com/ai-zh.json',
                },
              ],
            },
          },
        };
      }
      return {
        body: [
          { from: 0, to: 1.25, content: '第二集' },
          { from: 1.25, to: 2.5, content: 'AI 字幕' },
        ],
      };
    });

    await expect(
      service.readSubtitles({
        pageUrl: 'https://www.bilibili.com/video/BV1234567890/?p=2&secret=query',
        language: 'ai-zh',
        includeAutomatic: true,
        format: 'vtt',
        maxChars: 100_000,
        fallback: 'none',
        cookiesFromBrowser: 'chrome',
      })
    ).resolves.toMatchObject({
      source: 'subtitle',
      language: 'ai-zh',
      text: '第二集\nAI 字幕',
    });

    const [, args] = launch.mock.calls[0];
    expect(args).toContain('--batch-file');
    expect(args.join(' ')).not.toContain('secret=query');
    expect(input).toBe('https://www.bilibili.com/video/BV1234567890/?p=2&secret=query\n');
    expect(requestJson.mock.calls.some(([url]) => url.includes('cid=202'))).toBe(true);
    expect(
      requestJson.mock.calls.find(([url]) => url.includes('subtitle.example.com'))?.[1]
    ).toBeUndefined();
  });

  it('falls back to yt-dlp when the Bilibili API path fails', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ev-media-download-'));
    directories.push(root);
    const processes = [fakeProcess(), fakeProcess()];
    const launch = vi.fn((_executable: string, args: string[]) => {
      const index = launch.mock.calls.length - 1;
      const child = processes[index];
      queueMicrotask(async () => {
        child.emit('spawn');
        if (index === 0) {
          const cookieFile = args[args.indexOf('--cookies') + 1];
          await writeFile(
            cookieFile,
            '#HttpOnly_.bilibili.com\tTRUE\t/\tFALSE\t0\tSESSDATA\tsecret-cookie\n'
          );
        } else {
          const temporaryDirectory = args[args.indexOf('--paths') + 1];
          await writeFile(
            path.join(temporaryDirectory, 'Fallback [abc].ai-zh.vtt'),
            'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nFallback subtitle\n'
          );
        }
        child.emit('close', 0);
      });
      return child;
    });
    const service = new MediaDownloadService({
      downloadDirectory: path.join(root, 'Downloads', 'EV'),
      launch,
      resolveAddresses: async () => ['93.184.216.34'],
    });
    vi.spyOn(
      service as unknown as {
        bilibiliRequest(url: string, cookieHeader: string): Promise<Record<string, unknown>>;
      },
      'bilibiliRequest'
    ).mockRejectedValue(new Error('temporary Bilibili failure'));

    await expect(
      service.readSubtitles({
        pageUrl: 'https://www.bilibili.com/video/BV1234567890/',
        language: 'ai-zh',
        includeAutomatic: true,
        format: 'vtt',
        maxChars: 100_000,
        fallback: 'none',
        cookiesFromBrowser: 'chrome',
      })
    ).resolves.toMatchObject({ source: 'subtitle', text: 'Fallback subtitle' });
    expect(launch).toHaveBeenCalledTimes(2);
  });

  it('requires an explicit local whisper model before running ASR fallback', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ev-media-download-'));
    directories.push(root);
    const child = fakeProcess();
    const service = new MediaDownloadService({
      downloadDirectory: path.join(root, 'Downloads', 'EV'),
      whisperModel: path.join(root, 'missing-model.bin'),
      launch: () => {
        queueMicrotask(() => {
          child.emit('spawn');
          child.emit('close', 0);
        });
        return child;
      },
      resolveAddresses: async () => ['93.184.216.34'],
    });

    await expect(
      service.readSubtitles({
        pageUrl: 'https://example.com/watch',
        language: 'en',
        includeAutomatic: true,
        format: 'vtt',
        maxChars: 100_000,
        fallback: 'local-asr',
      })
    ).rejects.toThrow('Whisper model is missing');
  });

  it('uses a browser-observed audio URL for local ASR without forwarding credentials', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ev-media-download-'));
    directories.push(root);
    const model = path.join(root, 'model.bin');
    await writeFile(model, 'model');
    const processes = [fakeProcess(), fakeProcess(), fakeProcess()];
    const inputs: string[] = ['', '', ''];
    const launch = vi.fn((_executable: string, args: string[]) => {
      const index = launch.mock.calls.length - 1;
      const child = processes[index];
      const stdin = child.stdin as PassThrough;
      stdin.setEncoding('utf8');
      stdin.on('data', chunk => {
        inputs[index] += String(chunk);
      });
      queueMicrotask(async () => {
        child.emit('spawn');
        if (index === 1) {
          const output = args[args.indexOf('--output') + 1].replace('%(ext)s', 'wav');
          await writeFile(output, 'audio');
        }
        if (index === 2) {
          const outputPrefix = args[args.indexOf('-of') + 1];
          await writeFile(
            `${outputPrefix}.json`,
            JSON.stringify({
              result: { language: 'en' },
              transcription: [{ text: 'Hello', offsets: { from: 0, to: 1200 } }],
            })
          );
        }
        child.emit('close', 0);
      });
      return child;
    });
    const service = new MediaDownloadService({
      downloadDirectory: path.join(root, 'Downloads', 'EV'),
      whisperModel: model,
      launch,
      resolveAddresses: async () => ['93.184.216.34'],
    });

    await expect(
      service.readSubtitles({
        pageUrl: 'https://example.com/watch?private=page',
        mediaUrl: 'https://media.example.com/audio.m4a?signature=secret',
        userAgent: 'EV Test Browser',
        language: 'auto',
        includeAutomatic: true,
        format: 'vtt',
        maxChars: 100_000,
        fallback: 'local-asr',
      })
    ).resolves.toMatchObject({ source: 'local-asr', text: 'Hello', language: 'en' });

    const [, audioArgs] = launch.mock.calls[1];
    expect(audioArgs).toContain('Referer:https://example.com/');
    expect(audioArgs).toContain('EV Test Browser');
    expect(audioArgs.join(' ')).not.toContain('signature=secret');
    expect(audioArgs.join(' ')).not.toContain('private=page');
    expect(inputs[1]).toBe('https://media.example.com/audio.m4a?signature=secret\n');
  });

  it('starts a bounded yt-dlp job without exposing the media URL in process arguments', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ev-media-download-'));
    directories.push(root);
    const downloadDirectory = path.join(root, 'Downloads', 'EV');
    const child = fakeProcess();
    let input = '';
    const stdin = child.stdin as PassThrough;
    const stdout = child.stdout as PassThrough;
    stdin.setEncoding('utf8');
    stdin.on('data', chunk => {
      input += String(chunk);
    });
    const launch = vi.fn(
      (
        _executable: string,
        _args: string[],
        _options: { stdio: ['pipe', 'pipe', 'pipe']; env: NodeJS.ProcessEnv }
      ) => {
        queueMicrotask(() => child.emit('spawn'));
        return child;
      }
    );
    const service = new MediaDownloadService({
      downloadDirectory,
      launch,
      resolveAddresses: async () => ['93.184.216.34'],
    });

    const started = await service.start({
      backend: 'external',
      mediaKind: 'stream',
      pageUrl: 'https://example.com/watch',
      url: 'https://cdn.example.com/master.m3u8?signature=secret',
    });

    expect(started).toMatchObject({ backend: 'local', state: 'in_progress' });
    const [, args, processOptions] = launch.mock.calls[0];
    expect(args).toContain('--batch-file');
    expect(args).toContain('--proxy');
    expect(processOptions.env).toMatchObject({ NO_PROXY: '', no_proxy: '' });
    expect(args.join(' ')).not.toContain('signature=secret');
    expect(input).toBe('https://cdn.example.com/master.m3u8?signature=secret\n');

    const filename = path.join(downloadDirectory, 'video.mp4');
    stdout.write(`${filename}\n`);
    child.emit('close', 0);
    await new Promise(resolve => setImmediate(resolve));
    expect(service.status(started.downloadId)).toEqual({
      downloadId: started.downloadId,
      backend: 'local',
      state: 'complete',
      filename,
    });
  });

  it('rejects stream URLs that resolve to a local or private network', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ev-media-download-'));
    directories.push(root);
    const launch = vi.fn();
    const service = new MediaDownloadService({
      downloadDirectory: path.join(root, 'Downloads', 'EV'),
      launch,
      resolveAddresses: async () => ['127.0.0.1'],
    });

    await expect(
      service.start({
        backend: 'external',
        mediaKind: 'stream',
        pageUrl: 'https://example.com/watch',
        url: 'https://media.example.com/master.m3u8',
      })
    ).rejects.toThrow('local or private network');
    expect(launch).not.toHaveBeenCalled();
  });

  it('does not evict an active download when the job limit is reached', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ev-media-download-'));
    directories.push(root);
    const child = fakeProcess();
    const launch = vi.fn(() => {
      queueMicrotask(() => child.emit('spawn'));
      return child;
    });
    const service = new MediaDownloadService({
      downloadDirectory: path.join(root, 'Downloads', 'EV'),
      launch,
      resolveAddresses: async () => ['93.184.216.34'],
      maxJobs: 1,
    });
    const request = {
      backend: 'external' as const,
      mediaKind: 'stream' as const,
      pageUrl: 'https://example.com/watch',
      url: 'https://cdn.example.com/master.m3u8',
    };

    const started = await service.start(request);
    await expect(service.start(request)).rejects.toThrow('Too many active media downloads');
    expect(service.status(started.downloadId).state).toBe('in_progress');
    expect(launch).toHaveBeenCalledOnce();
    service.dispose();
  });

  it('interrupts active downloads on disposal', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ev-media-download-'));
    directories.push(root);
    const child = fakeProcess();
    const service = new MediaDownloadService({
      downloadDirectory: path.join(root, 'Downloads', 'EV'),
      launch: () => {
        queueMicrotask(() => child.emit('spawn'));
        return child;
      },
      resolveAddresses: async () => ['93.184.216.34'],
    });
    const started = await service.start({
      backend: 'external',
      mediaKind: 'stream',
      pageUrl: 'https://example.com/watch',
      url: 'https://cdn.example.com/master.m3u8',
    });

    service.dispose();

    expect(child.kill).toHaveBeenCalledOnce();
    expect(service.status(started.downloadId)).toMatchObject({
      state: 'interrupted',
      error: 'Browser Host stopped before the download completed',
    });
  });
});
