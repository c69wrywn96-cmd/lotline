-- 0011 — System-maintained tables write as the owner.
--
-- access_grant and audit_log_entry are maintained BY THE DATABASE, never by
-- application code — that is the whole point of both. The triggers that maintain
-- them therefore run SECURITY DEFINER, and both tables are ENABLE (not FORCE)
-- ROW LEVEL SECURITY.
--
-- Why NO FORCE is correct here, and is not a weakening:
--   * FORCE makes policies apply to the table OWNER as well. The owner is used
--     only by migrations and by these SECURITY DEFINER triggers.
--   * lotline_app / lotline_worker / lotline_readonly do NOT own these tables,
--     so ordinary RLS still applies to them in full, and their SELECT policies
--     are unchanged.
--   * The application additionally holds no INSERT/UPDATE/DELETE grant on
--     access_grant, and no UPDATE/DELETE on audit_log_entry.
-- Without this, the projection cannot write under a non-superuser owner — which
-- is the production configuration — so the alternative is a system that works in
-- development and fails on deployment.

ALTER TABLE access_grant    NO FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_log_entry NO FORCE ROW LEVEL SECURITY;

-- Projection functions run as owner so they may maintain access_grant.
-- search_path is pinned: a SECURITY DEFINER function with a mutable search_path
-- is a privilege-escalation vector.
ALTER FUNCTION auth.project_grants_rebuild(uuid)   SECURITY DEFINER SET search_path = public, auth;
ALTER FUNCTION auth.org_grants_rebuild(uuid)       SECURITY DEFINER SET search_path = public, auth;
ALTER FUNCTION auth.tg_project_membership_grants() SECURITY DEFINER SET search_path = public, auth;
ALTER FUNCTION auth.tg_org_membership_grants()     SECURITY DEFINER SET search_path = public, auth;
ALTER FUNCTION auth.tg_participant_grants()        SECURITY DEFINER SET search_path = public, auth;
ALTER FUNCTION auth.tg_resync_scope_paths()        SECURITY DEFINER SET search_path = public, auth;
ALTER FUNCTION auth.scope_path_for(text, uuid)     SECURITY DEFINER SET search_path = public, auth;

-- Path maintenance touches sibling rows in the same table; it must not be
-- constrained by the caller's write scope, or re-parenting a zone would fail
-- halfway through a subtree and leave paths inconsistent.
ALTER FUNCTION public.cascade_zone_path() SECURITY DEFINER SET search_path = public, auth;
ALTER FUNCTION public.cascade_wbs_path()  SECURITY DEFINER SET search_path = public, auth;

-- audit.record() is already SECURITY DEFINER; pin its search_path explicitly.
ALTER FUNCTION audit.record() SET search_path = public, auth, audit;

COMMENT ON TABLE access_grant IS
  'Trigger-maintained projection of project_membership and org_membership. Never written by application code (ADR-0020, ADR-0023). ENABLE but NO FORCE row security: the maintaining triggers run as owner; every application role is non-owner and fully policed.';
COMMENT ON TABLE audit_log_entry IS
  'Append-only audit log, written by trigger from session GUCs (ADR-0013). ENABLE but NO FORCE row security, for the same reason as access_grant.';
