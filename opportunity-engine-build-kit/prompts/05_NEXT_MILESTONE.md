# Advance to the next milestone

Read the current milestone's exit gates and inspect the evidence in PROGRESS.md/VERIFICATION records. Do not advance on file existence or a mocked success. Resolve mandatory current-stage defects first.

Implement the next milestone in IMPLEMENTATION_PLAN.md with its task file, current official provider docs where relevant, and existing shared contracts/design direction. Write tests for negative states alongside the new behavior. Keep the build modular; do not duplicate auth, tenant ownership or budget logic inside a venture adapter.

Keep external authorization separate from local build permission. Do not enable customer data, paid provider use, public intake or production changes by assumption. Record exact readiness and any deliberately deferred work.
