-- Accepted scope, and the work that follows it.
--
-- WORKFLOWS.md, engagement lifecycle: "No start before accepted offer version, required
-- permissions and payment/contract prerequisites. Acceptance follows verified work plus
-- customer/authorized owner acceptance, not a 'payment succeeded' webhook. Scope change
-- creates a new approved version."
--
-- The clause that shapes this table is the third. An engagement is bound to one offer draft,
-- and a draft is immutable once written; changing the scope therefore means a new draft and a
-- new engagement, not an edit here. That is why there is no scope column to update.

CREATE TABLE oe.engagements (
  tenant_id        uuid NOT NULL REFERENCES oe.tenants(id),
  id               uuid NOT NULL,
  opportunity_id   uuid NOT NULL,
  account_id       uuid NOT NULL,

  -- The quote this is work against. The draft holds the snapshot of price and scope, so it is
  -- not copied again here: two copies of a number is two chances for them to disagree.
  offer_draft_id   uuid NOT NULL,

  state            text NOT NULL DEFAULT 'draft'
                     CHECK (state IN ('draft', 'awaiting_acceptance', 'awaiting_prerequisites',
                                      'ready', 'in_progress', 'awaiting_verification',
                                      'accepted', 'change_requested', 'disputed', 'cancelled',
                                      'closed')),
  version          integer NOT NULL DEFAULT 1 CHECK (version > 0),

  -- Customer acceptance: when, and how it was obtained. Not a boolean — "they accepted" with
  -- no record of how is an assertion nobody can check, and this is the row a dispute turns on.
  accepted_at      timestamptz,
  acceptance_note  text,
  -- The member who recorded the acceptance. They are attesting that it happened, the way a
  -- reviewer attests to a finding.
  accepted_by      uuid,

  -- Why a side state was entered, and who put it there. WORKFLOWS.md: "Side states
  -- change_requested, cancelled and disputed have explicit reason/owner."
  side_reason      text,
  side_owner       uuid,

  created_by       uuid NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, opportunity_id) REFERENCES oe.opportunities(tenant_id, id),
  FOREIGN KEY (tenant_id, account_id) REFERENCES oe.accounts(tenant_id, id),
  FOREIGN KEY (tenant_id, offer_draft_id) REFERENCES oe.offer_drafts(tenant_id, id),
  FOREIGN KEY (tenant_id, accepted_by) REFERENCES oe.memberships(tenant_id, id),
  FOREIGN KEY (tenant_id, side_owner) REFERENCES oe.memberships(tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES oe.memberships(tenant_id, id),

  -- An acceptance is a time, a note and a person, or it is none of them.
  CONSTRAINT engagements_acceptance_complete CHECK (
    (accepted_at IS NULL AND acceptance_note IS NULL AND accepted_by IS NULL)
    OR (accepted_at IS NOT NULL AND acceptance_note IS NOT NULL AND accepted_by IS NOT NULL)
  ),

  -- Nothing past acceptance can exist without it. This is the rule that keeps "no start
  -- before an accepted offer version" true even against a caller that skipped the service.
  CONSTRAINT engagements_no_start_before_acceptance CHECK (
    state IN ('draft', 'awaiting_acceptance', 'cancelled', 'change_requested')
    OR accepted_at IS NOT NULL
  ),

  -- A side state names its reason and its owner.
  CONSTRAINT engagements_side_state_explained CHECK (
    state NOT IN ('change_requested', 'disputed', 'cancelled')
    OR (side_reason IS NOT NULL AND side_owner IS NOT NULL)
  )
);

-- One live engagement per drafted scope. A second would be two commitments to do one job.
CREATE UNIQUE INDEX engagements_one_live_per_draft
  ON oe.engagements (tenant_id, offer_draft_id)
  WHERE state NOT IN ('cancelled', 'closed');

CREATE INDEX engagements_by_account ON oe.engagements (tenant_id, account_id, created_at DESC);

