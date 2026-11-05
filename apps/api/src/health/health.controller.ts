import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { HealthReport, HealthService } from './health.service';

@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  /**
   * 200 when the database is up or not configured and every folder the API writes is writable;
   * 503 when the database is down or a folder is not writable, so the container's health check
   * (and `docker compose up --wait`) fails. The body has the same shape in every case.
   */
  @Get()
  async get(): Promise<HealthReport> {
    const report = await this.health.check();
    if (report.db === 'down' || report.files === 'not_writable') {
      throw new ServiceUnavailableException(report);
    }
    return report;
  }
}
