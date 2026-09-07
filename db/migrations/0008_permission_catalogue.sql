-- 0008 — The permission catalogue and the system role templates.
--
-- Reference data, shipped as a migration because the RBAC engine is meaningless
-- without it and because role_permission rows are referenced by tests.
--
-- min_auth_strength implements 03-permission-matrix.md §10: a hold point release
-- needs step-up, a photo upload does not. device_bound_allowed implements the
-- shared-tablet capability restriction — a Quality Manager signed in on a site
-- tablet holds their field permissions and nothing else.

INSERT INTO permission (code, resource, action, description, min_auth_strength, device_bound_allowed) VALUES
-- Lot
('lot.view','lot','view','View lots in scope','session',true),
('lot.create','lot','create','Create a draft lot','session',true),
('lot.raise','lot','raise','Raise a draft lot to Open (G1)','device_unlock',true),
('lot.edit','lot','edit','Edit lot metadata','session',true),
('lot.geometry.edit','lot','geometry.edit','Draw or amend lot geometry','session',true),
('lot.assign','lot','assign','Assign a responsible engineer','session',true),
('lot.bulk_create','lot','bulk_create','Raise lots in bulk from a template','device_unlock',false),
('lot.submit','lot','submit','Submit a lot to the client for acceptance (G14)','step_up',true),
('lot.certify_conformance','lot','certify_conformance','Certify lot conformance (G15)','step_up',true),
('lot.closeout.approve','lot','closeout.approve','Approve lot closeout','step_up',true),
('lot.accept','lot','accept','Client acceptance of a lot (G16, G19)','step_up',true),
('lot.reject','lot','reject','Client rejection of a submitted lot','step_up',true),
('lot.hold.impose','lot','hold.impose','Impose a stop-work hold (G5)','device_unlock',true),
('lot.hold.lift','lot','hold.lift','Lift a stop-work hold (G11)','step_up',true),
('lot.determine_non_conforming','lot','determine_non_conforming','Determine a lot non-conforming (G12)','step_up',true),
('lot.supersede','lot','supersede','Supersede a lot (G17, G18)','step_up',false),
('lot.export','lot','export','Export the lot register','session',false),
-- ITP and checkpoints
('itp.master.view','itp','master.view','View the master ITP library','session',true),
('itp.master.author','itp','master.author','Author a master ITP version','session',false),
('itp.master.approve.technical','itp','master.approve.technical','Technically approve a master ITP','step_up',false),
('itp.master.publish','itp','master.publish','Publish a master ITP version','step_up',false),
('itp.master.withdraw','itp','master.withdraw','Withdraw a master ITP version','step_up',false),
('itp.instance.view','itp','instance.view','View an ITP instance','session',true),
('checkpoint.action','checkpoint','action','Action a checkpoint (C1)','session',true),
('checkpoint.evidence.attach','checkpoint','evidence.attach','Attach evidence to a checkpoint','session',true),
('checkpoint.sign','checkpoint','sign','Sign a checkpoint (C6)','device_unlock',true),
('checkpoint.hold.release','checkpoint','hold.release','Release a hold point (C9)','step_up',true),
('checkpoint.hold.release.retrospective','checkpoint','hold.release.retrospective','Record a retrospective hold release (ADR-0019)','step_up',true),
('checkpoint.witness.notify','checkpoint','witness.notify','Issue a witness point notice (C2)','session',true),
('checkpoint.witness.record_outcome','checkpoint','witness.record_outcome','Record a witness point outcome','device_unlock',true),
('checkpoint.mark_not_applicable','checkpoint','mark_not_applicable','Mark a checkpoint not applicable (C8)','step_up',false),
('checkpoint.correct','checkpoint','correct','Correct a mis-signed checkpoint (C13)','step_up',false),
('checkpoint.correct.countersign','checkpoint','correct.countersign','Counter-sign a checkpoint correction','step_up',false),
('signature.withdraw','signature','withdraw','Withdraw a signature','step_up',false),
('signature.withdraw.countersign','signature','withdraw.countersign','Counter-sign a signature withdrawal (ADR-0023)','step_up',false),
('concession.request','concession','request','Request a concession','session',true),
('concession.approve.em','concession','approve.em','Engineering Manager concession approval','step_up',false),
('concession.approve.client','concession','approve.client','Client concession approval','step_up',false),
-- Administration
('admin.project.configure','admin','project.configure','Configure a project','step_up',false),
('admin.users.manage','admin','users.manage','Manage users','step_up',false),
('admin.roles.manage','admin','roles.manage','Manage roles and permissions','step_up',false),
('admin.permission_grant.issue','admin','permission_grant.issue','Issue a time-boxed permission grant','step_up',false),
('admin.delegation.create','admin','delegation.create','Create an acting-for delegation','step_up',false),
('admin.standards.manage','admin','standards.manage','Manage the standards library','session',false),
('admin.acceptance_scheme.manage','admin','acceptance_scheme.manage','Manage acceptance schemes','step_up',false),
('admin.integration.configure','admin','integration.configure','Configure integrations','step_up',false),
('admin.idp.configure','admin','idp.configure','Configure federated identity providers','step_up',false),
('admin.device.enrol','admin','device.enrol','Enrol a trusted device','step_up',false),
('admin.device.revoke','admin','device.revoke','Revoke a trusted device','step_up',false),
('admin.device.user_enrol','admin','device.user_enrol','Bind a user to a trusted device','step_up',false),
('api.key.manage','api','key.manage','Manage API keys','step_up',false),
-- Registers and audit
('qa_audit.schedule','qa_audit','schedule','Schedule an audit','session',false),
('qa_audit.conduct','qa_audit','conduct','Conduct an audit','session',true),
('export.data','export','data','Export data','session',false),
('export.audit_log','export','audit_log','Export the audit log','step_up',false),
('pc.sign','pc','sign','Sign Practical Completion','step_up',false);

