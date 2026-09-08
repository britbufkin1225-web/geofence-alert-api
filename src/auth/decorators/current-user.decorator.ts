import {
  createParamDecorator,
  ExecutionContext,
  InternalServerErrorException,
} from '@nestjs/common';

import { AuthenticatedPrincipal, RequestWithPrincipal } from '../principal';

/**
 * Injects the verified {@link AuthenticatedPrincipal} attached by the global
 * JwtAuthGuard. Used only on protected routes; if it is ever reached without a
 * principal that indicates a guard misconfiguration, so we fail closed with a
 * sanitized 500 rather than proceeding unauthenticated.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedPrincipal => {
    const request = ctx.switchToHttp().getRequest<RequestWithPrincipal>();

    if (!request.principal) {
      throw new InternalServerErrorException();
    }

    return request.principal;
  },
);
