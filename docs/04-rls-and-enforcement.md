# 04 — Row-level security, immutability and audit enforcement

**Status: proposed, awaiting review.**

Acceptance criterion §12.10 asks for proof *with a query, not a UI screenshot*.
This document specifies the mechanism that makes that possible.

---

## 1. Database roles

| Role | Rights |
|---|---|
| `lotline_owner` | Owns the schema. Used by migrations only. Never used by the app. |
| `lotline_app` | `LOGIN`, **`NOBYPASSRLS`**. `SELECT/INSERT/UPDATE` on business tables, `INSERT` only on `signature` and `audit_log_entry`. **`DELETE` revoked on every table in the schema.** |
| `lotline_readonly` | Analytics / Power BI export. `SELECT` only, RLS applies identically. |
| `lotline_worker` | Background jobs. Same as `lotline_app` but with a service principal identity so job-originated writes are attributable in the audit log. |

`lotline_app` is deliberately not the table owner — a table owner bypasses RLS
regardless of the `NOBYPASSRLS` attribute, which is the single most common way
Postgres RLS is silently defeated.

---

## 2. Session context

Every HTTP request runs inside one transaction. Before any statement:

```sql
BEGIN;
SELECT set_config('app.user_id',    $1, true);   -- true = LOCAL, dies with the txn
SELECT set_config('app.request_id', $2, true);
SELECT set_config('app.ip',         $3, true);
SELECT set_config('app.user_agent', $4, true);
SELECT set_config('app.device_id',  $5, true);
-- ... queries ...
COMMIT;
```

`SET LOCAL` semantics matter: with a connection pooler, a session-scoped `SET`
leaks one user's identity into the next request. The Drizzle client is wrapped so
that obtaining a connection outside a transaction throws — there is no code path
that can issue a query without a bound identity.

```sql
CREATE FUNCTION auth.user_id() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT nullif(current_setting('app.user_id', true), '')::uuid
$$;
```

If `app.user_id` is unset, `auth.user_id()` returns `NULL`, every policy
predicate evaluates false, and every table reads as empty. **Fail closed.**

---

## 3. The `access_grant` projection

RLS predicates run per candidate row. A predicate that joins
`project_membership → role → …` at 10,000 lots is unacceptable, so membership is
flattened by trigger into a narrow table whose primary key is exactly the
predicate's lookup:

```sql
CREATE TABLE access_grant (
  user_id     uuid   NOT NULL,
  project_id  uuid   NOT NULL,
  scope_type  text   NOT NULL,   -- project | zone | package | crew | supplier_org
  scope_id    uuid,              -- null for scope_type = 'project'
  side        text   NOT NULL,   -- contractor | client | verifier | external
  PRIMARY KEY (user_id, project_id, scope_type, scope_id)
);
```

Maintained by `AFTER INSERT/UPDATE` triggers on `project_membership` (and on
`zone`, for zone re-parenting). Application code has no write grant on it.

---

## 4. Policy shape

Read policy on `lot`:

```sql
ALTER TABLE lot ENABLE ROW LEVEL SECURITY;
ALTER TABLE lot FORCE ROW LEVEL SECURITY;

CREATE POLICY lot_select ON lot FOR SELECT TO lotline_app, lotline_readonly
USING (
  EXISTS (
    SELECT 1 FROM access_grant g
    WHERE g.user_id    = auth.user_id()
      AND g.project_id = lot.project_id
      AND (
            g.scope_type = 'project'
        OR (g.scope_type = 'zone'    AND g.scope_id = lot.zone_id)
        OR (g.scope_type = 'package' AND g.scope_id = lot.subcontract_package_id)
      )
  )
);
```

Note there is **no** `scope_type = 'supplier_org'` branch. A supplier therefore
matches no row of `lot` — not filtered in the UI, not filtered in the API:
absent from the relation.

Write policy is separate and narrower:

```sql
CREATE POLICY lot_insert ON lot FOR INSERT TO lotline_app
WITH CHECK ( <same visibility predicate> AND auth.has_permission('lot.create', project_id) );

CREATE POLICY lot_update ON lot FOR UPDATE TO lotline_app
USING ( <same visibility predicate> )
WITH CHECK ( <same visibility predicate> );

-- No DELETE policy is created, and DELETE is revoked. Both, deliberately.
```

`FORCE ROW LEVEL SECURITY` is set on every table so the policy applies even if
ownership is ever misconfigured.

### Tables carrying a package/supplier fence

`lot`, `itp_instance`, `itp_checkpoint`, `checkpoint_evidence`, `ncr`,
`test_request`, `test_result`, `survey_conformance`, `photo`, `document`,
`permit`, `rfi`, `calibration_record`, `competency_record`.

