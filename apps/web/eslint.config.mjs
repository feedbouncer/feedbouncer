import baseConfig from '../../eslint.config.base.mjs';

export default [...baseConfig, { ignores: ['.next/**', 'next-env.d.ts'] }];
