-- Evidence rows for image subresources (MF-ASSET-01).
--
-- An image observation is an observation in its own right: its own URL, its own HTTP status,
-- its own bytes and its own rendered outcome. Folding it into the page evidence's JSON would
-- make it unciteable — a finding has to point at the exact thing it rests on.
--
-- `kind` stays `http_observation`: we recorded an HTTP response and kept its body. The kit's
-- CHECK on that column is unchanged.
ALTER TABLE oe.evidence DROP CONSTRAINT evidence_capture_role_check;
ALTER TABLE oe.evidence
  ADD CONSTRAINT evidence_capture_role_check
  CHECK (capture_role IN ('source_page', 'link_destination', 'product_image'));

-- Images are subresources of a page, so they never change the page denominator. This index
-- exists so the detector can read one image's observations across sessions cheaply.
CREATE INDEX evidence_by_image ON oe.evidence(tenant_id, scan_id, source_url, session_ordinal)
  WHERE capture_role = 'product_image';

-- A scan may now request both implemented detectors. The constraint stays an allowlist: a
-- detector that is specified but not implemented still cannot be requested.
ALTER TABLE oe.scans DROP CONSTRAINT scans_detectors_supported;
ALTER TABLE oe.scans
  ADD CONSTRAINT scans_detectors_supported
  CHECK (detectors <@ ARRAY['MF-LINK-01', 'MF-ASSET-01']::text[] AND cardinality(detectors) >= 1);
