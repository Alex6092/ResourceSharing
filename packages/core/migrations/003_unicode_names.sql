-- PostgreSQL 17 built-in Unicode simple case mapping, independent of LC_CTYPE.
-- Existing unique indexes are rebuilt with this collation. A pre-existing
-- case collision aborts the migration; no resource is renamed or overwritten.
ALTER TABLE folders ALTER COLUMN name TYPE varchar(255) COLLATE "pg_c_utf8";
ALTER TABLE resources ALTER COLUMN name TYPE varchar(255) COLLATE "pg_c_utf8";
