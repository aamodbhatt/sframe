import type {DurableObjectNamespace} from 'cloudflare:workers';
import {ROOM_ID_RE} from './do-crypto.js';
import {RoomDurableObject, type RoomEnvironment} from './do-room.js';
import {readApiRuntimeConfig, secureApiResponse} from './runtime-config.js';

type WorkerEnvironment = RoomEnvironment & {
  ROOMS: DurableObjectNamespace;
};

const PUBLIC_ROOM_ROUTE = /^\/v1\/rooms\/([A-Za-z0-9_-]{22})\/(state|events|events-ticket|socket)$/u;
const PREFLIGHT_METHODS = Object.freeze({
  state: new Set(['GET', 'PUT']),
  events: new Set(['GET']),
  'events-ticket': new Set(['POST']),
  socket: new Set<string>(),
});
const PREFLIGHT_HEADERS = new Set(['authorization', 'content-type', 'if-match', 'if-none-match', 'sf-known-epoch']);

const problem = (status: number, code: string): Response => new Response(JSON.stringify({
  type: `urn:smallframe:error:${code.toLowerCase()}`,
  title: code,
  status,
}), {status, headers: {'Content-Type': 'application/problem+json; charset=utf-8', 'Cache-Control': 'no-store'}});

const worker = {
  async fetch(request: Request, env: WorkerEnvironment): Promise<Response> {
    const config = readApiRuntimeConfig(env);
    const respond = (response: Response): Response => secureApiResponse(response, config, request.headers.get('Origin'));
    const url = new URL(request.url);
    if (url.pathname === '/healthz' && request.method === 'GET') {
      return respond(new Response('{"ok":true}', {headers: {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'}}));
    }
    const match = PUBLIC_ROOM_ROUTE.exec(url.pathname);
    const roomId = match?.[1];
    if (!roomId || !ROOM_ID_RE.test(roomId)) return respond(problem(404, 'NOT_FOUND'));
    if (request.method === 'OPTIONS') {
      if (request.headers.get('Origin') !== config.cors.allowOrigin) return respond(problem(403, 'ORIGIN_INVALID'));
      const action = match?.[2] as keyof typeof PREFLIGHT_METHODS;
      const requestedMethod = request.headers.get('Access-Control-Request-Method');
      const requestedHeaders = (request.headers.get('Access-Control-Request-Headers') ?? '')
        .split(',')
        .map((header) => header.trim().toLowerCase())
        .filter(Boolean);
      if (!requestedMethod || !PREFLIGHT_METHODS[action].has(requestedMethod) || requestedHeaders.some((header) => !PREFLIGHT_HEADERS.has(header))) {
        return respond(problem(403, 'PREFLIGHT_INVALID'));
      }
      return respond(new Response(null, {status: 204, headers: {
        'Access-Control-Allow-Origin': config.cors.allowOrigin,
        'Access-Control-Allow-Methods': [...PREFLIGHT_METHODS[action]].join(', '),
        'Access-Control-Allow-Headers': [...PREFLIGHT_HEADERS].join(', '),
        'Access-Control-Max-Age': '0',
        'Cache-Control': 'no-store',
        Vary: 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers',
      }}));
    }
    const object = env.ROOMS.get(env.ROOMS.idFromName(roomId));
    return respond(await object.fetch(request));
  },
};

export {RoomDurableObject};
export default worker;
export type {WorkerEnvironment};
