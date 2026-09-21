# Database handoff

001_core.sql is an initial **schema candidate**, not an auto-deploy script. Read docs/architecture/DATA_MODEL.md. No resource/role creation or production changes are authorized.

M0/M1 must map it to the app's migration tooling, create reviewed runtime/identity/budget command permissions, implement persistent transaction adapters, and run the database acceptance tests. The SQL intentionally grants no broad runtime rights; safe denial is preferable to a pretend working authorization system.

Do not execute this against an existing production database or run it repeatedly as an idempotent migration. It uses CREATE statements for a fresh schema; migration tracking belongs to the actual application.
