import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { HealthReport, HealthService } from './health.service';

@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  /**
   * 200 when the database is up or not configured, 503 when it is down.
   * The body has the same shape in every case.
   */
  @Get()
  async get(): Promise<HealthReport> {
    const report = await this.health.check();
    if (report.db === 'down') {
      throw new ServiceUnavailableException(report);
    }
    return report;
  }
}
