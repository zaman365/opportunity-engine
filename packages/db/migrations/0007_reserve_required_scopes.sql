-- Make the reservation function derive the required scopes itself.
--
-- BUDGET_LEDGER.md: "Clients never choose which parent caps to omit." and "SQL cannot accept
-- client-chosen missing parent caps."
--
-- 0003 trusted the caller to pass a complete scope list. That is only as strong as the one
-- caller that builds it. This version resolves tenant → venture → scan from the scan row and
-- rejects any supplied set that does not match exactly, so omitting a parent cap is a
-- database-level error rather than a code-review convention.
CREATE OR REPLACE FUNCTION oe.reserve_budget(
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
  v_venture    uuid;
  v_required   uuid[];
  v_supplied   uuid[];
  v_alloc_same boolean;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'NO_TENANT_CONTEXT' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_amount_micro IS NULL OR p_amount_micro < 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT' USING ERRCODE = 'check_violation';
  END IF;

  SELECT venture_id INTO v_venture FROM oe.scans WHERE tenant_id = v_tenant AND id = p_scan_id;
  IF v_venture IS NULL THEN
    RAISE EXCEPTION 'UNKNOWN_SCAN' USING ERRCODE = 'foreign_key_violation';
  END IF;

  -- The authoritative scope set, resolved from data rather than from the request.
  SELECT array_agg(id ORDER BY id) INTO v_required
    FROM oe.budgets
   WHERE tenant_id = v_tenant
     AND ((scope_kind = 'tenant'  AND scope_id = v_tenant)
       OR (scope_kind = 'venture' AND scope_id = v_venture)
       OR (scope_kind = 'scan'    AND scope_id = p_scan_id));

  IF v_required IS NULL OR cardinality(v_required) <> 3 THEN
    RAISE EXCEPTION 'MISSING_BUDGET' USING ERRCODE = 'check_violation';
  END IF;

  SELECT array_agg(DISTINCT x ORDER BY x) INTO v_supplied FROM unnest(coalesce(p_budget_ids, '{}'::uuid[])) AS x;
  IF v_supplied IS DISTINCT FROM v_required THEN
    RAISE EXCEPTION 'MISSING_BUDGET' USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO v_existing FROM oe.reservations
   WHERE tenant_id = v_tenant AND operation_key = p_operation_key;
  IF FOUND THEN
    SELECT count(*) = cardinality(v_required)
      INTO v_alloc_same
      FROM oe.reservation_allocations a
     WHERE a.tenant_id = v_tenant AND a.reservation_id = v_existing.id
       AND a.budget_id = ANY (v_required);
    IF v_existing.request_hash <> p_request_hash
       OR v_existing.reserved_micro <> p_amount_micro
       OR v_existing.currency <> p_currency
       OR v_existing.scan_id <> p_scan_id
       OR NOT COALESCE(v_alloc_same, false)
    THEN
      RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT' USING ERRCODE = 'unique_violation';
    END IF;
    RETURN QUERY SELECT v_existing.id, v_existing.state, true;
    RETURN;
  END IF;

  FOR v_budget IN
    SELECT * FROM oe.budgets
     WHERE tenant_id = v_tenant AND id = ANY (v_required)
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
  SELECT v_tenant, gen_random_uuid(), v_id, b, p_amount_micro FROM unnest(v_required) AS b;

  UPDATE oe.budgets SET reserved_micro = reserved_micro + p_amount_micro
   WHERE tenant_id = v_tenant AND id = ANY (v_required);

  RETURN QUERY SELECT v_id, 'reserved'::text, false;
END
$$;
