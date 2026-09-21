-- Offer catalogue and drafted scopes.
--
-- BUILD_SPEC.md §17: "A catalog SKU needs a version, buyer-facing promise, supported detector
-- families, prerequisites, inclusions, exclusions, deliverables, minimum/maximum estimated
-- effort, price/currency/tax treatment, approval owner, cancellation terms and acceptance
-- tests."
--
-- M2: "Catalog change requires owner and new version; existing quotes remain immutable."
-- Both halves are enforced here rather than trusted: a SKU version is immutable once written,
-- and a draft snapshots the price and scope it was created from.

CREATE TABLE oe.offers (
  tenant_id           uuid NOT NULL REFERENCES oe.tenants(id),
  id                  uuid NOT NULL,
  -- Scoped to the venture that sells it, because membership is. A contractor with access to
  -- one brand has no business reading another brand's price list.
  venture_id          uuid NOT NULL,
  sku                 text NOT NULL CHECK (sku ~ '^[A-Z0-9-]+$'),
  version             integer NOT NULL CHECK (version > 0),
  promise             text NOT NULL CHECK (length(promise) > 0),
  detector_families   text[] NOT NULL CHECK (cardinality(detector_families) > 0),
  inclusions          jsonb NOT NULL CHECK (jsonb_typeof(inclusions) = 'array'),
  exclusions          jsonb NOT NULL CHECK (jsonb_typeof(exclusions) = 'array'),
  prerequisites       jsonb NOT NULL CHECK (jsonb_typeof(prerequisites) = 'array'),
  acceptance          jsonb NOT NULL CHECK (jsonb_typeof(acceptance) = 'array'
                        AND jsonb_array_length(acceptance) > 0),
  -- Commercial price in MINOR units (cents). Deliberately a different scale and column type
  -- from the ledger's provider micro-units, so the two cannot be added by accident.
  currency            char(3) CHECK (currency ~ '^[A-Z]{3}$'),
  price_minor         bigint CHECK (price_minor >= 0),
  tax_treatment       text,
  min_effort_minutes  integer CHECK (min_effort_minutes >= 0),
  max_effort_minutes  integer CHECK (max_effort_minutes >= 0),
  enabled             boolean NOT NULL DEFAULT false,
  approved_by         uuid,
  approved_at         timestamptz,
  approval_note       text,
  created_at          timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, sku, version),
  FOREIGN KEY (tenant_id, venture_id) REFERENCES oe.ventures(tenant_id, id),
  FOREIGN KEY (tenant_id, approved_by) REFERENCES oe.memberships(tenant_id, id),
  CHECK (max_effort_minutes IS NULL OR min_effort_minutes IS NULL
         OR max_effort_minutes >= min_effort_minutes),

  -- The control that matters. An offer cannot be sellable without a price, a currency, a
  -- named approver and a time of approval. The kit's rule — "draft disabled prices until
  -- approved", "no approved invented price" — is a database constraint, not a convention.
  CONSTRAINT offers_enabled_requires_approval CHECK (
    NOT enabled
    OR (price_minor IS NOT NULL AND currency IS NOT NULL
        AND approved_by IS NOT NULL AND approved_at IS NOT NULL)
  )
);

-- A drafted scope: this account, this confirmed need, this catalogue version, this price.
--
-- The price and scope are copied in, not referenced. "Existing quotes remain immutable" means
-- a later catalogue change must not silently reprice a quote already put in front of someone.
CREATE TABLE oe.offer_drafts (
  tenant_id        uuid NOT NULL REFERENCES oe.tenants(id),
  id               uuid NOT NULL,
  opportunity_id   uuid NOT NULL,
  offer_id         uuid NOT NULL,
  offer_sku        text NOT NULL,
  offer_version    integer NOT NULL CHECK (offer_version > 0),
  state            text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'withdrawn', 'superseded')),
  version          integer NOT NULL DEFAULT 1 CHECK (version > 0),

  -- Snapshot, immutable after creation.
  currency         char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  price_minor      bigint NOT NULL CHECK (price_minor >= 0),
  snapshot         jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),

  /* Which confirmed findings, and which root causes, this scope answers. */
  finding_ids      uuid[] NOT NULL CHECK (cardinality(finding_ids) > 0),
  root_cause_keys  text[] NOT NULL CHECK (cardinality(root_cause_keys) > 0),

  created_by       uuid NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  withdrawn_at     timestamptz,
  withdraw_reason  text,

  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, opportunity_id) REFERENCES oe.opportunities(tenant_id, id),
  FOREIGN KEY (tenant_id, offer_id) REFERENCES oe.offers(tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES oe.memberships(tenant_id, id),
  CHECK ((state = 'withdrawn') = (withdrawn_at IS NOT NULL))
);

