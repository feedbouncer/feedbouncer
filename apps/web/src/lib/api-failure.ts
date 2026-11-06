/** How a failed API response should be handled by a page. */
export function classifyFailure(
  status: number,
  errorCode: string | null,
): 'not_found' | 'suspended' | 'error' {
  if (status === 404) return 'not_found';
  if (status === 403 && errorCode === 'organization_suspended') return 'suspended';
  return 'error';
}
