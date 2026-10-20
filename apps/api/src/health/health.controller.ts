import { Controller, Get } from '@nestjs/common';
import { DatabaseService } from '../common/database.service';
import { RedisService } from '../common/redis.service';

@Controller('health')
export class HealthController {
  constructor(private readonly db: DatabaseService, private readonly redis: RedisService) {}

  @Get()
  async check() {
    const [db, redis] = await Promise.all([
      this.db.query('SELECT 1').then(() => 'ok', (e) => `error: ${e.message}`),
      this.redis.client.ping().then(() => 'ok', (e) => `error: ${e.message}`),
    ]);
    return { status: db === 'ok' && redis === 'ok' ? 'ok' : 'degraded', db, redis };
  }
}
