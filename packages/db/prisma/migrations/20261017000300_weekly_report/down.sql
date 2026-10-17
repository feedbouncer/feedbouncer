DROP TABLE weekly_report_delivery;
DROP TABLE weekly_report;
DROP TABLE report_subscription;
ALTER TABLE organization
  DROP CONSTRAINT organization_timezone_check,
  DROP COLUMN timezone_set_at,
  DROP COLUMN timezone;