-- One open draft per opportunity and SKU. A second one would be two prices for one job.
CREATE UNIQUE INDEX offer_drafts_one_open
  ON oe.offer_drafts (tenant_id, opportunity_id, offer_sku)
  WHERE state = 'draft';

CREATE INDEX offers_by_sku ON oe.offers (tenant_id, venture_id, sku, version DESC);
CREATE INDEX offer_drafts_by_opportunity ON oe.offer_drafts (tenant_id, opportunity_id, created_at DESC);

-- Recorded prerequisites.
--
-- A SKU's prerequisites are conditions about the customer, not about us: "authorized
-- code/platform access", "agreed destination", "scope approval". Nothing the engine observes
-- can establish them, so somebody has to say so and be named for saying it — the same shape
-- as a review. Until then a scope can be eligible but not draftable, which is the honest
-- state rather than a blocked one.
CREATE TABLE oe.offer_prerequisites (
  tenant_id     uuid NOT NULL REFERENCES oe.tenants(id),
  id            uuid NOT NULL,
  account_id    uuid NOT NULL,
  prerequisite  text NOT NULL CHECK (length(prerequisite) > 0),
  note          text NOT NULL CHECK (length(note) > 0),
  recorded_by   uuid NOT NULL,
  recorded_at   timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz,
  revoke_reason text,

  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, account_id) REFERENCES oe.accounts(tenant_id, id),
  FOREIGN KEY (tenant_id, recorded_by) REFERENCES oe.memberships(tenant_id, id),
  CHECK ((revoked_at IS NOT NULL) = (revoke_reason IS NOT NULL))
);

-- One live record per (account, prerequisite). Re-recording a revoked one is a new row.
CREATE UNIQUE INDEX offer_prerequisites_live
  ON oe.offer_prerequisites (tenant_id, account_id, prerequisite)
  WHERE revoked_at IS NULL;

ALTER TABLE oe.offer_prerequisites ENABLE ROW LEVEL SECURITY;
ALTER TABLE oe.offer_prerequisites FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON oe.offer_prerequisites
  USING (tenant_id = oe.tenant_context()) WITH CHECK (tenant_id = oe.tenant_context());

-- Delivery capacity. BUILD_SPEC.md §18: "Offers consume a delivery capacity budget as well as
-- an API budget. When the delivery queue is full, stop aggressive acquisition or quote the
-- actual next available delivery window."
CREATE TABLE oe.delivery_capacity (
  tenant_id            uuid NOT NULL REFERENCES oe.tenants(id),
  concurrent_limit     integer NOT NULL CHECK (concurrent_limit >= 0),
  updated_by           uuid NOT NULL,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id),
  FOREIGN KEY (tenant_id, updated_by) REFERENCES oe.memberships(tenant_id, id)
);

ALTER TABLE oe.offers ENABLE ROW LEVEL SECURITY;
ALTER TABLE oe.offers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON oe.offers
  USING (tenant_id = oe.tenant_context()) WITH CHECK (tenant_id = oe.tenant_context());

ALTER TABLE oe.offer_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE oe.offer_drafts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON oe.offer_drafts
  USING (tenant_id = oe.tenant_context()) WITH CHECK (tenant_id = oe.tenant_context());

ALTER TABLE oe.delivery_capacity ENABLE ROW LEVEL SECURITY;
ALTER TABLE oe.delivery_capacity FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON oe.delivery_capacity
  USING (tenant_id = oe.tenant_context()) WITH CHECK (tenant_id = oe.tenant_context());

DO $grants$
DECLARE runtime text := current_setting('oe.runtime_role', true);
BEGIN
  IF runtime IS NULL OR runtime = '' THEN
    RAISE EXCEPTION 'oe.runtime_role must be set for migration 0009';
  END IF;

  -- The catalogue is owner-managed and read by everyone else. A SKU version is never edited
  -- in place: approving a price or changing a scope writes a new version, so a quote already
  -- given keeps pointing at what it quoted.
  EXECUTE format('GRANT SELECT, INSERT ON oe.offers TO %I', runtime);

  -- A draft's price and scope are written once. Only its lifecycle columns move.
  EXECUTE format('GRANT SELECT, INSERT ON oe.offer_drafts TO %I', runtime);
  EXECUTE format('GRANT UPDATE (state, version, withdrawn_at, withdraw_reason) ON oe.offer_drafts TO %I', runtime);

  -- Recorded once, revoked but never edited: what was claimed stays readable.
  EXECUTE format('GRANT SELECT, INSERT ON oe.offer_prerequisites TO %I', runtime);
  EXECUTE format('GRANT UPDATE (revoked_at, revoke_reason) ON oe.offer_prerequisites TO %I', runtime);

  EXECUTE format('GRANT SELECT, INSERT ON oe.delivery_capacity TO %I', runtime);
  EXECUTE format('GRANT UPDATE (concurrent_limit, updated_by, updated_at) ON oe.delivery_capacity TO %I', runtime);
END
$grants$;
