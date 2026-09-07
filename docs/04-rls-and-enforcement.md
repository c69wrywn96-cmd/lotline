# 04 — Row-level security, immutability and audit enforcement

**Status: revised at design review 1.**

Acceptance criterion §12.10 asks for proof *with a query, not a UI screenshot*.
This document specifies the mechanism that makes that possible.

> **Revised in this pass:** `access_grant` now separates **read scope from write
> scope** (OQ-3), so a joint venture reads project-wide and writes only where
> assigned. This does not weaken the subcontractor or supplier fence — see §3.2.

---

## 1. Database roles

| Role | Rights |
|---|---|
| `lotline_owner` | Owns the schema. Migrations only. Never used by the app. |
| `lotline_app` | `LOGIN`, **`NOBYPASSRLS`**. `SELECT/INSERT/UPDATE` on business tables, `INSERT` only on `signature`, `audit_log_entry` and the other insert-only tables. **`DELETE` revoked on every table in the schema.** |
| `lotline_readonly` | Analytics / Power BI export. `SELECT` only, RLS applies identically. |
| `lotline_worker` | Background jobs. As `lotline_app`, but with a service principal identity so job-originated writes are attributable. |

`lotline_app` is deliberately not the table owner — a table owner bypasses RLS
regardless of `NOBYPASSRLS`, which is the single most common way Postgres RLS is
silently defeated.

---

## 2. Session context

Every HTTP request runs inside one transaction. Before any statement:

```sql
BEGIN;
SELECT set_config('app.user_id',      $1, true);   -- true = LOCAL, dies with the txn
SELECT set_config('app.request_id',   $2, true);
SELECT set_config('app.ip',           $3, true);
SELECT set_config('app.user_agent',   $4, true);
SELECT set_config('app.device_id',    $5, true);
SELECT set_config('app.auth_event_id',$6, true);   -- the unlock backing this session
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
predicate's lookup.

### 3.1 Read and write scopes are separate rows

```sql
CREATE TABLE access_grant (
  user_id     uuid  NOT NULL,
  project_id  uuid  NOT NULL,
  grant_kind  text  NOT NULL,   -- 'read' | 'write'
  scope_type  text  NOT NULL,   -- 'project' | 'zone' | 'wbs' | 'package' | 'crew' | 'supplier_org'
  scope_id    uuid,             -- null for scope_type = 'project'
  scope_path  ltree,            -- materialised subtree path for 'zone' and 'wbs'
  side        text  NOT NULL,   -- 'contractor' | 'client' | 'verifier' | 'external'
  PRIMARY KEY (user_id, project_id, grant_kind, scope_type, scope_id)
);
CREATE INDEX ON access_grant USING gist (scope_path);
```

A user holds one or more read rows and zero or more write rows. Typical shapes:

| User | Read grants | Write grants |
|---|---|---|
| JV partner A's Section Engineer | `read/project` | `write/zone` (Zone 3), `write/wbs` (3.2 subtree) |
| JV partner B's Section Engineer | `read/project` | `write/zone` (Zone 5) |
| Quality Manager | `read/project` | `write/project` |
| Superintendent's Rep | `read/project` (side=client) | `write/project` (side=client) — narrowed by permissions, not by scope |
| Independent Verifier | `read/project` (side=verifier) | *(none)* — read + sign only |
| Subcontractor engineer | `read/package` | `write/package` |
| Supplier | `read/supplier_org` | `write/supplier_org` |
| Cadet | `read/project` | `write/zone` |

**Zone and WBS scopes nest.** `scope_path` is the materialised `ltree` path of the
zone or WBS subtree, and `lot` carries `zone_path` and `wbs_path` maintained by
trigger. Containment is then `lot.wbs_path <@ g.scope_path` — a GiST index probe,
not a recursive subquery per row. Write authority over WBS 3.2 covers 3.2.1 and
3.2.1.4 without enumeration.

### 3.2 The read/write split does not widen the external fence

This is the point to be careful about. Project-wide read is a property of
**contractor-side and client-side grants only**. It is issued by the
`project_membership` trigger from the role's `side` and the membership's
`scope_type`:

- `side IN ('contractor','client','verifier')` with a project membership →
  `read/project` + a write grant at the membership's scope.
- `side = 'external'` (subcontractor, supplier) → read **and** write grants both at
  the membership's own narrow scope. **No external membership ever produces a
  `read/project` row.** There is a CHECK on the trigger's output asserting this,
  and a test asserting it.

So a JV partner reads the whole project and writes their sections; a subcontractor
reads and writes only their package; a supplier reads and writes only their own
deliveries. Footnote 1 of the permission matrix is unchanged.

### 3.3 Maintenance

`AFTER INSERT/UPDATE` triggers on `project_membership`, plus on `zone` and
`wbs_element` for re-parenting (which changes `scope_path`). Application code has
no write grant on `access_grant`.

---

## 4. Policy shape

Read policy on `lot`:

```sql
ALTER TABLE lot ENABLE ROW LEVEL SECURITY;
ALTER TABLE lot FORCE ROW LEVEL SECURITY;

