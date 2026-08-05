import { Controller, Get } from '@nestjs/common';

import { AppService } from './app.service';
import { Public } from './auth/decorators/public.decorator';

type DatabaseStatusResponse = {
  database: string;
  provider: string;
  status: string;
};

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  // Harmless static banner; kept public to preserve the existing contract.
  @Public()
  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  // Intentionally NOT @Public(): database/operational internals are only
  // exposed to authenticated callers (see docs/security.md).
  @Get('db/status')
  getDatabaseStatus(): Promise<DatabaseStatusResponse> {
    return this.appService.getDatabaseStatus();
  }
}
