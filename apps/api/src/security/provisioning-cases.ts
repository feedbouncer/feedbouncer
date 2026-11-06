/** Every route of the provisioning API, "METHOD /provisioning/v1/path". */
export const PROVISIONING_ROUTES: readonly string[] = [
  'POST /provisioning/v1/organizations',
  'GET /provisioning/v1/organizations/:organizationId',
  'POST /provisioning/v1/organizations/:organizationId/users',
  'PUT /provisioning/v1/organizations/:organizationId/status',
  'GET /provisioning/v1/users/:userId',
  'PUT /provisioning/v1/users/:userId/status',
];
