import { Body, Controller, Post } from '@nestjs/common';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedPrincipal } from '../auth/principal';
import { CreateTrackedDeviceDto } from './dto/create-tracked-device.dto';
import { TrackedDevicesService } from './tracked-devices.service';

// Protected by the global JwtAuthGuard like every other application route. The
// owning tenant comes from the verified principal only; it is never read from
// the body, query, params or a client-supplied header.
@Controller('tracked-devices')
export class TrackedDevicesController {
  constructor(private readonly trackedDevicesService: TrackedDevicesService) {}

  @Post()
  create(
    @Body() dto: CreateTrackedDeviceDto,
    @CurrentUser() principal: AuthenticatedPrincipal,
  ) {
    return this.trackedDevicesService.create(dto, principal.tenantId);
  }
}