CREATE POLICY lot_select ON lot FOR SELECT TO lotline_app, lotline_readonly
USING ( auth.in_scope('read', lot.project_id, lot.zone_path, lot.wbs_path,
                      lot.subcontract_package_id, NULL) );
```

with

```sql
CREATE FUNCTION auth.in_scope(
  p_kind        text,
  p_project_id  uuid,
  p_zone_path   ltree,
  p_wbs_path    ltree,
  p_package_id  uuid,
  p_supplier_id uuid
) RETURNS boolean
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT EXISTS (
    SELECT 1 FROM access_grant g
    WHERE g.user_id    = auth.user_id()
      AND g.project_id = p_project_id
      AND g.grant_kind = p_kind
      AND (
            g.scope_type = 'project'
        OR (g.scope_type = 'zone'         AND p_zone_path   <@ g.scope_path)
        OR (g.scope_type = 'wbs'          AND p_wbs_path    <@ g.scope_path)
        OR (g.scope_type = 'package'      AND g.scope_id     = p_package_id)
        OR (g.scope_type = 'supplier_org' AND g.scope_id     = p_supplier_id)
      )
  );
$$;
```

Write policies use the **same function with `'write'`**, so read and write
authority are structurally the same mechanism with different rows:

```sql
CREATE POLICY lot_insert ON lot FOR INSERT TO lotline_app
WITH CHECK ( auth.in_scope('write', project_id, zone_path, wbs_path,
                           subcontract_package_id, NULL)
             AND auth.has_permission('lot.create', project_id) );

CREATE POLICY lot_update ON lot FOR UPDATE TO lotline_app
USING      ( auth.in_scope('read',  project_id, zone_path, wbs_path,
                           subcontract_package_id, NULL) )
WITH CHECK ( auth.in_scope('write', project_id, zone_path, wbs_path,
                           subcontract_package_id, NULL) );

-- No DELETE policy is created, and DELETE is revoked. Both, deliberately.
```

The `USING`/`WITH CHECK` asymmetry on `UPDATE` is intentional: a JV partner may
*see* a row in another partner's zone (so it appears in registers, maps and
exports) but any attempt to write it fails the `WITH CHECK`. Postgres reports this
as a policy violation, which the application surfaces as "outside your assigned
sections", not as "not found" — because the row is legitimately visible.

`FORCE ROW LEVEL SECURITY` is set on every table so policies apply even if
ownership is ever misconfigured.

### Tables carrying a package fence

`lot`, `itp_instance`, `itp_checkpoint`, `checkpoint_evidence`, `ncr`,
`test_request`, `test_result`, `survey_conformance`, `photo`, `document`,
`permit`, `rfi`, `calibration_record`, `competency_record`,
`retrospective_release`, `hold_release`, `concession`.

`delivery_docket`, `mill_certificate` and `approved_material` additionally admit
`scope_type = 'supplier_org'` — the only door a supplier has.

---

## 5. Proving §12.10 and OQ-3

SQL against a seeded project, no application process involved:

```sql
-- Site Engineer, JV partner A, write scope = Zone 3
SELECT set_config('app.user_id', :eng_a, false);
SELECT count(*) FROM lot;                                    -- all project lots (read/project)
SELECT count(*) FROM lot WHERE zone_code = 'Z5';             -- > 0: partner B's zone IS visible
UPDATE lot SET quantity = 1 WHERE zone_code = 'Z5';          -- ERROR: policy violation
UPDATE lot SET quantity = 1 WHERE lot_number = 'Z3-EW-0142'; -- OK

-- Subcontractor on package P1
SELECT set_config('app.user_id', :sub_p1, false);
SELECT count(*) FROM lot;                                    -- only package P1 lots
SELECT count(*) FROM lot WHERE lot_number = 'Z3-EW-0142';    -- 0
SELECT count(*) FROM itp_checkpoint;                         -- 0 for that lot
SELECT count(*) FROM test_result;                            -- 0 for that lot
SELECT count(*) FROM ncr;                                    -- 0 for that lot
SELECT count(*) FROM photo;                                  -- 0 for that lot
SELECT count(*) FROM audit_log_entry;                        -- 0 rows for that lot

