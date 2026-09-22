-- CE-DATA-01 becomes requestable.
--
-- The scan allowlist is the database's copy of "a detector cannot become requestable before it
-- exists". It moves when a rule ships and not before, and it moves in the same commit as the
-- rule, the fixtures and the tests — which is the point of having it here as well as in the
-- request contract and in admission.
ALTER TABLE oe.scans DROP CONSTRAINT scans_detectors_supported;
ALTER TABLE oe.scans
  ADD CONSTRAINT scans_detectors_supported
  CHECK (
    detectors <@ ARRAY['CE-LINK-01', 'CE-ASSET-01', 'CE-DATA-01']::text[]
    AND cardinality(detectors) >= 1
  );
