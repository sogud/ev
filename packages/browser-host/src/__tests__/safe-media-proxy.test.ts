import net from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SafeMediaProxy } from '../safe-media-proxy';

const proxies: SafeMediaProxy[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(proxies.splice(0).map(proxy => proxy.stop()));
});

describe('SafeMediaProxy', () => {
  it('absorbs repeated errors from an upstream CONNECT socket', async () => {
    const upstream = new net.Socket();
    const proxy = new SafeMediaProxy(async () => ['93.184.216.34']);
    proxies.push(proxy);
    await proxy.start();
    const endpoint = new URL(proxy.endpoint);
    const client = net.createConnection(Number(endpoint.port), endpoint.hostname);
    await new Promise<void>((resolve, reject) => {
      client.once('connect', resolve);
      client.once('error', reject);
    });
    const createConnection = vi.spyOn(net, 'createConnection').mockReturnValue(upstream);
    client.write('CONNECT media.example:443 HTTP/1.1\r\nHost: media.example:443\r\n\r\n');
    await vi.waitFor(() => expect(createConnection).toHaveBeenCalled());

    const reset = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    expect(() => upstream.emit('error', reset)).not.toThrow();
    expect(() => upstream.emit('error', reset)).not.toThrow();
    client.destroy();
  });

  it('absorbs repeated resets from an accepted CONNECT client', async () => {
    const proxy = new SafeMediaProxy(async () => ['127.0.0.1']);
    proxies.push(proxy);
    await proxy.start();
    const endpoint = new URL(proxy.endpoint);
    const server = (proxy as unknown as { server: net.Server }).server;
    const accepted = new Promise<net.Socket>(resolve => server.once('connection', resolve));
    const client = net.createConnection(Number(endpoint.port), endpoint.hostname);
    const serverSocket = await accepted;
    client.write('CONNECT media.example:443 HTTP/1.1\r\nHost: media.example:443\r\n\r\n');
    await new Promise(resolve => setImmediate(resolve));
    expect(serverSocket.listenerCount('error')).toBeGreaterThanOrEqual(2);

    const reset = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    expect(() => serverSocket.emit('error', reset)).not.toThrow();
    expect(() => serverSocket.emit('error', reset)).not.toThrow();
    client.destroy();
  });

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
