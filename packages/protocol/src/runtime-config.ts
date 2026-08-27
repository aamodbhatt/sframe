export const RUNTIME_ENVIRONMENTS = ['local', 'staging', 'production'] as const;
export type RuntimeEnvironment = typeof RUNTIME_ENVIRONMENTS[number];

export const PRODUCTION_HSTS = 'max-age=31536000; includeSubDomains' as const;

export const REQUIRED_RUNTIME_BINDINGS = ['DB', 'PACKAGES', 'ROOMS'] as const;
export type RequiredRuntimeBinding = typeof REQUIRED_RUNTIME_BINDINGS[number];

export type RuntimeConfigInput = Readonly<Record<string, unknown>>;

export type RuntimeConfigErrorCode =
  | 'ENVIRONMENT_INVALID'
  | 'BUILD_VERSION_INVALID'
  | 'PRODUCTION_HTTPS_REQUIRED'
  | 'ORIGIN_WILDCARD_FORBIDDEN'
  | 'ORIGIN_NOT_EXACT'
  | 'ORIGIN_COLLISION'
  | 'CORS_ORIGIN_MISMATCH'
  | 'BINDING_MISSING'
  | 'BINDING_INVALID'
  | 'LOCAL_ORIGIN_REQUIRED'
  | 'PLAINTEXT_NON_LOOPBACK_FORBIDDEN';

export class RuntimeConfigError extends Error {
  readonly code: RuntimeConfigErrorCode;

  constructor(code: RuntimeConfigErrorCode) {
    super(code);
    this.name = 'RuntimeConfigError';
    this.code = code;
  }
}

export type RuntimeConfig = Readonly<{
  environment: RuntimeEnvironment;
  buildVersion: string;
  origins: Readonly<{
    controller: string;
    api: string;
    websocket: string;
  }>;
  cors: Readonly<{
    allowOrigin: string;
  }>;
  securityHeaders: Readonly<{
    strictTransportSecurity: typeof PRODUCTION_HSTS | null;
  }>;
  bindings: Readonly<Record<RequiredRuntimeBinding, true>>;
}>;

type OriginKind = 'controller' | 'api' | 'websocket';

const fail = (code: RuntimeConfigErrorCode): never => {
  throw new RuntimeConfigError(code);
};

const readEnvironment = (value: unknown): RuntimeEnvironment => {
  if (value === 'local' || value === 'staging' || value === 'production') return value;
  return fail('ENVIRONMENT_INVALID');
};

const readBuildVersion = (value: unknown, environment: RuntimeEnvironment): string => {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    return fail('BUILD_VERSION_INVALID');
  }
  if (environment !== 'local' && /(^|[-+._])(local|dev|development|test)($|[-+._])/iu.test(value)) {
    return fail('BUILD_VERSION_INVALID');
  }
  return value;
};

const isLoopbackHostname = (hostname: string): boolean =>
  hostname === 'localhost'
  || hostname.endsWith('.localhost')
  || hostname === '127.0.0.1'
  || hostname === '[::1]';

const readExactOrigin = (
  value: unknown,
  kind: OriginKind,
  environment: RuntimeEnvironment,
): string => {
  if (typeof value !== 'string') return fail('ORIGIN_NOT_EXACT');
  if (value.includes('*')) return fail('ORIGIN_WILDCARD_FORBIDDEN');

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return fail('ORIGIN_NOT_EXACT');
  }

  if (
    value !== url.origin
    || url.username !== ''
    || url.password !== ''
    || url.hostname.endsWith('.')
    || url.pathname !== '/'
    || url.search !== ''
    || url.hash !== ''
  ) return fail('ORIGIN_NOT_EXACT');

  const secureProtocol = kind === 'websocket' ? 'wss:' : 'https:';
  const plaintextProtocol = kind === 'websocket' ? 'ws:' : 'http:';
  if (url.protocol !== secureProtocol && url.protocol !== plaintextProtocol) {
    return fail('ORIGIN_NOT_EXACT');
  }

  if (environment !== 'local' && url.protocol !== secureProtocol) {
    return fail('PRODUCTION_HTTPS_REQUIRED');
  }
  if (url.protocol === plaintextProtocol && !isLoopbackHostname(url.hostname)) {
    return fail('PLAINTEXT_NON_LOOPBACK_FORBIDDEN');
  }
  if (environment === 'local' && !isLoopbackHostname(url.hostname)) {
    return fail('LOCAL_ORIGIN_REQUIRED');
  }
  return value;
};

const REQUIRED_BINDING_METHODS = Object.freeze({
  DB: Object.freeze(['prepare', 'batch', 'exec', 'withSession', 'dump']),
  PACKAGES: Object.freeze(['head', 'get', 'put', 'createMultipartUpload', 'resumeMultipartUpload', 'delete', 'list']),
  ROOMS: Object.freeze(['newUniqueId', 'idFromName', 'idFromString', 'get']),
} satisfies Readonly<Record<RequiredRuntimeBinding, readonly string[]>>);

const bindingHasRequiredShape = (value: unknown, name: RequiredRuntimeBinding): boolean => {
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') return false;
  try {
    const candidate = value as Record<string, unknown>;
    return REQUIRED_BINDING_METHODS[name].every((method) => typeof candidate[method] === 'function');
  } catch {
    return false;
  }
};

const readBindings = (input: RuntimeConfigInput): RuntimeConfig['bindings'] => {
  for (const name of REQUIRED_RUNTIME_BINDINGS) {
    if (!Object.prototype.hasOwnProperty.call(input, name)) return fail('BINDING_MISSING');
    if (!bindingHasRequiredShape(input[name], name)) return fail('BINDING_INVALID');
  }
  return Object.freeze({DB: true, PACKAGES: true, ROOMS: true});
};

/**
 * Validates a runtime's public deployment configuration once at startup.
 *
 * Binding handles and all unrecognised values (including secrets) are reduced
 * to presence markers and are never retained, returned, or logged.
 */
export const loadRuntimeConfig = (input: RuntimeConfigInput): RuntimeConfig => {
  const environment = readEnvironment(input.ENVIRONMENT);
  const buildVersion = readBuildVersion(input.BUILD_VERSION, environment);
  const controller = readExactOrigin(input.CONTROLLER_ORIGIN, 'controller', environment);
  const api = readExactOrigin(input.API_ORIGIN, 'api', environment);
  const websocket = readExactOrigin(input.WEBSOCKET_ORIGIN, 'websocket', environment);

  if (new Set([controller, api, websocket]).size !== 3) return fail('ORIGIN_COLLISION');

  if (input.CORS_ORIGIN !== undefined) {
    const configuredCors = readExactOrigin(input.CORS_ORIGIN, 'controller', environment);
    if (configuredCors !== controller) return fail('CORS_ORIGIN_MISMATCH');
  }

  const bindings = readBindings(input);
  const origins = Object.freeze({controller, api, websocket});
  const cors = Object.freeze({allowOrigin: controller});
  const securityHeaders = Object.freeze({
    strictTransportSecurity: environment === 'local' ? null : PRODUCTION_HSTS,
  });

  return Object.freeze({environment, buildVersion, origins, cors, securityHeaders, bindings});
};
