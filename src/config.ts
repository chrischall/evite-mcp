import { readEnvVar, parseBoolEnv } from '@chrischall/mcp-utils';

export const config = {
  email: () => readEnvVar('EVITE_EMAIL'),
  password: () => readEnvVar('EVITE_PASSWORD'),
  disableFetchproxy: () => parseBoolEnv('EVITE_DISABLE_FETCHPROXY', { default: false }),
};
