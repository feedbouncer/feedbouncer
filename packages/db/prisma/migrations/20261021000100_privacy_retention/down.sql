-- Drops the privacy and retention records added by this migration. Existing
-- content, decisions and audit events are untouched.
DROP INDEX api_idempotency_record_created_at_idx;
DROP INDEX alert_event_created_at_idx;
DROP INDEX audit_event_organization_id_created_at_idx;
DROP INDEX action_run_brand_id_created_at_idx;
DROP INDEX moderation_action_brand_id_completed_at_idx;
DROP INDEX policy_evaluation_brand_id_created_at_idx;
DROP INDEX rule_evaluation_brand_id_created_at_idx;
DROP TABLE retention_status;
DROP TABLE retention_confirmation;
DROP TABLE retention_run;
DROP TABLE privacy_request;
DROP TABLE erased_comment;
ALTER TABLE comment DROP COLUMN parent_removed_at;

CREATE OR REPLACE FUNCTION fb_forbid_direct_mutation() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' OR pg_catalog.pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;
