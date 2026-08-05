/** Safe, serializable view of a user. Never includes the password hash. */
export class AuthenticatedUserDto {
  id!: string;
  email!: string;
  createdAt!: Date;
}

export class TenantSummaryDto {
  id!: string;
  name!: string;
}

/** Response for register and login. */
export class AuthTokenResponseDto {
  accessToken!: string;
  tokenType!: 'Bearer';
  expiresIn!: string;
  user!: AuthenticatedUserDto;
  tenant!: TenantSummaryDto;
}

/** Response for GET /auth/me — derived from the verified principal + DB. */
export class MeResponseDto {
  userId!: string;
  email!: string;
  tenantId!: string;
  tenantName!: string;
  membershipId!: string;
}
