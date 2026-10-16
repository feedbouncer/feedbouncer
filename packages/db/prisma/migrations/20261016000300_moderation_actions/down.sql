-- Data-destructive: drops all action runs, steps and review items, and the rules' step lists.
DROP TRIGGER review_item_from_decision_trg ON decision;
DROP FUNCTION fb_review_item_from_decision();
DROP TABLE action_run_step;
DROP TABLE action_run;
DROP TABLE review_item;
ALTER TABLE rule DROP CONSTRAINT rule_actions_check, DROP COLUMN actions;
