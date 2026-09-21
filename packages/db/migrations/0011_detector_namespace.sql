-- The Consistency Engine detector namespace.
--
-- The rules were first named after the ventures they were written for — `MF-` for MarktFix,
-- `PDP-` for PDP Studio. The product is the Brand Consistency Scanner and the capability
-- under it is the Consistency Engine, which may power more than one scanner surface, so the
-- canonical namespace is `CE-`. `packages/contracts/src/detector-ids.ts` holds the mapping.
--
-- **This migration normalises configuration, and deliberately leaves evidence alone.**
--
-- `oe.offers.detector_families` and `oe.intake_channels.allowed_detectors` are settings: what
-- a SKU can answer, what a form offers. Rewriting them changes nothing anybody claimed, and
-- leaving them in two namespaces would mean every comparison had to remember to canonicalise.
--
-- `oe.findings.detector_id` is NOT touched. A finding carries the id it was produced under,
-- and a reviewer confirmed that claim under that id, bound to that version, in `oe.reviews`.
-- Rewriting it later would change what somebody signed — quietly, and after the fact. The
-- application compares canonically instead (`sameDetector`), so an old finding and a new
-- catalogue entry still answer as the same rule.

DO $rename$
DECLARE
  mapping CONSTANT jsonb := jsonb_build_object(
    'MF-LINK-01',     'CE-LINK-01',
    'MF-ASSET-01',    'CE-ASSET-01',
    'MF-DATA-01',     'CE-DATA-01',
    'PDP-CONTENT-01', 'CE-CONTENT-01',
    'PDP-VISUAL-01',  'CE-VISUAL-01',
    'PDP-MOBILE-01',  'CE-MOBILE-01'
  );
BEGIN
  UPDATE oe.offers
     SET detector_families = ARRAY(
           SELECT coalesce(mapping ->> family, family)
             FROM unnest(detector_families) AS family
         )
   WHERE detector_families && ARRAY(SELECT jsonb_object_keys(mapping));

  UPDATE oe.intake_channels
     SET allowed_detectors = ARRAY(
           SELECT coalesce(mapping ->> detector, detector)
             FROM unnest(allowed_detectors) AS detector
         )
   WHERE allowed_detectors && ARRAY(SELECT jsonb_object_keys(mapping));
END
$rename$;

-- The scan allowlist moves to the Consistency Engine namespace.
--
-- This is the database's copy of "a detector cannot become requestable before it exists", so
-- it has to name the ids this build actually writes. Both spellings stay accepted at the API,
-- which canonicalises before it writes; what lands here is always a `CE-` id.
--
-- Existing scan rows are normalised with the configuration columns above, not left behind:
-- `oe.scans.detectors` is what was asked for, not a claim anybody reviewed, and a scan whose
-- detector list no longer satisfied its own constraint would block every future migration
-- that revalidates it.
UPDATE oe.scans
   SET detectors = ARRAY(
         SELECT CASE d
                  WHEN 'MF-LINK-01' THEN 'CE-LINK-01'
                  WHEN 'MF-ASSET-01' THEN 'CE-ASSET-01'
                  ELSE d
                END
           FROM unnest(detectors) AS d
       )
 WHERE detectors && ARRAY['MF-LINK-01', 'MF-ASSET-01']::text[];

ALTER TABLE oe.scans DROP CONSTRAINT scans_detectors_supported;
ALTER TABLE oe.scans
  ADD CONSTRAINT scans_detectors_supported
  CHECK (detectors <@ ARRAY['CE-LINK-01', 'CE-ASSET-01']::text[] AND cardinality(detectors) >= 1);

-- The column default moves too. Leaving it at `MF-LINK-01` would make every insert that
-- omits `detectors` fail the constraint immediately above — a default and a check that
-- disagree is a trap for whoever writes the next migration, not a safety feature.
ALTER TABLE oe.scans ALTER COLUMN detectors SET DEFAULT ARRAY['CE-LINK-01']::text[];
