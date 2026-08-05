import { INestApplication, ValidationPipe } from '@nestjs/common';

import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';

/**
 * Applies the application's HTTP configuration. Shared by the runtime bootstrap
 * (main.ts) and the HTTP-level tests so both exercise identical behavior:
 *
 * - `/api/v1` global prefix for application API routes.
 * - `/health` and `/status` remain unversioned operational routes.
 * - Strict global validation (whitelist + reject unknown properties + safe
 *   primitive transformation).
 * - A stable, non-leaky JSON error contract.
 */
export function setupApp(app: INestApplication): INestApplication {
  app.setGlobalPrefix('api/v1', { exclude: ['health', 'status'] });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  app.useGlobalFilters(new AllExceptionsFilter());

  return app;
}
