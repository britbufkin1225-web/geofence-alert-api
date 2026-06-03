import { Controller, Get } from '@nestjs/common';

import { AppService } from './app.service';

type DatabaseStatusResponse = {
  database: string;
  provider: string;
  status: string;
};

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  @Get('db/status')
  getDatabaseStatus(): Promise<DatabaseStatusResponse> {
    return this.appService.getDatabaseStatus();
  }
}
