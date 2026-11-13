import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { createTranslator } from 'use-intl/core';
import en from '../../messages/en.json';

export const withIntl = (node: ReactNode) => (
  <NextIntlClientProvider locale="en" messages={en}>
    {node}
  </NextIntlClientProvider>
);

/**
 * Factory for `vi.mock('next-intl/server', ...)`: server components get the real English messages.
 * vi.mock must sit at the top level of the test file, so use
 * `vi.mock('next-intl/server', async () => (await import('<path>/test/intl')).mockServerIntl())`.
 */
export function mockServerIntl() {
  return {
    getTranslations: async (namespace: string) =>
      createTranslator({ locale: 'en', messages: en, namespace: namespace as 'onboarding' }),
  };
}
