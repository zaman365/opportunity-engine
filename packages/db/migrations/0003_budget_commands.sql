-- Budget command functions.
--
-- BUDGET_LEDGER.md: "Production must implement this as an authoritative database operation
-- with restricted execute permissions; an in-memory copy of the reference ledger is not
-- acceptable. Runtime CRUD permissions must not permit manually bypassing the ledger."
--
-- The runtime role has SELECT only on oe.budgets / oe.reservations /
-- oe.reservation_allocations (migration 0002). These SECURITY DEFINER functions are the
-- single write path. FORCE ROW LEVEL SECURITY on those tables applies to the definer too,
-- so a function still cannot touch another tenant's rows: the transaction-local
-- oe.tenant_id setting decides what is visible, exactly as for a direct query.

-- Reserve `amount_micro` against every supplied budget scope, atomically.
-- The caller passes the scope IDs the server resolved; the function re-checks that the set
-- matches what the scan actually requires, so a client can never omit a parent cap.
CREATE FUNCTION oe.reserve_budget(
  p_scan_id       uuid,
  p_operation_key text,
  p_request_hash  text,
  p_currency      char(3),
  p_amount_micro  bigint,
  p_budget_ids    uuid[]
) RETURNS TABLE (reservation_id uuid, state text, replayed boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = oe, pg_catalog AS $$
DECLARE
  v_tenant     uuid := oe.tenant_context();
  v_existing   oe.reservations%ROWTYPE;
  v_budget     oe.budgets%ROWTYPE;
  v_id         uuid;
  v_count      integer;
  v_alloc_same boolean;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'NO_TENANT_CONTEXT' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_amount_micro IS NULL OR p_amount_micro < 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT' USING ERRCODE = 'check_violation';
  END IF;
  IF p_budget_ids IS NULL OR cardinality(p_budget_ids) = 0 THEN
    RAISE EXCEPTION 'MISSING_BUDGET' USING ERRCODE = 'check_violation';
  END IF;
  IF cardinality(p_budget_ids) <> (SELECT count(DISTINCT x) FROM unnest(p_budget_ids) AS x) THEN
    RAISE EXCEPTION 'INVALID_SCOPE' USING ERRCODE = 'check_violation';
  END IF;

  -- Idempotency: the same operation key must carry the same request hash, amount, currency
  -- and scope set, or the caller changed the operation underneath a retry.
  SELECT * INTO v_existing FROM oe.reservations
   WHERE tenant_id = v_tenant AND operation_key = p_operation_key;
  IF FOUND THEN
    SELECT count(*) = cardinality(p_budget_ids)
      INTO v_alloc_same
      FROM oe.reservation_allocations a
     WHERE a.tenant_id = v_tenant AND a.reservation_id = v_existing.id
       AND a.budget_id = ANY (p_budget_ids);
    IF v_existing.request_hash <> p_request_hash
       OR v_existing.reserved_micro <> p_amount_micro
       OR v_existing.currency <> p_currency
       OR v_existing.scan_id <> p_scan_id
       OR NOT COALESCE(v_alloc_same, false)
       OR (SELECT count(*) FROM oe.reservation_allocations a
            WHERE a.tenant_id = v_tenant AND a.reservation_id = v_existing.id)
          <> cardinality(p_budget_ids)
    THEN
      RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT' USING ERRCODE = 'unique_violation';
    END IF;
    RETURN QUERY SELECT v_existing.id, v_existing.state, true;
    RETURN;
  END IF;

  -- Lock every applicable budget in a stable order so two concurrent admissions cannot
  -- deadlock and cannot both read a stale balance.
  SELECT count(*) INTO v_count FROM oe.budgets
   WHERE tenant_id = v_tenant AND id = ANY (p_budget_ids);
  IF v_count <> cardinality(p_budget_ids) THEN
    RAISE EXCEPTION 'UNKNOWN_BUDGET' USING ERRCODE = 'foreign_key_violation';
  END IF;

  FOR v_budget IN
    SELECT * FROM oe.budgets
     WHERE tenant_id = v_tenant AND id = ANY (p_budget_ids)
     ORDER BY id
     FOR UPDATE
  LOOP
    IF v_budget.currency <> p_currency THEN
      RAISE EXCEPTION 'CURRENCY_MISMATCH' USING ERRCODE = 'check_violation';
    END IF;
    IF v_budget.paused THEN
      RAISE EXCEPTION 'BUDGET_PAUSED' USING ERRCODE = 'check_violation';
    END IF;
    IF v_budget.settled_micro + v_budget.reserved_micro + p_amount_micro > v_budget.limit_micro THEN
      RAISE EXCEPTION 'BUDGET_EXCEEDED' USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;

  v_id := gen_random_uuid();
  INSERT INTO oe.reservations (tenant_id, id, scan_id, operation_key, request_hash,
                               currency, reserved_micro, state)
  VALUES (v_tenant, v_id, p_scan_id, p_operation_key, p_request_hash,
          p_currency, p_amount_micro, 'reserved');

  INSERT INTO oe.reservation_allocations (tenant_id, id, reservation_id, budget_id, reserved_micro)
  SELECT v_tenant, gen_random_uuid(), v_id, b, p_amount_micro FROM unnest(p_budget_ids) AS b;

  UPDATE oe.budgets SET reserved_micro = reserved_micro + p_amount_micro
   WHERE tenant_id = v_tenant AND id = ANY (p_budget_ids);

  RETURN QUERY SELECT v_id, 'reserved'::text, false;
END
$$;

-- Settle an operation with its actual recorded cost.
-- An overrun is recorded as real spend and pauses every affected scope; it is never
-- discarded to keep the cap invariant looking clean.
CREATE FUNCTION oe.settle_reservation(
  p_operation_key      text,
  p_actual_micro       bigint,
  p_provider_request_id text
) RETURNS TABLE (reservation_id uuid, overrun boolean, replayed boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = oe, pg_catalog AS $$
DECLARE
  v_tenant uuid := oe.tenant_context();
  v_res    oe.reservations%ROWTYPE;
  v_over   boolean;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'NO_TENANT_CONTEXT' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_actual_micro IS NULL OR p_actual_micro < 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT' USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO v_res FROM oe.reservations
   WHERE tenant_id = v_tenant AND operation_key = p_operation_key FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'UNKNOWN_RESERVATION' USING ERRCODE = 'no_data_found';
  END IF;

  IF v_res.state = 'settled' THEN
    IF v_res.actual_micro <> p_actual_micro THEN
      RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT' USING ERRCODE = 'unique_violation';
    END IF;
    RETURN QUERY SELECT v_res.id, v_res.actual_micro > v_res.reserved_micro, true;
    RETURN;
  END IF;
  IF v_res.state NOT IN ('reserved', 'uncertain') THEN
    RAISE EXCEPTION 'INVALID_TRANSITION' USING ERRCODE = 'check_violation';
  END IF;

  v_over := p_actual_micro > v_res.reserved_micro;

  UPDATE oe.budgets b
     SET reserved_micro = b.reserved_micro - a.reserved_micro,
         settled_micro  = b.settled_micro + p_actual_micro,
         paused = b.paused
                  OR v_over
                  OR (b.settled_micro + p_actual_micro
                      + (b.reserved_micro - a.reserved_micro)) > b.limit_micro
    FROM oe.reservation_allocations a
   WHERE a.tenant_id = v_tenant AND a.reservation_id = v_res.id
     AND b.tenant_id = v_tenant AND b.id = a.budget_id;

  UPDATE oe.reservations
     SET state = 'settled', actual_micro = p_actual_micro,
         provider_request_id = COALESCE(p_provider_request_id, provider_request_id)
   WHERE tenant_id = v_tenant AND id = v_res.id;

  RETURN QUERY SELECT v_res.id, v_over, false;
END
$$;

-- Release a reservation. Requires the caller to assert reconciled evidence that no provider
-- charge was incurred: a timeout is not proof of zero charge (BUDGET_LEDGER.md).
CREATE FUNCTION oe.release_reservation(
  p_operation_key       text,
  p_confirmed_no_charge boolean
) RETURNS TABLE (reservation_id uuid, replayed boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = oe, pg_catalog AS $$
DECLARE
  v_tenant uuid := oe.tenant_context();
  v_res    oe.reservations%ROWTYPE;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'NO_TENANT_CONTEXT' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_confirmed_no_charge IS NOT TRUE THEN
    RAISE EXCEPTION 'RECONCILIATION_REQUIRED' USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO v_res FROM oe.reservations
   WHERE tenant_id = v_tenant AND operation_key = p_operation_key FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'UNKNOWN_RESERVATION' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_res.state = 'released' THEN
    RETURN QUERY SELECT v_res.id, true;
    RETURN;
  END IF;
  IF v_res.state NOT IN ('reserved', 'uncertain') THEN
    RAISE EXCEPTION 'INVALID_TRANSITION' USING ERRCODE = 'check_violation';
  END IF;

  UPDATE oe.budgets b
     SET reserved_micro = b.reserved_micro - a.reserved_micro
    FROM oe.reservation_allocations a
   WHERE a.tenant_id = v_tenant AND a.reservation_id = v_res.id
     AND b.tenant_id = v_tenant AND b.id = a.budget_id;

  UPDATE oe.reservations SET state = 'released'
   WHERE tenant_id = v_tenant AND id = v_res.id;

  RETURN QUERY SELECT v_res.id, false;
END
$$;

-- An ambiguous provider response keeps consuming the reserved allowance until reconciled.
CREATE FUNCTION oe.mark_reservation_uncertain(p_operation_key text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = oe, pg_catalog AS $$
DECLARE
  v_tenant uuid := oe.tenant_context();
  v_res    oe.reservations%ROWTYPE;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'NO_TENANT_CONTEXT' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO v_res FROM oe.reservations
   WHERE tenant_id = v_tenant AND operation_key = p_operation_key FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'UNKNOWN_RESERVATION' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_res.state = 'uncertain' THEN RETURN v_res.id; END IF;
  IF v_res.state <> 'reserved' THEN
    RAISE EXCEPTION 'INVALID_TRANSITION' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE oe.reservations SET state = 'uncertain'
   WHERE tenant_id = v_tenant AND id = v_res.id;
  RETURN v_res.id;
END
$$;

-- Owner-only configuration commands. Settled history is never rewritten, and resuming an
-- overrun pause requires a recorded reason (API_GUIDE.md "Owner setup").
CREATE FUNCTION oe.configure_budget(
  p_budget_id       uuid,
  p_expected_version integer,
  p_limit_micro     bigint,
  p_currency        char(3)
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = oe, pg_catalog AS $$
DECLARE
  v_tenant  uuid := oe.tenant_context();
  v_budget  oe.budgets%ROWTYPE;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'NO_TENANT_CONTEXT' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO v_budget FROM oe.budgets
   WHERE tenant_id = v_tenant AND id = p_budget_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'UNKNOWN_BUDGET' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_budget.version <> p_expected_version THEN
    RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE = 'serialization_failure';
  END IF;
  IF v_budget.currency <> p_currency THEN
    RAISE EXCEPTION 'CURRENCY_MISMATCH' USING ERRCODE = 'check_violation';
  END IF;
  IF p_limit_micro < v_budget.settled_micro + v_budget.reserved_micro THEN
    RAISE EXCEPTION 'LIMIT_BELOW_COMMITTED' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE oe.budgets SET limit_micro = p_limit_micro, version = version + 1
   WHERE tenant_id = v_tenant AND id = p_budget_id;
  RETURN v_budget.version + 1;
END
$$;

CREATE FUNCTION oe.set_budget_paused(
  p_budget_id        uuid,
  p_expected_version integer,
  p_paused           boolean
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = oe, pg_catalog AS $$
DECLARE
  v_tenant uuid := oe.tenant_context();
  v_budget oe.budgets%ROWTYPE;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'NO_TENANT_CONTEXT' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO v_budget FROM oe.budgets
   WHERE tenant_id = v_tenant AND id = p_budget_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'UNKNOWN_BUDGET' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_budget.version <> p_expected_version THEN
    RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE = 'serialization_failure';
  END IF;
  -- Resuming while committed spend already exceeds the cap would immediately re-breach it.
  IF p_paused IS FALSE
     AND v_budget.settled_micro + v_budget.reserved_micro > v_budget.limit_micro THEN
    RAISE EXCEPTION 'OVERRUN_NOT_RECONCILED' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE oe.budgets SET paused = p_paused, version = version + 1
   WHERE tenant_id = v_tenant AND id = p_budget_id;
  RETURN v_budget.version + 1;
END
$$;

-- Owner bootstrap of a budget row. Budgets are created paused; the owner explicitly resumes.
CREATE FUNCTION oe.create_budget(
  p_id          uuid,
  p_scope_kind  text,
  p_scope_id    uuid,
  p_currency    char(3),
  p_limit_micro bigint,
  p_paused      boolean
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = oe, pg_catalog AS $$
DECLARE
  v_tenant uuid := oe.tenant_context();
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'NO_TENANT_CONTEXT' USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO oe.budgets (tenant_id, id, scope_kind, scope_id, currency, limit_micro, paused)
  VALUES (v_tenant, p_id, p_scope_kind, p_scope_id, p_currency, p_limit_micro, p_paused);
  RETURN p_id;
END
$$;

REVOKE ALL ON FUNCTION oe.reserve_budget(uuid, text, text, char(3), bigint, uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION oe.settle_reservation(text, bigint, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION oe.release_reservation(text, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION oe.mark_reservation_uncertain(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION oe.configure_budget(uuid, integer, bigint, char(3)) FROM PUBLIC;
REVOKE ALL ON FUNCTION oe.set_budget_paused(uuid, integer, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION oe.create_budget(uuid, text, uuid, char(3), bigint, boolean) FROM PUBLIC;

DO $grants$
DECLARE runtime text := current_setting('oe.runtime_role', true);
BEGIN
  IF runtime IS NULL OR runtime = '' THEN
    RAISE EXCEPTION 'oe.runtime_role must be set for migration 0003';
  END IF;
  EXECUTE format('GRANT EXECUTE ON FUNCTION oe.reserve_budget(uuid, text, text, char(3), bigint, uuid[]) TO %I', runtime);
  EXECUTE format('GRANT EXECUTE ON FUNCTION oe.settle_reservation(text, bigint, text) TO %I', runtime);
  EXECUTE format('GRANT EXECUTE ON FUNCTION oe.release_reservation(text, boolean) TO %I', runtime);
  EXECUTE format('GRANT EXECUTE ON FUNCTION oe.mark_reservation_uncertain(text) TO %I', runtime);
  EXECUTE format('GRANT EXECUTE ON FUNCTION oe.configure_budget(uuid, integer, bigint, char(3)) TO %I', runtime);
  EXECUTE format('GRANT EXECUTE ON FUNCTION oe.set_budget_paused(uuid, integer, boolean) TO %I', runtime);
  EXECUTE format('GRANT EXECUTE ON FUNCTION oe.create_budget(uuid, text, uuid, char(3), bigint, boolean) TO %I', runtime);
END
$grants$;
