import type {DurableObjectNamespace} from 'cloudflare:workers';
import {ROOM_ID_RE} from './do-crypto.js';
import {RoomDurableObject, type RoomEnvironment} from './do-room.js';
import {readApiRuntimeConfig, secureApiResponse} from './runtime-config.js';
import {
  handleAdminCreateInvite,
  handleEnrollment,
  handleGetPackage,
  handlePackageUpload,
  handleRoomCreationSaga,
  globalPublishStore
} from './publish-api.js';

type WorkerEnvironment = RoomEnvironment & {
  ROOMS: DurableObjectNamespace;
};

const PUBLIC_ROOM_ROUTE = /^\/v1\/rooms\/([A-Za-z0-9_-]{22})(?:\/(state|events|events-ticket|socket|rotate-links|revoke|request-repair|recover|package))?$/u;
const PREFLIGHT_METHODS: Record<string, Set<string>> = Object.freeze({
  '': new Set(['GET']),
  state: new Set(['GET', 'PUT']),
  events: new Set(['GET']),
  'events-ticket': new Set(['POST']),
  socket: new Set<string>(),
  'rotate-links': new Set(['POST']),
  revoke: new Set(['POST']),
  'request-repair': new Set(['POST']),
  recover: new Set(['POST']),
  package: new Set(['GET']),
});
const PREFLIGHT_HEADERS = new Set(['authorization', 'content-type', 'if-match', 'if-none-match', 'sf-known-epoch']);

const problem = (status: number, code: string): Response => new Response(JSON.stringify({
  type: `urn:smallframe:error:${code.toLowerCase()}`,
  title: code,
  status,
}), {status, headers: {'Content-Type': 'application/problem+json; charset=utf-8', 'Cache-Control': 'no-store'}});

const handleCorsPreflight = (request: Request, config: {cors: {allowOrigin: string}}, action: string): Response => {
  if (request.headers.get('Origin') !== config.cors.allowOrigin) return problem(403, 'ORIGIN_INVALID');
  const methods = PREFLIGHT_METHODS[action];
  const requestedMethod = request.headers.get('Access-Control-Request-Method');
  const requestedHeaders = (request.headers.get('Access-Control-Request-Headers') ?? '')
    .split(',')
    .map((header) => header.trim().toLowerCase())
    .filter(Boolean);
  if (!requestedMethod || !methods || !methods.has(requestedMethod) || requestedHeaders.some((header) => !PREFLIGHT_HEADERS.has(header))) {
    return problem(403, 'PREFLIGHT_INVALID');
  }
  return new Response(null, {status: 204, headers: {
    'Access-Control-Allow-Origin': config.cors.allowOrigin,
    'Access-Control-Allow-Methods': [...methods].join(', '),
    'Access-Control-Allow-Headers': [...PREFLIGHT_HEADERS].join(', '),
    'Access-Control-Max-Age': '0',
    'Cache-Control': 'no-store',
    Vary: 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers',
  }});
};

const handlePublishRoute = async (pathname: string, request: Request, env: WorkerEnvironment): Promise<Response | null> => {
  if (pathname === '/v1/enroll' && request.method === 'POST') {
    return handleEnrollment(request);
  }
  if (pathname === '/v1/admin/invite' && request.method === 'POST') {
    return handleAdminCreateInvite(request);
  }
  if (pathname === '/v1/packages' && request.method === 'POST') {
    return handlePackageUpload(request);
  }
  if (pathname.startsWith('/v1/packages/') && request.method === 'GET') {
    const pkgDigest = pathname.slice('/v1/packages/'.length);
    return handleGetPackage(pkgDigest);
  }
  if (pathname === '/v1/rooms' && request.method === 'POST') {
    return handleRoomCreationSaga(request, env);
  }
  return null;
};

const worker = {
  async fetch(request: Request, env: WorkerEnvironment): Promise<Response> {
    const config = readApiRuntimeConfig(env);
    const respond = (response: Response): Response => secureApiResponse(response, config, request.headers.get('Origin'));
    const url = new URL(request.url);

    if (url.pathname === '/healthz' && request.method === 'GET') {
      return respond(new Response('{"ok":true}', {headers: {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'}}));
    }

    const publishRes = await handlePublishRoute(url.pathname, request, env);
    if (publishRes) return respond(publishRes);

    const match = PUBLIC_ROOM_ROUTE.exec(url.pathname);
    const roomId = match?.[1];
    if (!roomId || !ROOM_ID_RE.test(roomId)) return respond(problem(404, 'NOT_FOUND'));

    const action = match?.[2] ?? '';
    if (request.method === 'OPTIONS') {
      return respond(handleCorsPreflight(request, config, action));
    }

    if (action === 'package' && request.method === 'GET') {
      const room = globalPublishStore.rooms.get(roomId);
      if (room) {
        return respond(await handleGetPackage(room.packageDigest));
      }
    }

    const object = env.ROOMS.get(env.ROOMS.idFromName(roomId));
    return respond(await object.fetch(request));
  },
};

export {RoomDurableObject};
export default worker;
export type {WorkerEnvironment};
