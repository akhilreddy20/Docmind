import { Body, Controller, Get, HttpException, Logger, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthUser } from '../auth/auth.service';
import { CurrentUser, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { QueryDto } from './query.dto';
import { QueryService } from './query.service';
import { SseWriter } from './sse';

@Controller('query')
@UseGuards(JwtAuthGuard)
export class QueryController {
  private readonly logger = new Logger(QueryController.name);

  constructor(private readonly query: QueryService) {}

  @Get('usage')
  usage(@CurrentUser() user: AuthUser) {
    return this.query.usage(user.id);
  }

  /**
   * POST /query/stream -> text/event-stream
   * events: meta {cache, sources, retrieval} | token "text" | done {timings, usage} | error {message}
   */
  @Post('stream')
  async stream(@CurrentUser() user: AuthUser, @Body() dto: QueryDto, @Req() req: Request, @Res() res: Response) {
    const sse = new SseWriter(res);
    const abort = new AbortController();
    req.on('close', () => {
      if (!res.writableEnded) abort.abort();
    });

    try {
      await this.query.ask(
        user.id,
        dto.question,
        dto.documentIds,
        {
          meta: (d) => sse.send('meta', d),
          token: (t) => sse.send('token', t),
          done: (d) => sse.send('done', d),
        },
        abort.signal,
      );
      sse.end();
    } catch (err: any) {
      if (abort.signal.aborted) return;
      const status = err instanceof HttpException ? err.getStatus() : 500;
      const body = err instanceof HttpException ? err.getResponse() : { statusCode: 500, message: 'Internal error' };
      if (status >= 500) this.logger.error(err?.stack ?? err);
      if (!sse.isStarted) {
        // Nothing streamed yet: respond with a proper HTTP error (e.g. 429 + Retry-After).
        const retry = (body as any)?.retryAfterSeconds;
        if (retry) res.setHeader('Retry-After', String(retry));
        res.status(status).json(body);
      } else {
        sse.send('error', typeof body === 'string' ? { message: body } : body);
        sse.end();
      }
    }
  }
}