-- Every transition, append-only. The state column says where a thing is; this says how it got
-- there, which is what a dispute actually needs.
CREATE TABLE oe.engagement_events (
  tenant_id      uuid NOT NULL REFERENCES oe.tenants(id),
  id             uuid NOT NULL,
  engagement_id  uuid NOT NULL,
  from_state     text NOT NULL,
  to_state       text NOT NULL,
  -- The engagement version this event produced, so an event and a row can be lined up.
  to_version     integer NOT NULL CHECK (to_version > 0),
  reason         text NOT NULL CHECK (length(reason) > 0),
  actor_id       uuid NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, engagement_id) REFERENCES oe.engagements(tenant_id, id),
  FOREIGN KEY (tenant_id, actor_id) REFERENCES oe.memberships(tenant_id, id),
  UNIQUE (tenant_id, engagement_id, to_version)
);

-- Manual invoice and payment status.
--
-- M3/M4: "manual invoice/payment-status record with audit... Optional hosted checkout requires
-- separate integration tests and authorization; never handle card numbers."
--
-- There is no card column, no processor token and no webhook. Somebody types what happened and
-- is named for typing it. That is worth more than an integration nobody authorised, and it
-- cannot leak what it never held.
CREATE TABLE oe.payment_records (
  tenant_id       uuid NOT NULL REFERENCES oe.tenants(id),
  id              uuid NOT NULL,
  engagement_id   uuid NOT NULL,

  kind            text NOT NULL CHECK (kind IN ('invoice_issued', 'payment_received',
                                                'refund_issued', 'written_off')),
  -- Minor units, matching the draft's currency. The same scale as the catalogue, and
  -- deliberately not the ledger's provider micro-units.
  currency        char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  amount_minor    bigint NOT NULL CHECK (amount_minor >= 0),

  -- The operator's own reference: an invoice number, a bank reference. Free text, because
  -- this system is not the accounting system and should not pretend to be.
  external_ref    text NOT NULL CHECK (length(external_ref) > 0),
  note            text NOT NULL CHECK (length(note) > 0),
  occurred_at     timestamptz NOT NULL,

  recorded_by     uuid NOT NULL,
  recorded_at     timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, engagement_id) REFERENCES oe.engagements(tenant_id, id),
  FOREIGN KEY (tenant_id, recorded_by) REFERENCES oe.memberships(tenant_id, id)
);

CREATE INDEX payment_records_by_engagement
  ON oe.payment_records (tenant_id, engagement_id, occurred_at DESC);

ALTER TABLE oe.engagements ENABLE ROW LEVEL SECURITY;
ALTER TABLE oe.engagements FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON oe.engagements
  USING (tenant_id = oe.tenant_context()) WITH CHECK (tenant_id = oe.tenant_context());

ALTER TABLE oe.engagement_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE oe.engagement_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON oe.engagement_events
  USING (tenant_id = oe.tenant_context()) WITH CHECK (tenant_id = oe.tenant_context());

ALTER TABLE oe.payment_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE oe.payment_records FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON oe.payment_records
  USING (tenant_id = oe.tenant_context()) WITH CHECK (tenant_id = oe.tenant_context());

DO $grants$
DECLARE runtime text := current_setting('oe.runtime_role', true);
BEGIN
  IF runtime IS NULL OR runtime = '' THEN
    RAISE EXCEPTION 'oe.runtime_role must be set for migration 0013';
  END IF;

  -- The scope an engagement is against is fixed at creation: the draft id is not updatable,
  -- so "scope change creates a new approved version" holds against a caller that skipped the
  -- service layer as well as one that did not.
  EXECUTE format('GRANT SELECT, INSERT ON oe.engagements TO %I', runtime);
  EXECUTE format($g$
    GRANT UPDATE (state, version, accepted_at, acceptance_note, accepted_by,
                  side_reason, side_owner, updated_at)
      ON oe.engagements TO %I
  $g$, runtime);

  -- Append-only, both of them. History that can be edited is not history.
  EXECUTE format('GRANT SELECT, INSERT ON oe.engagement_events TO %I', runtime);
  EXECUTE format('GRANT SELECT, INSERT ON oe.payment_records TO %I', runtime);
END
$grants$;
