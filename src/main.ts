import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  const apiPrefix = process.env.API_PREFIX || 'api/v1';
  app.setGlobalPrefix(apiPrefix);

  const port = process.env.PORT || 3000;
  await app.listen(port);

  console.log(
    `GeoFence Alert API running on http://localhost:${port}/${apiPrefix}`,
  );
}

void bootstrap();