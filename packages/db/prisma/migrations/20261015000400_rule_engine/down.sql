DROP INDEX decision_rule_evaluation_id_idx;
ALTER TABLE decision DROP CONSTRAINT decision_brand_id_rule_evaluation_id_fkey, DROP COLUMN rule_evaluation_id;
DROP TABLE rule_evaluation;
DROP TABLE rule_run;
DROP TABLE brand_domain;
DROP INDEX rule_brand_id_priority_idx;
ALTER TABLE rule DROP CONSTRAINT rule_kind_check, DROP COLUMN archived_at, DROP COLUMN kind;
