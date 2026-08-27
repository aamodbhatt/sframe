import {describe, expect, it} from 'vitest';
import {PRODUCTION_HSTS, type RuntimeConfigError} from '../../../packages/protocol/src/runtime-config.js';
import {
  readApiRuntimeConfig,
  secureApiResponse,
  type ApiEnvironment,
} from './runtime-config.js';

const bindingFixtures = (): Pick<ApiEnvironment, 'DB' | 'PACKAGES' | 'ROOMS'> => ({
  DB: {
    prepare: () => undefined,
    batch: () => undefined,
    exec: () => undefined,
    withSession: () => undefined,
    dump: () => undefined,
  },
  PACKAGES: {
    head: () => undefined,
    get: () => undefined,
    put: () => undefined,
    createMultipartUpload: () => undefined,
    resumeMultipartUpload: () => undefined,
    delete: () => undefined,
    list: () => undefined,
  },
  ROOMS: {
    newUniqueId: () => ({toString: () => 'unused'}),
    idFromName: () => ({toString: () => 'unused'}),
    idFromString: () => ({toString: () => 'unused'}),
    get: () => ({fetch: async () => new Response(null, {status: 204})}),
  },
} as unknown as Pick<ApiEnvironment, 'DB' | 'PACKAGES' | 'ROOMS'>);

const productionEnvironment = (): ApiEnvironment => ({
  ENVIRONMENT: 'production',
  BUILD_VERSION: '2026.08.26+phase0',
  CONTROLLER_ORIGIN: 'https://app.example.com',
  API_ORIGIN: 'https://api.example.com',
  WEBSOCKET_ORIGIN: 'wss://api.example.com',
  ...bindingFixtures(),
});

describe('API runtime startup boundary', () => {
  it('loads a narrow config and centrally applies production headers', () => {
    const config = readApiRuntimeConfig(productionEnvironment());
    const response = secureApiResponse(new Response('{"ok":true}'), config);
    expect(response.status).toBe(200);
    expect(response.headers.get('Strict-Transport-Security')).toBe(PRODUCTION_HSTS);
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
  });

  it('fails closed for an inconsistent local environment', () => {
    const environment = {
      ...productionEnvironment(),
      ENVIRONMENT: 'local',
      BUILD_VERSION: 'local',
    } satisfies ApiEnvironment;
    expect(() => readApiRuntimeConfig(environment))
      .toThrowError(expect.objectContaining({name: 'RuntimeConfigError', code: 'LOCAL_ORIGIN_REQUIRED'} satisfies Partial<RuntimeConfigError>));
  });

  it('fails closed when a real binding is absent', () => {
    const environment = productionEnvironment() as ApiEnvironment & {PACKAGES?: unknown};
    delete environment.PACKAGES;
    expect(() => readApiRuntimeConfig(environment as ApiEnvironment))
      .toThrowError(expect.objectContaining({name: 'RuntimeConfigError', code: 'BINDING_MISSING'} satisfies Partial<RuntimeConfigError>));
  });
});
