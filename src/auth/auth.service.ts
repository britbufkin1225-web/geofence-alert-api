import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { AuthenticatedPrincipal, JwtClaims } from './principal';
import { PasswordService } from './password.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { AuthTokenResponseDto, MeResponseDto } from './dto/auth-response.dto';

// A genuine bcrypt hash (cost 10) of a random throwaway string, used to
// equalize timing when an account does not exist so login cannot be used to
// enumerate registered emails. It is not a secret and matches no real password.
const DUMMY_PASSWORD_HASH =
  '$2b$10$zBPDlY2Two0p1xkhZcC5deCyooetGMKstw8mBDYBd825./rChTfFW';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwordService: PasswordService,
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Registers a new user together with their initial tenant and membership in a
   * single transaction, so identity state is never left partially created.
   * Uniqueness is enforced by the database; a duplicate email surfaces as a
   * generic 409 without leaking Prisma internals.
   */
  async register(dto: RegisterDto): Promise<AuthTokenResponseDto> {
    const passwordHash = await this.passwordService.hash(dto.password);

    try {
      const { user, tenant, membership } = await this.prisma.$transaction(
        async (tx) => {
          const tenant = await tx.tenant.create({
            data: { name: dto.tenantName },
          });

          const user = await tx.user.create({
            data: { email: dto.email, passwordHash },
          });

          const membership = await tx.membership.create({
            data: { userId: user.id, tenantId: tenant.id },
          });

          return { user, tenant, membership };
        },
      );

      const accessToken = await this.issueToken(
        user.id,
        tenant.id,
        membership.id,
      );
      return this.buildTokenResponse(accessToken, user, tenant);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException('Email already registered');
      }
      throw error;
    }
  }

  /**
   * Authenticates by canonical email + password. Unknown accounts and wrong
   * passwords return the same generic 401, and a dummy hash comparison keeps
   * timing similar in both cases, so the endpoint does not reveal whether an
   * account exists.
   */
  async login(dto: LoginDto): Promise<AuthTokenResponseDto> {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
      include: { memberships: { orderBy: { createdAt: 'asc' }, take: 1 } },
    });

    if (!user) {
      await this.passwordService.verify(dto.password, DUMMY_PASSWORD_HASH);
      throw new UnauthorizedException('Invalid credentials');
    }

    const passwordMatches = await this.passwordService.verify(
      dto.password,
      user.passwordHash,
    );

    const membership = user.memberships[0];
    if (!passwordMatches || !membership) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const tenant = await this.prisma.tenant.findUniqueOrThrow({
      where: { id: membership.tenantId },
    });

    const accessToken = await this.issueToken(
      user.id,
      membership.tenantId,
      membership.id,
    );
    return this.buildTokenResponse(accessToken, user, tenant);
  }

  /**
   * Resolves the current identity from the verified principal, re-validating it
   * against the database so a token whose membership no longer exists is
   * rejected. Never returns the password hash.
   */
  async me(principal: AuthenticatedPrincipal): Promise<MeResponseDto> {
    const membership = await this.prisma.membership.findFirst({
      where: {
        id: principal.membershipId,
        userId: principal.userId,
        tenantId: principal.tenantId,
      },
      include: { user: true, tenant: true },
    });

    if (!membership) {
      throw new UnauthorizedException('Authentication required');
    }

    return {
      userId: membership.userId,
      email: membership.user.email,
      tenantId: membership.tenantId,
      tenantName: membership.tenant.name,
      membershipId: membership.id,
    };
  }

  private async issueToken(
    userId: string,
    tenantId: string,
    membershipId: string,
  ): Promise<string> {
    const claims: JwtClaims = { sub: userId, tid: tenantId, mid: membershipId };
    return this.jwtService.signAsync(claims);
  }

  private buildTokenResponse(
    accessToken: string,
    user: { id: string; email: string; createdAt: Date },
    tenant: { id: string; name: string },
  ): AuthTokenResponseDto {
    return {
      accessToken,
      tokenType: 'Bearer',
      expiresIn: this.config.get<string>('JWT_EXPIRES_IN') ?? '1h',
      user: { id: user.id, email: user.email, createdAt: user.createdAt },
      tenant: { id: tenant.id, name: tenant.name },
    };
  }
}
