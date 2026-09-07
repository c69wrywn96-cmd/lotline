-- 0023 — A declaration without a reason is a rubber stamp.
--
-- Two of the declarations added in 0022 said "Same fence on the write path",
-- which records nothing a reader could check. The point of the registry is that
-- someone reviewing it later can tell whether the pruning really is intended, so
-- the reason has to carry the argument, not point at another row.
--
-- Enforced as a constraint rather than a convention: the next person adding a
-- declaration under time pressure is exactly the person a convention fails.

UPDATE rls_reference_declaration
   SET reason = 'A chainage equation is only meaningful with its alignment, and creating one against an alignment you cannot read would let a viewer write into another project''s design.'
 WHERE on_table = 'alignment_equation' AND policy_name = 'alignment_equation_write';

UPDATE rls_reference_declaration
   SET reason = 'Revoking someone''s unlock on a device you cannot see is not a cross-user question that should ever answer: the device policy is the fence, and a viewer who cannot see the device has no business retiring enrolments on it.'
 WHERE on_table = 'device_user_enrolment' AND policy_name = 'device_user_enrolment_update';

UPDATE rls_reference_declaration
   SET reason = 'Nominating a work type for client acceptance changes the conformance regime for every future lot of that type, so it must not be possible against a contract the writer cannot read.'
 WHERE on_table = 'contract_acceptance_work_type' AND policy_name = 'cawt_insert';

ALTER TABLE rls_reference_declaration
  ADD CONSTRAINT reason_is_an_argument CHECK (length(btrim(reason)) >= 60);
