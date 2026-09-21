-- Application migration history. Applied by the migration role only.
-- DATA_MODEL.md: "Add application migration history/version tracking in M0 rather than
-- rerunning CREATE statements against existing production."
CREATE SCHEMA IF NOT EXISTS oe_meta;
REVOKE ALL ON SCHEMA oe_meta FROM PUBLIC;

CREATE TABLE IF NOT EXISTS oe_meta.schema_migrations (
  version     text PRIMARY KEY,
  checksum    text NOT NULL,
  applied_at  timestamptz NOT NULL DEFAULT now(),
  applied_by  text NOT NULL DEFAULT current_user
);
