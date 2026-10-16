/** The viewer's IANA timezone, e.g. Europe/Berlin. Browser-only; on the server it is the server's. */
export const browserTimezone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;
