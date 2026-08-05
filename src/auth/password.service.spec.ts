import { PasswordService } from './password.service';

describe('PasswordService', () => {
  const service = new PasswordService();

  it('produces a bcrypt hash that is not the plaintext', async () => {
    const hash = await service.hash('correct horse battery');
    expect(hash).not.toContain('correct horse battery');
    expect(hash.startsWith('$2')).toBe(true);
  });

  it('verifies a correct password and rejects a wrong one', async () => {
    const hash = await service.hash('password-123');
    await expect(service.verify('password-123', hash)).resolves.toBe(true);
    await expect(service.verify('password-124', hash)).resolves.toBe(false);
  });

  it('produces different hashes for the same password (per-hash salt)', async () => {
    const a = await service.hash('password-123');
    const b = await service.hash('password-123');
    expect(a).not.toEqual(b);
  });

  it('rejects input beyond bcrypt 72-byte limit rather than silently truncating', async () => {
    await expect(service.hash('a'.repeat(73))).rejects.toThrow();
  });

  it('rejects multibyte input beyond the bcrypt byte limit during verification', async () => {
    const atLimit = '€'.repeat(24);
    const hash = await service.hash(atLimit);
    await expect(service.verify(`${atLimit}a`, hash)).resolves.toBe(false);
  });
});
