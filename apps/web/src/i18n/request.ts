import { getRequestConfig } from 'next-intl/server';
import messages from '../../messages/en.json';

// No locale routing: English only. The messages are a static import, never a path built from input.
export default getRequestConfig(async () => ({ locale: 'en', messages }));
