import { Controller, Get } from '@nestjs/common';

import { Public } from '../auth/decorators/public.decorator';

// Operational probes must be reachable without authentication so external
// health/liveness checks keep working.
@Public()
@Controller()
export class HealthController {
  @Get('health')
  getHealth() {
    return {
      status: 'ok',
      service: 'GeoFence Alert API',
      timestamp: new Date().toISOString(),
    };
  }

  @Get('status')
  getStatus() {
    return {
      service: 'GeoFence Alert API',
      version: '0.1.0',
      environment: process.env.NODE_ENV || 'development',
      apiPrefix: process.env.API_PREFIX || 'api/v1',
      status: 'running',
      timestamp: new Date().toISOString(),
    };
  }
}