-- ---------------------------------------------------------------------------
-- System role templates
-- ---------------------------------------------------------------------------
-- grants_project_wide_read is TRUE for contractor/client/verifier roles: a JV
-- partner's engineers read the whole project and write their sections. It is
-- structurally FALSE for every external role (CHECK external_never_project_wide).
INSERT INTO role (code, name, side, scope_level, is_system_template, grants_project_wide_read) VALUES
('PD',  'Project Director',                        'contractor','project',true, true),
('CM',  'Construction Manager',                    'contractor','project',true, true),
('EM',  'Engineering Manager',                     'contractor','project',true, true),
('QM',  'Quality Manager',                         'contractor','project',true, true),
('ENV', 'Environmental / Sustainability Manager',  'contractor','project',true, true),
('WHS', 'WHS Manager',                             'contractor','project',true, true),
('SR',  'Superintendent''s Representative',        'client',    'project',true, true),
('IV',  'Independent Verifier',                    'verifier',  'project',true, true),
('PE',  'Package / Section Engineer',              'contractor','project',true, true),
('SE',  'Site / Project Engineer',                 'contractor','project',true, true),
('CAD', 'Undergraduate / Cadet Engineer',          'contractor','project',true, true),
('FMN', 'Foreman / Supervisor',                    'contractor','project',true, true),
('SUR', 'Surveyor',                                'contractor','project',true, true),
('SUB', 'Subcontractor',                           'external',  'project',true, false),
('SUP', 'Supplier',                                'external',  'project',true, false),
('AUD', 'Client Stakeholder / Auditor',            'client',    'project',true, true),
-- ADR-0023: organisation-scoped quality authority. Holds the counter-signature
-- permissions across the whole portfolio, so a two-person project QA team
-- escalates instead of deadlocking. Deliberately holds no lot.raise,
-- checkpoint.sign or hold release permission: those are project nominations, and
-- a group appointment is not a nomination.
('GQM', 'Group Quality Manager',                   'contractor','organisation',true, true);

