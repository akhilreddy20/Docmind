import type { Response } from 'express';

/**
 * Minimal Server-Sent Events writer. Headers are sent lazily on the first
 * event, so errors raised before streaming starts (validation, rate limits)
 * still produce a normal HTTP status code instead of a 200 stream.
 */
export class SseWriter {
  private started = false;
  private heartbeat?: NodeJS.Timeout;
  closed = false;

  constructor(private readonly res: Response) {
    res.on('close', () => this.stop());
  }

  get isStarted() {
    return this.started;
  }

  private start() {
    if (this.started) return;
    this.started = true;
    this.res.status(200);
    this.res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    this.res.setHeader('Cache-Control', 'no-cache, no-transform');
    this.res.setHeader('Connection', 'keep-alive');
    this.res.setHeader('X-Accel-Buffering', 'no'); // disable proxy buffering (nginx)
    this.res.flushHeaders();
    // Comment lines keep idle connections alive through proxies/load balancers.
    this.heartbeat = setInterval(() => this.res.write(': ping\n\n'), 15000);
  }

  send(event: string, data: unknown) {
    if (this.closed) return;
    this.start();
    this.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  end() {
    if (this.closed) return;
    this.stop();
    this.res.end();
  }

  private stop() {
    this.closed = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
  }
}
