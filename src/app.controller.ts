import { Controller, Get } from '@nestjs/common';

@Controller()
export class AppController {
  @Get()
  getRoot() {
    return {
      service: 'GeoFence Alert API',
      status: 'running',
      message: 'API root is available',
      endpoints: {
        health: '/api/v1/health',
        status: '/api/v1/status',
      },
      timestamp: new Date().toISOString(),
    };
  }
}
