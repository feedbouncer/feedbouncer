DROP INDEX comment_connection_id_hook_pending_idx;
ALTER TABLE comment DROP CONSTRAINT comment_hook_pending_sha256_check, DROP COLUMN hook_pending_sha256, DROP COLUMN hook_attempted_at;
DROP INDEX decision_rule_evaluation_id_idx;
ALTER TABLE decision DROP CONSTRAINT decision_brand_id_rule_evaluation_id_fkey, DROP COLUMN rule_evaluation_id;
DROP TABLE rule_evaluation;
DROP FUNCTION fb_rule_evaluation_guard();
DROP TABLE brand_domain;
DROP INDEX rule_brand_id_priority_idx;
ALTER TABLE rule DROP CONSTRAINT rule_kind_check, DROP COLUMN archived_at, DROP COLUMN kind;
