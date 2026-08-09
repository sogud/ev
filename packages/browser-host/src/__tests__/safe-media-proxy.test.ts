import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { SafeMediaProxy } from '../safe-media-proxy';

const proxies: SafeMediaProxy[] = [];

afterEach(async () => {
  await Promise.all(proxies.splice(0).map(proxy => proxy.stop()));
});

describe('SafeMediaProxy', () => {
  it('rejects private destinations for playlist and redirect child requests', async () => {
    const proxy = new SafeMediaProxy(async () => ['127.0.0.1']);
    proxies.push(proxy);
    await proxy.start();
    const endpoint = new URL(proxy.endpoint);

    const response = await new Promise<string>((resolve, reject) => {
      const socket = net.createConnection(Number(endpoint.port), endpoint.hostname);
      let input = '';
      socket.setEncoding('utf8');
      socket.on('connect', () => {
        socket.write('CONNECT media.example:443 HTTP/1.1\r\nHost: media.example:443\r\n\r\n');
      });
      socket.on('data', chunk => {
        input += chunk;
        if (!input.includes('\r\n')) return;
        socket.destroy();
        resolve(input);
      });
      socket.on('error', reject);
    });

    expect(response).toMatch(/^HTTP\/1\.1 403 Forbidden/);
  });
});
