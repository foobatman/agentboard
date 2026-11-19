import http from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { registerTools, type ToolHandlers } from './tools';

export interface Identity {
  role: 'manager' | 'worker';
  session: string;
  name: string;
  worker?: string;
  task?: string;
}

export interface BusHandlers extends ToolHandlers {
  onHook(id: Identity, event: string, body: Record<string, unknown>): Promise<Record<string, unknown> | undefined>;
  onStatusline(id: Identity, body: Record<string, unknown>): void;
  onLeak(id: Identity, body: Record<string, unknown>): void;
  onChannelReady(id: Identity, ready: boolean): void;
  /** Whether native messaging is disabled (Fallback B worker tools visible). */
  fallbackB(): boolean;
}

export class TokenRegistry {
  private byToken = new Map<string, Identity>();
  private bySession = new Map<string, string>();

  issue(id: Identity): string {
    this.revoke(id.session);
    const token = randomBytes(32).toString('hex');
    this.byToken.set(token, id);
    this.bySession.set(id.session, token);
    return token;
  }

  revoke(session: string): void {
    const t = this.bySession.get(session);
    if (t) this.byToken.delete(t);
    this.bySession.delete(session);
  }

  resolve(header: string | undefined): Identity | undefined {
    if (!header?.startsWith('Bearer ')) return undefined;
    const presented = Buffer.from(header.slice(7).trim());
    for (const [tok, id] of this.byToken) {
      const b = Buffer.from(tok);
      if (b.length === presented.length && timingSafeEqual(b, presented)) return id;
    }
    return undefined;
  }
}

interface McpEntry {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  identity: Identity;
  channel: boolean;
}

const LIMITS: Record<string, number> = { mcp: 256 * 1024, hooks: 256 * 1024, statusline: 64 * 1024, leak: 16 * 1024 };

export class Bus {
  readonly tokens = new TokenRegistry();
  private server?: http.Server;
  private mcp = new Map<string, McpEntry>();
  port = 0;

  constructor(private readonly handlers: BusHandlers) {}

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async start(port = 0): Promise<void> {
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((e) => {
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: String(e) }));
        }
      });
    });
    this.server.keepAliveTimeout = 65_000;
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(port, '127.0.0.1', () => resolve());
    });
    this.port = (this.server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    for (const e of this.mcp.values()) await e.transport.close().catch(() => undefined);
    this.mcp.clear();
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
    this.server?.closeAllConnections?.();
  }

  /** Push a channel event into the manager session (notifications/claude/channel). */
  async pushChannel(session: string, content: string, meta: Record<string, string>): Promise<boolean> {
    for (const e of this.mcp.values()) {
      if (e.identity.session === session && e.channel) {
        try {
          await e.server.server.notification({ method: 'notifications/claude/channel', params: { content, meta } });
          return true;
        } catch {
          return false;
        }
      }
    }
    return false;
  }

  hasChannel(session: string): boolean {
    for (const e of this.mcp.values()) if (e.identity.session === session && e.channel) return true;
    return false;
  }

  /** Drop MCP sessions belonging to a claude session (on exit/revoke). */
  dropSession(session: string): void {
    for (const [k, e] of this.mcp) {
      if (e.identity.session === session) {
        void e.transport.close().catch(() => undefined);
        this.mcp.delete(k);
      }
    }
  }

  private async readBody(req: http.IncomingMessage, limit: number): Promise<string> {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > limit) {
          reject(Object.assign(new Error('body too large'), { status: 413 }));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  private json(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // DNS-rebinding / browser guard: loopback Host only, no Origin.
    const host = req.headers.host ?? '';
    if (req.headers.origin || !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return this.json(res, 403, { error: 'forbidden' });
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/healthz') return this.json(res, 200, { ok: true });
    const id = this.tokens.resolve(req.headers.authorization);
    if (!id) return this.json(res, 401, { error: 'unauthorized' });
    const route = url.pathname.split('/')[1] ?? '';
    let raw = '';
    if (req.method === 'POST') {
      try {
        raw = await this.readBody(req, LIMITS[route] ?? 64 * 1024);
      } catch (e) {
        return this.json(res, (e as { status?: number }).status ?? 400, { error: String(e) });
      }
    }
    let body: unknown = undefined;
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        return this.json(res, 400, { error: 'invalid json' });
      }
    }
    if (route === 'mcp') return this.handleMcp(req, res, id, body, url.searchParams.get('channel') === '1');
    if (route === 'hooks' && req.method === 'POST') {
      const event = url.pathname.split('/')[2] ?? '';
      const out = await this.handlers.onHook(id, event, (body ?? {}) as Record<string, unknown>);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(out ? JSON.stringify(out) : '');
      return;
    }
    if (route === 'statusline' && req.method === 'POST') {
      this.handlers.onStatusline(id, (body ?? {}) as Record<string, unknown>);
      return this.json(res, 200, {});
    }
    if (route === 'leak' && req.method === 'POST') {
      this.handlers.onLeak(id, (body ?? {}) as Record<string, unknown>);
      return this.json(res, 200, {});
    }
    return this.json(res, 404, { error: 'not found' });
  }

  private async handleMcp(req: http.IncomingMessage, res: http.ServerResponse, id: Identity, body: unknown, channel: boolean): Promise<void> {
    const sid = req.headers['mcp-session-id'];
    const key = Array.isArray(sid) ? sid[0] : sid;
    let entry = key ? this.mcp.get(key) : undefined;
    if (entry && entry.identity.session !== id.session) return this.json(res, 403, { error: 'session mismatch' });
    if (!entry) {
      if (req.method !== 'POST' || !isInitializeRequest(body)) {
        // e.g. the 2026-07-28 `server/discover` probe: answer like a pre-2026 server so the client falls back to initialize.
        if (req.method === 'POST' && body && typeof body === 'object' && 'id' in (body as object)) {
          return this.json(res, 200, { jsonrpc: '2.0', id: (body as { id: unknown }).id, error: { code: -32601, message: 'Method not found' } });
        }
        return this.json(res, 400, { jsonrpc: '2.0', error: { code: -32000, message: 'No valid MCP session' }, id: null });
      }
      const isChannel = channel && id.role === 'manager';
      const server = new McpServer(
        { name: 'agentboard', version: '0.1.0' },
        {
          capabilities: isChannel ? { experimental: { 'claude/channel': {} } } : {},
          instructions:
            id.role === 'manager'
              ? 'agentboard manager tools. App events arrive as <channel source="agentboard"> blocks; acknowledge them.'
              : 'agentboard worker tools: report_progress, request_approval, done.',
        },
      );
      registerTools(server, id, this.handlers, { fallbackB: this.handlers.fallbackB() });
      const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (newId) => {
          this.mcp.set(newId, { transport, server, identity: id, channel: isChannel });
          if (isChannel) this.handlers.onChannelReady(id, true);
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) this.mcp.delete(transport.sessionId);
        if (isChannel) this.handlers.onChannelReady(id, this.hasChannel(id.session));
      };
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
      return;
    }
    await entry.transport.handleRequest(req, res, body);
  }
}
