import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import DatabaseConstructor from 'better-sqlite3';

interface TestDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): { get(...params: unknown[]): unknown };
  close(): void;
}

const OpenDatabase = DatabaseConstructor as unknown as new (
  filename: string,
) => TestDatabase;

describe('GF-2 migration on existing data', () => {
  it('preserves legacy geofences under an inaccessible bootstrap tenant', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gf2-migration-'));
    const db = new OpenDatabase(path.join(tmpDir, 'migration.db'));

    try {
      const migrations = path.join(process.cwd(), 'prisma', 'migrations');
      db.exec(
        fs.readFileSync(
          path.join(migrations, '20260602200706_init', 'migration.sql'),
          'utf8',
        ),
      );
      db.exec(`
        INSERT INTO "Geofence"
          ("id", "name", "latitude", "longitude", "radiusMeters", "isActive", "createdAt", "updatedAt")
        VALUES
          ('legacy-geofence', 'Legacy', 30.0, -97.0, 100.0, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `);
      db.exec(
        fs.readFileSync(
          path.join(
            migrations,
            '20260805193807_add_identity_tenant_ownership',
            'migration.sql',
          ),
          'utf8',
        ),
      );

      expect(
        db.prepare('SELECT COUNT(*) AS count FROM "Geofence"').get(),
      ).toEqual({ count: 1 });
      expect(
        db
          .prepare('SELECT "tenantId" FROM "Geofence" WHERE "id" = ?')
          .get('legacy-geofence'),
      ).toEqual({ tenantId: 'clegacybootstrap000000000' });
      expect(
        db.prepare('SELECT COUNT(*) AS count FROM "Membership"').get(),
      ).toEqual({ count: 0 });
      expect(
        db
          .prepare(
            `SELECT COUNT(*) AS count FROM pragma_index_list('Geofence') WHERE name = 'Geofence_tenantId_idx'`,
          )
          .get(),
      ).toEqual({ count: 1 });
      expect(
        db
          .prepare(
            `SELECT COUNT(*) AS count FROM pragma_foreign_key_list('Geofence') WHERE "table" = 'Tenant' AND "from" = 'tenantId'`,
          )
          .get(),
      ).toEqual({ count: 1 });
    } finally {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
