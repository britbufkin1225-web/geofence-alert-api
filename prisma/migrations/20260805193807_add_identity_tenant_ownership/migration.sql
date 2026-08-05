-- GF-2: Identity, authentication and tenant isolation.
--
-- This migration introduces User, Tenant and Membership tables and makes every
-- Geofence belong to exactly one Tenant (required, non-null `tenantId`).
--
-- Existing-data strategy (development/demo database):
--   The GF-1 database may already contain geofence rows that predate the tenant
--   model. A required relation cannot be added to a non-empty table without a
--   value for every row, so this migration provisions a single deterministic
--   "legacy bootstrap" tenant and assigns all pre-existing geofences to it.
--
--   That tenant is intentionally created WITHOUT any user or membership, so it
--   cannot be authenticated into and its rows are unreachable through the
--   authenticated API. This preserves historical demo data without fabricating
--   real ownership for it. New geofences always receive a tenantId derived from
--   the authenticated principal, never this bootstrap id.

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Tenant" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Membership" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Membership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Membership_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Provision the deterministic legacy bootstrap tenant, but only when there are
-- pre-existing geofences to backfill. On a fresh database this is a no-op and
-- no bootstrap tenant is created.
INSERT INTO "Tenant" ("id", "name", "createdAt", "updatedAt")
SELECT 'clegacybootstrap000000000', 'Legacy (pre-GF-2) bootstrap tenant', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
WHERE EXISTS (SELECT 1 FROM "Geofence");

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Geofence" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "latitude" REAL NOT NULL,
    "longitude" REAL NOT NULL,
    "radiusMeters" REAL NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Geofence_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
-- Backfill: every pre-existing geofence is assigned to the legacy bootstrap
-- tenant provisioned above.
INSERT INTO "new_Geofence" ("createdAt", "description", "id", "isActive", "latitude", "longitude", "name", "radiusMeters", "updatedAt", "tenantId") SELECT "createdAt", "description", "id", "isActive", "latitude", "longitude", "name", "radiusMeters", "updatedAt", 'clegacybootstrap000000000' FROM "Geofence";
DROP TABLE "Geofence";
ALTER TABLE "new_Geofence" RENAME TO "Geofence";
CREATE INDEX "Geofence_tenantId_idx" ON "Geofence"("tenantId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "Membership_tenantId_idx" ON "Membership"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "Membership_userId_tenantId_key" ON "Membership"("userId", "tenantId");
