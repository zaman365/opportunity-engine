-- CE-MOBILE-01 becomes requestable.
--
-- Same rule as every detector before it: the database allowlist moves in the commit that
-- ships the detector, its fixtures and its tests, never ahead of them.
ALTER TABLE oe.scans DROP CONSTRAINT scans_detectors_supported;
ALTER TABLE oe.scans
  ADD CONSTRAINT scans_detectors_supported
  CHECK (
    detectors <@ ARRAY['CE-LINK-01', 'CE-ASSET-01', 'CE-DATA-01', 'CE-MOBILE-01']::text[]
    AND cardinality(detectors) >= 1
  );
