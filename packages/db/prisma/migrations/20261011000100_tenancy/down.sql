-- Reverses 20261011000100_tenancy.
DROP TRIGGER processed_job_set_updated_at_trg ON processed_job;
ALTER TABLE processed_job DROP COLUMN updated_at, DROP COLUMN created_at;
DROP TABLE connection;
DROP TABLE brand;
DROP TABLE membership;
DROP TABLE app_user;
DROP TABLE organization;
DROP FUNCTION fb_forbid_direct_mutation();
DROP FUNCTION fb_set_updated_at();
