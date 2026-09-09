import { Prisma } from '@prisma/client';

/** Match the exact index reported by the PostgreSQL driver adapter. */
export function isPrismaUniqueConstraint(
  error: unknown,
  model: string,
  index: string,
): boolean {
  if (
    !(error instanceof Prisma.PrismaClientKnownRequestError) ||
    error.code !== 'P2002' ||
    error.meta?.modelName !== model
  ) {
    return false;
  }

  const adapter = error.meta.driverAdapterError as
    | { cause?: { kind?: unknown; constraint?: { index?: unknown } } }
    | undefined;
  return (
    adapter?.cause?.kind === 'UniqueConstraintViolation' &&
    adapter.cause.constraint?.index === index
  );
}
