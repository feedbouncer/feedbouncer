-- Drops the free scan tool tables added by this migration, including every
-- stored scan, grant and visitor. Nothing outside the scan_* tables is touched.
DROP TABLE scan;
DROP TABLE scan_grant;
DROP TABLE scan_oauth_state;
DROP TABLE scan_visitor;