`delivery_docket`, `mill_certificate` and `approved_material` additionally admit
`scope_type = 'supplier_org' AND g.scope_id = <table>.supplier_org_id` — this is
the only door a supplier has.

---

## 5. Proving §12.10

The acceptance test is SQL, run against a seeded project, with no application
process involved:

```sql
-- As the Site Engineer
SELECT set_config('app.user_id', :site_engineer_id, false);
SELECT count(*) FROM lot;                          -- expect: all lots in zone
SELECT count(*) FROM lot WHERE lot_number = 'Z3-EW-0142';   -- expect 1

-- As a subcontractor on a different package
SELECT set_config('app.user_id', :sub_other_package_id, false);
SELECT count(*) FROM lot;                          -- expect: only their package
SELECT count(*) FROM lot WHERE lot_number = 'Z3-EW-0142';   -- expect 0
SELECT count(*) FROM itp_checkpoint;               -- expect 0 for that lot
SELECT count(*) FROM test_result;                  -- expect 0 for that lot
SELECT count(*) FROM ncr;                          -- expect 0 for that lot
SELECT count(*) FROM photo;                        -- expect 0 for that lot
SELECT count(*) FROM audit_log_entry;              -- expect 0 rows for that lot

-- As a supplier
SELECT set_config('app.user_id', :supplier_id, false);
SELECT count(*) FROM lot;                          -- expect 0, always
SELECT count(*) FROM delivery_docket;              -- expect: only their own
```

Every assertion is a row count, not a rendered page. The suite runs each
statement as `lotline_app`, so a regression that grants `BYPASSRLS` or forgets
`FORCE` fails the test.

---

## 6. Immutability

Three independent mechanisms, because one is not enough:

1. **`DELETE` revoked** on every table from `lotline_app`, `lotline_worker` and
   `lotline_readonly`. There is no ORM call that can emit a successful `DELETE`.
   Drizzle's `db.delete()` is additionally banned by an ESLint rule so it fails
   at build time rather than at runtime.
2. **Lock trigger.** `BEFORE UPDATE` on every signable table:

   ```
   IF OLD.locked_at IS NOT NULL
      AND (NEW.* IS DISTINCT FROM OLD.* on any column other than
           superseded_by_id, superseded_at, supersede_reason_id, updated_at, updated_by)
   THEN RAISE EXCEPTION 'LOTLINE_RECORD_LOCKED';
   ```

3. **Insert-only tables.** `signature`, `audit_log_entry`, `witness_notification`,
   `lot_state_event`, `checkpoint_state_event`, `permit_approval`,
   `hold_release`, `export_record`: `UPDATE` and `DELETE` both revoked.

Correction is always supersession: a new row, `superseded_by_id` set on the old,
a mandatory reason, both visible in every view and in the conformance pack.

---

## 7. Audit log

Written by trigger, not by application code, so it cannot be forgotten or
bypassed:

```sql
CREATE FUNCTION audit.record() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO audit_log_entry (
    project_id, actor_user_id, action, subject_type, subject_id,
    before_value, after_value, ip_address, user_agent, request_id, occurred_at
  ) VALUES (
    COALESCE(NEW.project_id, OLD.project_id),
    auth.user_id(),
    lower(TG_OP),
    TG_TABLE_NAME,
    COALESCE(NEW.id, OLD.id),
    CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END,
    CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) END,
    nullif(current_setting('app.ip', true), '')::inet,
    nullif(current_setting('app.user_agent', true), ''),
    nullif(current_setting('app.request_id', true), '')::uuid,
    now()
  );
  RETURN COALESCE(NEW, OLD);
END $$;
```

Attached `AFTER INSERT OR UPDATE` to every business table.

**Reads** are not trigger-able, so restricted reads are logged explicitly by the
data-access layer, and the set of restricted classes is deliberately small so the
log stays useful:

- `ncr_cost_impact` and any commercially sensitive field
- `competency_record` where `is_personal_sensitive`
- `document` where `is_restricted`
- Cross-organisation reads (a client user reading a contractor-internal record)
- **Every export**, via `export_record` plus an `audit_log_entry` with
  `action='export'` and the filter criteria

Partitioned monthly on `occurred_at`; partitions older than the contract's
`retention_years` are detached to cold object storage rather than dropped.

---

## 8. What is *not* enforced in the database

Stated plainly so the boundary is auditable:

- Field-level UI visibility (a presentational concern, always backed by a
  row- or permission-level rule underneath).
- Rate limiting, CSRF, signed-URL TTL — edge and application concerns.
- Notification routing.
- The *proposed* severity of a system-raised NCR (assistive; a human confirms).

Everything in `02-state-machines.md` and every row-visibility rule in
`03-permission-matrix.md` is enforced below the application.
