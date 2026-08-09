import http, { type ClientRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import https from 'node:https';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import { type AddressResolver, resolvePublicAddresses } from './network-safety';

export class SafeMediaProxy {
  private server: http.Server | null = null;
  private readonly sockets = new Set<Duplex>();
  private readonly upstreamRequests = new Set<ClientRequest>();
  private endpointValue: string | null = null;
  private generation = 0;

  constructor(private readonly resolveAddresses: AddressResolver) {}

  get endpoint(): string {
    if (!this.endpointValue) throw new Error('Safe media proxy is not running');
    return this.endpointValue;
  }

  async start(): Promise<void> {
    if (this.server) return;
    const generation = ++this.generation;
    const server = http.createServer((request, response) => {
      void this.forwardHttp(request, response, generation);
    });
    this.server = server;
    server.on('connect', (request, client, head) => {
      void this.forwardConnect(request.url ?? '', client, head, generation);
    });
    server.on('connection', socket => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', error => {
        this.server = null;
        reject(error);
      });
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      this.server = null;
      server.close();
      throw new Error('Safe media proxy did not bind a TCP port');
    }
    this.endpointValue = `http://127.0.0.1:${address.port}`;
  }

  async stop(): Promise<void> {
    this.generation += 1;
    for (const request of this.upstreamRequests) request.destroy();
    this.upstreamRequests.clear();
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    const server = this.server;
    this.server = null;
    this.endpointValue = null;
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  }

  private async forwardConnect(
    authority: string,
    client: Duplex,
    head: Buffer,
    generation: number
  ): Promise<void> {
    let target: URL;
    try {
      target = new URL(`http://${authority}`);
      if (!target.hostname) throw new Error('missing hostname');
    } catch {
      client.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      return;
    }

    try {
      const [address] = await resolvePublicAddresses(target.hostname, this.resolveAddresses);
      if (generation !== this.generation || !this.server || client.destroyed) return;
      const port = Number(target.port || '443');
      if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('invalid port');
      const upstream = net.createConnection({ host: address, port });
      this.sockets.add(upstream);
      upstream.on('close', () => this.sockets.delete(upstream));
      upstream.once('connect', () => {
        if (generation !== this.generation || !this.server || client.destroyed) {
          upstream.destroy();
          return;
        }
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length > 0) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      upstream.once('error', () => client.destroy());
    } catch {
      if (!client.destroyed) {
        client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      }
    }
  }

  private async forwardHttp(
    request: IncomingMessage,
    response: ServerResponse,
    generation: number
  ): Promise<void> {
    let target: URL;
    try {
      target = new URL(request.url ?? '');
      if (target.protocol !== 'http:' && target.protocol !== 'https:') throw new Error('protocol');
      const [address] = await resolvePublicAddresses(target.hostname, this.resolveAddresses);
      if (generation !== this.generation || !this.server || response.destroyed) return;
      const headers = { ...request.headers, host: target.host };
      delete headers['proxy-authorization'];
      const transport = target.protocol === 'https:' ? https : http;
      const upstream = transport.request({
        host: address,
        port: Number(target.port || (target.protocol === 'https:' ? '443' : '80')),
        method: request.method,
        path: `${target.pathname}${target.search}`,
        headers,
        ...(target.protocol === 'https:' ? { servername: target.hostname } : {}),
      });
      this.upstreamRequests.add(upstream);
      upstream.on('close', () => this.upstreamRequests.delete(upstream));
      upstream.on('response', upstreamResponse => {
        if (generation !== this.generation || !this.server || response.destroyed) {
          upstreamResponse.destroy();
          return;
        }
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      });
      upstream.on('error', () => {
        if (!response.headersSent) response.writeHead(502);
        response.end();
      });
      request.pipe(upstream);
    } catch {
      if (!response.destroyed) {
        response.writeHead(403, { Connection: 'close' });
        response.end();
      }
    }
  }
}
