import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';

import { IS_PUBLIC_KEY, JWT_ALGORITHM } from '../auth.constants';
import {
  AuthenticatedPrincipal,
  JwtClaims,
  RequestWithPrincipal,
} from '../principal';

/**
 * Global authentication guard. Every route is protected unless explicitly
 * marked with @Public(). It extracts a Bearer token, verifies the signature,
 * algorithm and expiry, and attaches a typed principal to the request.
 *
 * All failure modes (missing, malformed, expired, wrong-algorithm, bad
 * signature, or structurally incomplete tokens) collapse to the same generic
 * 401 so nothing about why authentication failed is disclosed.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<RequestWithPrincipal>();
    const token = this.extractBearerToken(request);

    if (!token) {
      throw new UnauthorizedException('Authentication required');
    }

    let claims: JwtClaims;
    try {
      // Pin the accepted algorithm on verify (in addition to the module config)
      // to defend against algorithm-confusion and unsigned ("alg: none") tokens.
      claims = await this.jwtService.verifyAsync<JwtClaims>(token, {
        algorithms: [JWT_ALGORITHM],
      });
    } catch {
      throw new UnauthorizedException('Authentication required');
    }

    if (!claims?.sub || !claims?.tid || !claims?.mid) {
      throw new UnauthorizedException('Authentication required');
    }

    const principal: AuthenticatedPrincipal = {
      userId: claims.sub,
      tenantId: claims.tid,
      membershipId: claims.mid,
    };

    request.principal = principal;
    return true;
  }

  private extractBearerToken(request: RequestWithPrincipal): string | null {
    const header = request.headers.authorization;
    if (typeof header !== 'string') {
      return null;
    }

    const [scheme, value] = header.split(' ');
    if (scheme !== 'Bearer' || !value) {
      return null;
    }

    const token = value.trim();
    return token.length > 0 ? token : null;
  }
}
