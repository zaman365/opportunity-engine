-- The category rubric, and the gate it holds shut.
--
-- CE-CONTENT-01 and CE-VISUAL-01 are the two rules in contracts/detectors.json that cannot be
-- written as general rules. "This page is missing buying information" is a claim about a
-- category of thing, and which information a category requires is a commercial judgement an
-- owner makes -- not a property of the markup, and not something this build gets to decide on
-- somebody's behalf.
--
-- So the standard lives in a file an owner signs, and the database refuses the rules without
-- a signature. Exactly the arrangement migration 0009 uses for prices: an offer cannot be
-- sellable without a named approver, and a rubric cannot be *applied* without one.
--
-- Three pieces, and the gate needs all three:
--
--   1. oe.category_rubrics, which by construction can only hold approved rubrics.
--   2. oe.scans.rubric_key, a foreign key into it.
--   3. A check that the two rubric-gated detectors may only appear on a scan that names one.
--
-- An unapproved rubric produces no row, so no scan can name it, so neither detector can be
-- requested. That is enforcement rather than convention: a caller that skipped the service
-- layer entirely still cannot insert the scan.

CREATE TABLE oe.category_rubrics (
  tenant_id      uuid NOT NULL REFERENCES oe.tenants(id),
  id             uuid NOT NULL,
  -- The slug from the rubric file. Unique per tenant: one live standard per category, so two
  -- scans of comparable pages were judged against the same thing.
  rubric_key     text NOT NULL CHECK (rubric_key ~ '^[a-z0-9-]+$'),
  version        integer NOT NULL DEFAULT 1 CHECK (version > 0),
  label          text NOT NULL CHECK (length(label) > 0),

  -- The rubric as approved, whole. Stored rather than referenced for the same reason
  -- oe.offer_drafts snapshots a price: a finding says "judged against this standard", and a
  -- later edit to the file must not silently change what a published report claimed.
  document       jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object'),

  -- The rubric's author marked these as arguable, and no finding ever claims them. Held as a
  -- column as well as inside the document so it can be read without parsing, and so a rubric
  -- with an empty list cannot be written at all.
  contested      text[] NOT NULL CHECK (cardinality(contested) > 0),

  approved_by    uuid NOT NULL,
  approved_at    timestamptz NOT NULL,
  approval_note  text,
  created_at     timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, rubric_key),
  FOREIGN KEY (tenant_id, approved_by) REFERENCES oe.memberships(tenant_id, id)
);

COMMENT ON TABLE oe.category_rubrics IS
  'Approved category rubrics only. approved_by and approved_at are NOT NULL by design: an unapproved rubric has no row here, which is what keeps CE-CONTENT-01 and CE-VISUAL-01 unrequestable.';

ALTER TABLE oe.category_rubrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE oe.category_rubrics FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON oe.category_rubrics
  USING (tenant_id = oe.tenant_context()) WITH CHECK (tenant_id = oe.tenant_context());

-- Which standard this scan was judged against, if any. Null for the four rules that need none.
ALTER TABLE oe.scans ADD COLUMN rubric_key text;
ALTER TABLE oe.scans
  ADD CONSTRAINT scans_rubric_key_fkey
  FOREIGN KEY (tenant_id, rubric_key) REFERENCES oe.category_rubrics(tenant_id, rubric_key);

-- The build knows six rules. Widening the list here is what makes the two new ones storable
-- at all; the constraint immediately below is what keeps them from being requested.
ALTER TABLE oe.scans DROP CONSTRAINT scans_detectors_supported;
ALTER TABLE oe.scans
  ADD CONSTRAINT scans_detectors_supported
  CHECK (
    detectors <@ ARRAY['CE-LINK-01', 'CE-ASSET-01', 'CE-DATA-01', 'CE-MOBILE-01',
                       'CE-CONTENT-01', 'CE-VISUAL-01']::text[]
    AND cardinality(detectors) >= 1
  );

-- The gate. A scan asking for a rubric-gated rule must name a rubric, and the only rubrics
-- that exist are approved ones.
ALTER TABLE oe.scans
  ADD CONSTRAINT scans_rubric_detectors_require_rubric
  CHECK (
    NOT (detectors && ARRAY['CE-CONTENT-01', 'CE-VISUAL-01']::text[])
    OR rubric_key IS NOT NULL
  );

COMMENT ON CONSTRAINT scans_rubric_detectors_require_rubric ON oe.scans IS
  'CE-CONTENT-01 and CE-VISUAL-01 apply a category standard. Requesting one without naming an approved rubric would mean this build inventing the standard, which is the thing it must not do.';

DO $grants$
DECLARE runtime text := current_setting('oe.runtime_role', true);
BEGIN
  IF runtime IS NULL OR runtime = '' THEN
    RAISE EXCEPTION 'oe.runtime_role must be set for migration 0017';
  END IF;

  -- Read-only at runtime. A rubric is approved out of band and loaded by the seeder under the
  -- migration role, the same way the offer catalogue is: the application that applies a
  -- standard is not the application that gets to write one.
  EXECUTE format('GRANT SELECT ON oe.category_rubrics TO %I', runtime);

  -- The column is set when the scan is created and never moves. A scan re-pointed at a
  -- different standard afterwards would have findings judged against two.
  EXECUTE format('GRANT INSERT (rubric_key) ON oe.scans TO %I', runtime);
END
$grants$;
