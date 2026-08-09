import {
  BrowserDownloadDispatchSchema,
  BrowserDownloadStatusSchema,
  type BrowserCommand,
} from '@ev/contracts';
import type { BrowserBridgeService } from './browser-bridge-service';
import type { MediaDownloadService } from './media-download-service';

export class BrowserCommandExecutor {
  constructor(
    private readonly bridge: BrowserBridgeService,
    private readonly downloads: MediaDownloadService
  ) {}

  async sendCommand(command: BrowserCommand): Promise<unknown> {
    if (command.action === 'downloads.status' && command.downloadId.startsWith('local:')) {
      return this.downloads.status(command.downloadId);
    }

    const result = await this.bridge.sendCommand(command);
    if (command.action !== 'page.download') return result;

    const dispatch = BrowserDownloadDispatchSchema.parse(result);
    if (dispatch.backend === 'external') return this.downloads.start(dispatch);
    return BrowserDownloadStatusSchema.parse({
      downloadId: `chrome:${dispatch.downloadId}`,
      backend: 'chrome',
      state: 'in_progress',
    });
  }
}
