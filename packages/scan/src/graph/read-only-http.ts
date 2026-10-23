import { ConnectorError, type SafeHttp } from '@feedbouncer/connectors';

/** The only client the scan readers receive: a free scan never writes to Meta. */
export function readOnlyHttp(inner: SafeHttp): SafeHttp {
  return {
    async request(req, signal) {
      if (req.method !== 'GET') throw new ConnectorError('permanent', 'scan_write_forbidden');
      return inner.request(req, signal);
    },
  };
}
