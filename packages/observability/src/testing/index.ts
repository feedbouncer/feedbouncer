import { context, diag, propagation, trace } from '@opentelemetry/api';

export function resetTracingForTests(): void {
  trace.disable();
  context.disable();
  propagation.disable();
  diag.disable();
}
