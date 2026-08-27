import {
  loadRuntimeConfig,
  type RuntimeConfig,
  type RuntimeConfigInput,
  type RuntimeEnvironment,
} from '../../../packages/protocol/src/runtime-config.js';

export type ApiEnvironment = {
  ENVIRONMENT: RuntimeEnvironment;
  BUILD_VERSION: string;
  CONTROLLER_ORIGIN: string;
  API_ORIGIN: string;
  WEBSOCKET_ORIGIN: string;
  DB: unknown;
  PACKAGES: unknown;
  ROOMS: unknown;
  PHASE0_HOLD_MS?: string;
  PHASE0_MAX_TRANSPORTS?: string;
};

const configByEnvironment = new WeakMap<object, RuntimeConfig>();

/**
 * Workers have no process-start hook. The first request/DO construction is the
 * startup boundary, so validate once for each immutable Cloudflare env object.
 */
export const readApiRuntimeConfig = (environment: ApiEnvironment): RuntimeConfig => {
  const key = environment as object;
  const cached = configByEnvironment.get(key);
  if (cached) return cached;
  const config = loadRuntimeConfig(environment as unknown as RuntimeConfigInput);
  configByEnvironment.set(key, config);
  return config;
};

/** Applies central API response headers without trying to reconstruct a 101. */
export const secureApiResponse = (response: Response, config: RuntimeConfig, requestOrigin?: string | null): Response => {
  if (response.status === 101) return response;
  const headers = new Headers(response.headers);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
  const hsts = config.securityHeaders.strictTransportSecurity;
  if (hsts) headers.set('Strict-Transport-Security', hsts);
  else headers.delete('Strict-Transport-Security');
  if (requestOrigin === config.cors.allowOrigin) {
    headers.set('Access-Control-Allow-Origin', config.cors.allowOrigin);
    const vary = new Set((headers.get('Vary') ?? '').split(',').map((value) => value.trim()).filter(Boolean));
    vary.add('Origin');
    headers.set('Vary', [...vary].join(', '));
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};
