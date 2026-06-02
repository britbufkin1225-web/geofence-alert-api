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
