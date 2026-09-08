-- Match the existing DTO's 1..5000 metre contract, including direct SQL writes.
ALTER TABLE "Geofence" DROP CONSTRAINT "Geofence_radiusMeters_positive_check";
ALTER TABLE "Geofence" ADD CONSTRAINT "Geofence_radiusMeters_positive_check"
  CHECK ("radiusMeters" >= 1);

-- JavaScript trim() also recognizes tabs, line breaks and Unicode whitespace.
-- btrim(text) alone only strips ASCII spaces. Use the explicit ECMAScript set
-- so whitespace-only names cannot bypass the existing public contract.
ALTER TABLE "Geofence" DROP CONSTRAINT "Geofence_name_not_blank_check";
ALTER TABLE "Geofence" ADD CONSTRAINT "Geofence_name_not_blank_check"
  CHECK (btrim("name", U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF') <> '');
ALTER TABLE "Tenant" DROP CONSTRAINT "Tenant_name_not_blank_check";
ALTER TABLE "Tenant" ADD CONSTRAINT "Tenant_name_not_blank_check"
  CHECK (btrim("name", U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF') <> '');
ALTER TABLE "User" DROP CONSTRAINT "User_email_not_blank_check";
ALTER TABLE "User" ADD CONSTRAINT "User_email_not_blank_check"
  CHECK ("email" <> '' AND "email" = btrim("email", U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'));