CREATE OR REPLACE FUNCTION public.grant_role(p_role_code text, VARIADIC p_perms text[])
RETURNS void LANGUAGE sql AS $$
  INSERT INTO role_permission (role_id, permission_code)
  SELECT r.id, p FROM role r, unnest(p_perms) AS p
   WHERE r.code = p_role_code AND r.owner_org_id IS NULL
  ON CONFLICT DO NOTHING;
$$;

SELECT public.grant_role('QM',
  'lot.view','lot.create','lot.raise','lot.edit','lot.geometry.edit','lot.assign',
  'lot.bulk_create','lot.submit','lot.hold.impose','lot.hold.lift',
  'lot.determine_non_conforming','lot.supersede','lot.export',
  'itp.master.view','itp.master.author','itp.master.publish','itp.master.withdraw',
  'itp.instance.view','checkpoint.action','checkpoint.evidence.attach','checkpoint.sign',
  'checkpoint.witness.notify','checkpoint.mark_not_applicable','checkpoint.correct',
  'signature.withdraw','concession.request',
  'admin.project.configure','admin.users.manage','admin.roles.manage',
  'admin.permission_grant.issue','admin.delegation.create','admin.standards.manage',
  'admin.acceptance_scheme.manage','admin.integration.configure','admin.idp.configure',
  'admin.device.enrol','admin.device.revoke','admin.device.user_enrol','api.key.manage',
  'qa_audit.schedule','qa_audit.conduct','export.data','export.audit_log');

SELECT public.grant_role('EM',
  'lot.view','lot.create','lot.raise','lot.edit','lot.geometry.edit','lot.assign',
  'lot.bulk_create','lot.submit','lot.certify_conformance','lot.hold.impose','lot.hold.lift',
  'lot.determine_non_conforming','lot.supersede','lot.export',
  'itp.master.view','itp.master.author','itp.master.approve.technical','itp.instance.view',
  'checkpoint.action','checkpoint.evidence.attach','checkpoint.sign',
  'checkpoint.witness.notify','checkpoint.mark_not_applicable','checkpoint.correct',
  'signature.withdraw','concession.request','concession.approve.em',
  'admin.standards.manage','admin.acceptance_scheme.manage','admin.delegation.create',
  'admin.device.user_enrol','export.data');

SELECT public.grant_role('PE',
  'lot.view','lot.create','lot.raise','lot.edit','lot.geometry.edit','lot.assign',
  'lot.bulk_create','lot.submit','lot.export','itp.master.view','itp.instance.view',
  'checkpoint.action','checkpoint.evidence.attach','checkpoint.sign',
  'checkpoint.witness.notify','concession.request','qa_audit.conduct',
  'admin.device.enrol','admin.device.revoke','admin.device.user_enrol','export.data');

SELECT public.grant_role('SE',
  'lot.view','lot.create','lot.raise','lot.edit','lot.geometry.edit','lot.submit','lot.export',
  'itp.master.view','itp.instance.view','checkpoint.action','checkpoint.evidence.attach',
  'checkpoint.sign','checkpoint.witness.notify','concession.request',
  'admin.device.user_enrol','export.data');

-- A cadet may create and populate lots and upload evidence. checkpoint.sign is
-- granted, but guard C6 refuses hold and witness types regardless — the
-- restriction is on the checkpoint type, not the role, so a tenant that
-- mistakenly grants more cannot break it.
SELECT public.grant_role('CAD',
  'lot.view','lot.create','lot.edit','lot.geometry.edit','itp.master.view','itp.instance.view',
  'checkpoint.action','checkpoint.evidence.attach','checkpoint.sign');

SELECT public.grant_role('FMN',
  'lot.view','itp.instance.view','checkpoint.action','checkpoint.evidence.attach','checkpoint.sign');

SELECT public.grant_role('SR',
  'lot.view','lot.accept','lot.reject','lot.hold.impose','lot.hold.lift',
  'lot.determine_non_conforming','lot.export','itp.master.view','itp.instance.view',
  'checkpoint.hold.release','checkpoint.hold.release.retrospective',
  'checkpoint.witness.record_outcome','concession.approve.client',
  'qa_audit.schedule','qa_audit.conduct','export.data','export.audit_log');