-- No external membership ever yields a project-wide read grant
SELECT count(*) FROM access_grant g
  JOIN project_membership m ON m.user_id = g.user_id
 WHERE g.side = 'external' AND g.scope_type = 'project';     -- must be 0, always

-- Supplier
SELECT set_config('app.user_id', :supplier, false);
SELECT count(*) FROM lot;                                    -- 0, always
SELECT count(*) FROM delivery_docket;                        -- only their own
```

Every assertion is a row count or an error, not a rendered page. The suite runs as
`lotline_app`, so a regression that grants `BYPASSRLS` or forgets `FORCE` fails.

---

## 6. Immutability

Three independent mechanisms, because one is not enough:

1. **`DELETE` revoked** on every table from `lotline_app`, `lotline_worker` and
   `lotline_readonly`. Drizzle's `db.delete()` is additionally banned by an ESLint
   rule so it fails at build time rather than at runtime.

2. **Lock trigger.** `BEFORE UPDATE` on every signable table:

   ```
   IF OLD.locked_at IS NOT NULL
      AND (NEW.* IS DISTINCT FROM OLD.* on any column outside the unfrozen set)
   THEN RAISE EXCEPTION 'LOTLINE_RECORD_LOCKED';
   ```

   The **unfrozen set** is deliberately tiny and enumerated per table:

   | Table | Columns writable after lock | Why |
   |---|---|---|
   | *all* | `superseded_by_id`, `superseded_at`, `supersede_reason_id`, `updated_at`, `updated_by` | Supersession is the only correction mechanism (ADR-0003) |
   | `lot` | `client_accepted_at`, `client_acceptance_signature_id` | Client acceptance arrives after conformance and is an attribute, not a state (G19). Guarded by a `NULL → value` once-only trigger; `value → different value` raises. |

   Nothing else, anywhere, is writable after lock.

3. **Insert-only tables.** `UPDATE` and `DELETE` both revoked on: `signature`,
   `signature_withdrawal`, `authentication_event`, `audit_log_entry`,
   `witness_notification`, `lot_state_event`, `checkpoint_state_event`,
   `permit_approval`, `hold_release`, `retrospective_release`,
   `checkpoint_correction`, `export_record`.

   Note `hold_release` and `retrospective_release` are insert-only but carry
   `superseded_by_id` — which is set by the correction path (C13) through a
   `SECURITY DEFINER` function, not by an application `UPDATE`.

Correction is always supersession: a new row, `superseded_by_id` on the old, a
mandatory reason, both visible in every view and in the conformance pack.

---

## 7. Audit log

Written by trigger, not by application code, so it cannot be forgotten or
bypassed:

```sql
CREATE FUNCTION audit.record() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO audit_log_entry (
    project_id, actor_user_id, action, subject_type, subject_id,
    before_value, after_value, ip_address, user_agent, request_id,
    device_id, auth_event_id, occurred_at
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
    nullif(current_setting('app.device_id', true), '')::uuid,
    nullif(current_setting('app.auth_event_id', true), '')::uuid,
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
- Cross-organisation reads — including **a JV partner reading another partner's
  zone**, which the project-wide read grant now makes routine and which partners
  will want visibility of
- **Every export**, via `export_record` plus an `audit_log_entry` with
  `action='export'` and the filter criteria

Partitioned monthly on `occurred_at`; partitions older than the contract's
`retention_years` are detached to cold object storage rather than dropped.

---

## 8. What is *not* enforced in the database

Stated plainly so the boundary is auditable:

- Field-level UI visibility (presentational, always backed by a row- or
  permission-level rule underneath).
- Rate limiting, CSRF, signed-URL TTL — edge and application concerns.
- Notification routing.
- Authentication strength per action (§7 of `02-state-machines.md`) — enforced in
  the application, but *recorded* in the database: every signature carries
  `authentication_event_id`, so a signature made at insufficient strength is
  detectable after the fact by query, and the acceptance suite asserts none exist.
- The *proposed* severity of a system-raised NCR (assistive; a human confirms).

Everything in `02-state-machines.md` §1–§6 and every row-visibility and
row-writability rule in `03-permission-matrix.md` is enforced below the
application.
