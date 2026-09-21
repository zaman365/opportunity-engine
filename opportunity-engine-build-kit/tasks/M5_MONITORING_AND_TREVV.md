# M5 · monitoring and delivery handoff

## Outcome

Recheck defined assets at agreed cadence and hand approved engagements to TREVV without duplicate tasks or false success.

## Tasks

Monitoring schedules carry permission expiry, URL/check count, expected cost, total cap and owner. Pause on cap/permission/adapter failure. Group recurring findings by root cause; report new/regressed/resolved states with actual evidence. Triage SLA and repair exclusions are explicit. Do not send unlimited repeated alerts for the same known issue.

Read actual TREVV API/contracts before integration; do not assume package manifests prove endpoints. Use the outbox envelope in INTEGRATIONS.md. Approved minimal data only; sign and deduplicate events. Store receipt/task ref before showing linked-task success. Retries/dead-letter state are actionable in the operator.

## Tests/gate

Schedule timezone/DST; duplicate trigger; cap/permission expiry; missed run; recurrence grouping; changed artifact retention; queued cancel; TREVV unavailable; duplicate delivery; ambiguous response; event schema version change; cross-tenant payload. No hidden retries that create duplicate customer commitments.