SELECT public.grant_role('IV',
  'lot.view','lot.hold.impose','lot.determine_non_conforming','lot.export',
  'itp.master.view','itp.instance.view','checkpoint.hold.release',
  'checkpoint.hold.release.retrospective','checkpoint.witness.record_outcome',
  'qa_audit.schedule','qa_audit.conduct','export.data','export.audit_log');

SELECT public.grant_role('CM',
  'lot.view','lot.create','lot.raise','lot.edit','lot.geometry.edit','lot.assign',
  'lot.bulk_create','lot.submit','lot.closeout.approve','lot.hold.impose','lot.hold.lift',
  'lot.export','itp.master.view','itp.instance.view','checkpoint.action',
  'checkpoint.evidence.attach','checkpoint.sign','checkpoint.witness.notify',
  'concession.request','admin.device.enrol','admin.device.revoke','admin.device.user_enrol',
  'export.data');

SELECT public.grant_role('PD',
  'lot.view','lot.closeout.approve','lot.hold.impose','lot.hold.lift','lot.export',
  'itp.master.view','itp.instance.view','admin.permission_grant.issue',
  'admin.delegation.create','export.data','export.audit_log','pc.sign');

SELECT public.grant_role('SUR',
  'lot.view','lot.geometry.edit','lot.export','itp.instance.view','checkpoint.action',
  'checkpoint.evidence.attach','checkpoint.sign','export.data');

SELECT public.grant_role('ENV',
  'lot.view','lot.hold.impose','itp.master.view','itp.master.author','itp.instance.view',
  'checkpoint.action','checkpoint.evidence.attach','checkpoint.sign','qa_audit.conduct',
  'admin.device.user_enrol','export.data');

SELECT public.grant_role('WHS',
  'lot.view','lot.hold.impose','itp.master.view','itp.master.author','itp.instance.view',
  'checkpoint.action','checkpoint.evidence.attach','checkpoint.sign','qa_audit.conduct',
  'admin.device.enrol','admin.device.revoke','admin.device.user_enrol','export.data');

SELECT public.grant_role('AUD',
  'lot.view','lot.export','itp.master.view','itp.instance.view','export.data','export.audit_log');

SELECT public.grant_role('SUB',
  'lot.view','itp.instance.view','checkpoint.action','checkpoint.evidence.attach',
  'checkpoint.sign','lot.export','export.data');

SELECT public.grant_role('SUP', 'export.data');

SELECT public.grant_role('GQM',
  'lot.view','lot.export','itp.master.view','itp.instance.view',
  'signature.withdraw.countersign','checkpoint.correct.countersign',
  'qa_audit.schedule','qa_audit.conduct','admin.standards.manage',
  'admin.acceptance_scheme.manage','export.data','export.audit_log');

-- The counter-signature resolution from ADR-0023. A withdrawal needs someone who
-- is not the original signatory and who holds the authority either on the
-- project or at organisation level. This is what stops a two-person QA team
-- deadlocking on a correction.
CREATE OR REPLACE FUNCTION auth.eligible_withdrawal_countersignatories(
  p_project_id        uuid,
  p_original_signatory uuid
) RETURNS TABLE (user_id uuid, via text)
LANGUAGE sql STABLE AS $$
  SELECT pm.user_id, 'project'::text
    FROM project_membership pm
    JOIN role_permission rp ON rp.role_id = pm.role_id
   WHERE pm.project_id = p_project_id
     AND pm.active_period @> CURRENT_DATE
     AND rp.permission_code = 'signature.withdraw'
     AND pm.user_id <> p_original_signatory
  UNION
  SELECT om.user_id, 'organisation'::text
    FROM org_membership om
    JOIN role_permission rp ON rp.role_id = om.role_id
    JOIN project_participant pp ON pp.organisation_id = om.organisation_id
   WHERE pp.project_id = p_project_id
     AND pp.active_period @> CURRENT_DATE
     AND om.active_period @> CURRENT_DATE
     AND rp.permission_code = 'signature.withdraw.countersign'
     AND om.user_id <> p_original_signatory;
$$;
