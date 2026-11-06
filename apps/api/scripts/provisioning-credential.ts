import { generateProvisioningCredential } from '../src/provisioning/credential.js';

// Stdout only, never through the logger: the token is shown once.
const { token, digestHex } = generateProvisioningCredential();
process.stdout.write(
  [
    'Provisioning credential (give this to the external system; it is shown once):',
    token.reveal(),
    'Set on the api service:',
    `PROVISIONING_CREDENTIAL_SHA256=${digestHex}`,
    '',
  ].join('\n'),
);
