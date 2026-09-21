# Operating runbook

## Setup ownership

Owner approves cloud resources, legal processing/policy, exact live scan targets, spending cap/currency and initial memberships. Engineer configures development/staging/production with distinct identifiers/secrets. Do not infer cloud or GitHub permission from previous conversation claims.

## Secrets and configuration

Use `.env.example` as an inventory, not a working environment. Keep real secrets in provider secret storage/local ignored files. Runtime DB role and migration credential are separate. Access issuer/audience, provider bindings, approved origins and deployment environment are validated at startup. Missing mandatory binding produces an explicit unavailable state and fails readiness, not a fallback demo.

## Before enabling a live adapter

Verify provider agreement, scope, processing location, permission, network deny rules, price snapshot, billing currency and capped operation. Run approved target smoke test with trace and cost. Confirm stop/cancel and artifact deletion. Keep adapter disabled otherwise.

## Deploy

No deployment is included. Add an owner-gated pipeline after M1 tests. Confirm env/tenant/resource names; apply reviewed backward-compatible migration with backup; deploy API; run auth/budget isolation smoke; deploy UI; verify protected report access and absence of fixtures. Migration failure halts release. Record release ID and artifact digest.

## Rollback

Pause new scans first; leave settlement/reconciliation active. Disable failing detector/adapter. Roll back compatible code; do not blindly undo schema after new data exists. Restore only from a tested backup plan and document data-loss window. Validate in-flight workflow compatibility or drain/version old workflows explicitly.

## Incident: cost overrun

Pause new chargeable jobs at authoritative tenant/venture budgets. Reconcile provider operations already underway; retain uncertain reservations. Notify owner with actual vs reserved cost, time window and operation IDs. Fix admission/price logic; test parallel edge case; resume by explicit owner action. A failed card is not cancellation.

## Incident: cross-tenant or exposed evidence

Disable affected route/tokens; revoke report shares; preserve minimal logs; identify scope using object/audit IDs; involve the responsible controller/security owner; follow counsel-approved notification policy. Do not copy exposed customer data into chat or bug reports.

## Routine

Daily while piloting: blocked/failed jobs, unsettled reservations, retention deletions, reviewer queue and capacity. Weekly: detector precision/abstention, actual review/delivery effort, restore/rotation readiness and provider changes. Monitoring alerts need an owner and triage allowance; no implied unlimited support.
