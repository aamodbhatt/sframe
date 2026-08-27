import {describe, expect, it, vi} from 'vitest';
import {
  PRODUCTION_HSTS,
  RuntimeConfigError,
  loadRuntimeConfig,
  type RuntimeConfigInput,
} from './runtime-config.js';

const bindingFixtures = (): Record<'DB' | 'PACKAGES' | 'ROOMS', Record<string, () => undefined>> => ({
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
    newUniqueId: () => undefined,
    idFromName: () => undefined,
    idFromString: () => undefined,
    get: () => undefined,
  },
});

const productionInput = (): Record<string, unknown> => ({
  ENVIRONMENT: 'production',
  BUILD_VERSION: '2026.08.25+4f9a2c1',
  CONTROLLER_ORIGIN: 'https://app.example.com',
  API_ORIGIN: 'https://api.example.com',
  WEBSOCKET_ORIGIN: 'wss://events.example.com',
  ...bindingFixtures(),
});

const errorCode = (input: RuntimeConfigInput): string => {
  try {
    loadRuntimeConfig(input);
  } catch (error) {
    expect(error).toBeInstanceOf(RuntimeConfigError);
    return (error as RuntimeConfigError).code;
  }
  throw new Error('EXPECTED_CONFIG_FAILURE');
};

describe('runtime configuration', () => {
  it.each(['production', 'staging'] as const)('loads a strict %s configuration', (environment) => {
    const input: Record<string, unknown> = {...productionInput(), ENVIRONMENT: environment};
    const result = loadRuntimeConfig(input);

    expect(result).toEqual({
      environment,
      buildVersion: input.BUILD_VERSION,
      origins: {
        controller: input.CONTROLLER_ORIGIN,
        api: input.API_ORIGIN,
        websocket: input.WEBSOCKET_ORIGIN,
      },
      cors: {allowOrigin: input.CONTROLLER_ORIGIN},
      securityHeaders: {strictTransportSecurity: PRODUCTION_HSTS},
      bindings: {DB: true, PACKAGES: true, ROOMS: true},
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.origins)).toBe(true);
    expect(Object.isFrozen(result.cors)).toBe(true);
    expect(Object.isFrozen(result.securityHeaders)).toBe(true);
    expect(Object.isFrozen(result.bindings)).toBe(true);
  });

  it('allows the explicit local loopback plaintext contract and omits HSTS', () => {
    const result = loadRuntimeConfig({
      ENVIRONMENT: 'local',
      BUILD_VERSION: 'local',
      CONTROLLER_ORIGIN: 'http://app.localhost:4173',
      API_ORIGIN: 'http://127.0.0.1:8787',
      WEBSOCKET_ORIGIN: 'ws://[::1]:8791',
      CORS_ORIGIN: 'http://app.localhost:4173',
      ...bindingFixtures(),
    });
    expect(result.securityHeaders.strictTransportSecurity).toBeNull();
    expect(result.cors.allowOrigin).toBe('http://app.localhost:4173');
  });

  it.each([
    ['http://app.example.com', 'API_ORIGIN'],
    ['ws://events.example.com', 'WEBSOCKET_ORIGIN'],
  ])('rejects non-secure non-local origins: %s', (origin, key) => {
    const input = productionInput();
    input[key] = origin;
    expect(errorCode(input)).toBe('PRODUCTION_HTTPS_REQUIRED');
  });

  it.each([
    ['CONTROLLER_ORIGIN', '*'],
    ['API_ORIGIN', 'https://*.example.com'],
    ['WEBSOCKET_ORIGIN', 'wss://events.*.example.com'],
    ['CORS_ORIGIN', '*'],
  ])('rejects wildcard %s', (key, origin) => {
    const input = productionInput();
    input[key] = origin;
    expect(errorCode(input)).toBe('ORIGIN_WILDCARD_FORBIDDEN');
  });

  it.each([
    'https://user@app.example.com',
    'https://app.example.com/',
    'https://app.example.com/path',
    'https://app.example.com?debug=1',
    'https://app.example.com#fragment',
    ' https://app.example.com',
    'https://APP.example.com',
    'https://app.example.com:443',
    'ftp://app.example.com',
    'not a URL',
    '',
  ])('rejects a non-canonical controller origin: %s', (origin) => {
    expect(errorCode({...productionInput(), CONTROLLER_ORIGIN: origin})).toBe('ORIGIN_NOT_EXACT');
  });

  it.each([
    ['CONTROLLER_ORIGIN', 'http://example.test:4173'],
    ['API_ORIGIN', 'http://192.168.1.8:8787'],
    ['WEBSOCKET_ORIGIN', 'ws://0.0.0.0:8791'],
  ])('rejects local plaintext on a non-loopback host through %s', (key, origin) => {
    const input = {
      ...productionInput(),
      ENVIRONMENT: 'local',
      BUILD_VERSION: 'local',
      CONTROLLER_ORIGIN: 'http://app.localhost:4173',
      API_ORIGIN: 'http://api.localhost:8787',
      WEBSOCKET_ORIGIN: 'ws://localhost:8791',
      [key]: origin,
    };
    expect(errorCode(input)).toBe('PLAINTEXT_NON_LOOPBACK_FORBIDDEN');
  });

  it.each([
    ['CONTROLLER_ORIGIN', 'https://app.example.com'],
    ['API_ORIGIN', 'https://api.example.com'],
    ['WEBSOCKET_ORIGIN', 'wss://events.example.com'],
  ])('rejects local mode paired with a public %s', (key, origin) => {
    const input = {
      ...productionInput(),
      ...bindingFixtures(),
      ENVIRONMENT: 'local',
      BUILD_VERSION: 'local',
      CONTROLLER_ORIGIN: 'https://app.localhost:4173',
      API_ORIGIN: 'https://api.localhost:8787',
      WEBSOCKET_ORIGIN: 'wss://api.localhost:8787',
      [key]: origin,
    };
    expect(errorCode(input)).toBe('LOCAL_ORIGIN_REQUIRED');
  });

  it('rejects a trailing-dot authority alias', () => {
    expect(errorCode({...productionInput(), CONTROLLER_ORIGIN: 'https://app.example.com.'})).toBe('ORIGIN_NOT_EXACT');
  });

  it('rejects colliding controller and API origins', () => {
    const input = productionInput();
    input.API_ORIGIN = input.CONTROLLER_ORIGIN;
    expect(errorCode(input)).toBe('ORIGIN_COLLISION');
  });

  it('derives CORS from the controller and rejects a different configured value', () => {
    const input = {...productionInput(), CORS_ORIGIN: 'https://other.example.com'};
    expect(errorCode(input)).toBe('CORS_ORIGIN_MISMATCH');
    expect(loadRuntimeConfig(productionInput()).cors).toEqual({allowOrigin: 'https://app.example.com'});
  });

  it.each(['DB', 'PACKAGES', 'ROOMS'])('requires an own %s binding', (binding) => {
    for (const missing of [undefined, null, '', ' ', false, 0]) {
      const input = productionInput();
      if (missing === undefined) delete input[binding];
      else input[binding] = missing;
      expect(errorCode(input)).toBe(missing === undefined ? 'BINDING_MISSING' : 'BINDING_INVALID');
    }
  });

  it.each(['DB', 'PACKAGES', 'ROOMS'])('rejects inherited and placeholder %s bindings', (binding) => {
    const withoutOwn = productionInput();
    const inherited = Object.create({[binding]: bindingFixtures()[binding as 'DB' | 'PACKAGES' | 'ROOMS']}) as Record<string, unknown>;
    Object.assign(inherited, withoutOwn);
    delete inherited[binding];
    expect(errorCode(inherited)).toBe('BINDING_MISSING');

    for (const placeholder of [{}, [], new Date(), 'not-a-binding', () => undefined]) {
      expect(errorCode({...productionInput(), [binding]: placeholder})).toBe('BINDING_INVALID');
    }
  });

  it.each([
    [undefined, 'ENVIRONMENT_INVALID'],
    ['Production', 'ENVIRONMENT_INVALID'],
  ])('rejects invalid environment %j', (environment, expected) => {
    expect(errorCode({...productionInput(), ENVIRONMENT: environment})).toBe(expected);
  });

  it.each(['', ' 2026.08.25', 'local', '0.1.0-local', 'dev', 'release.test'])('rejects non-release build version %j outside local', (buildVersion) => {
    expect(errorCode({...productionInput(), BUILD_VERSION: buildVersion})).toBe('BUILD_VERSION_INVALID');
  });

  it('does not retain binding values, secret values, unknown fields, or log input', () => {
    const secret = 'test-secret-sentinel-that-must-not-escape';
    const spies = (['debug', 'error', 'info', 'log', 'trace', 'warn'] as const)
      .map((method) => vi.spyOn(console, method).mockImplementation(() => undefined));
    const result = loadRuntimeConfig({
      ...productionInput(),
      ...Object.fromEntries(Object.entries(bindingFixtures()).map(([name, binding]) => [name, {...binding, secret}])),
      INVITE_RATE_SALT: secret,
      UNKNOWN_SECRET: secret,
    });

    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result.bindings).toEqual({DB: true, PACKAGES: true, ROOMS: true});
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();

    expect(() => loadRuntimeConfig({...productionInput(), CONTROLLER_ORIGIN: secret})).toThrowError('ORIGIN_NOT_EXACT');
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
