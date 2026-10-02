import type {RuntimeEnvironment} from '../../../packages/protocol/src/runtime-config.js';
import {handleAdminCreateInvite, handleEnrollment, handlePackageUpload, handlePublisherGetPackage,
  handleRoomCreationSaga, globalPublishStore, type PublishStore} from './publish-api.js';
import {DurablePublisherStorage} from './durable-publisher-storage.js';
import type {D1Database, R2Bucket} from '@cloudflare/workers-types';

type PublishEnvironment = {
  ENVIRONMENT: RuntimeEnvironment;
  DB?: unknown;
  PACKAGES?: unknown;
  ROOMS: Parameters<typeof handleRoomCreationSaga>[1]['ROOMS'];
};

const stores = new WeakMap<object, PublishStore>();
export const localPublishStore = (env: Pick<PublishEnvironment, 'DB' | 'PACKAGES'>): PublishStore => {
  if (!env.DB || !env.PACKAGES) throw new Error('PUBLISHER_BINDINGS_MISSING');
  const identity = env.DB as object;
  let store = stores.get(identity);
  if (!store) {
    store = {...globalPublishStore, durable: new DurablePublisherStorage(env.DB as D1Database, env.PACKAGES as R2Bucket)};
    stores.set(identity, store);
  }
  return store;
};

export const handlePublishRoute = async (pathname: string, request: Request, env: PublishEnvironment): Promise<Response | null> => {
  const prototypePath = ['/v1/enroll', '/v1/admin/invite', '/v1/packages', '/v1/rooms'].includes(pathname)
    || pathname.startsWith('/v1/packages/');
  // The unfinished room saga and production authority
  // are local fixtures. Reject before credentials/body/DO access elsewhere.
  if (prototypePath && env.ENVIRONMENT !== 'local') {
    return new Response(JSON.stringify({type: 'urn:smallframe:error:publishing_not_implemented',
      title: 'PUBLISHING_NOT_IMPLEMENTED', status: 503}), {
      status: 503, headers: {'Content-Type': 'application/problem+json; charset=utf-8', 'Cache-Control': 'no-store'},
    });
  }
  if (!prototypePath) return null;
  let store: PublishStore;
  try { store = localPublishStore(env); } catch { return new Response(null, {status: 503}); }
  if (pathname === '/v1/enroll' && request.method === 'POST') return handleEnrollment(request, store);
  if (pathname === '/v1/admin/invite' && request.method === 'POST') return handleAdminCreateInvite(request, store);
  if (pathname === '/v1/packages' && request.method === 'POST') return handlePackageUpload(request, store);
  if (pathname.startsWith('/v1/packages/') && request.method === 'GET') {
    return handlePublisherGetPackage(request, pathname.slice('/v1/packages/'.length), store);
  }
  if (pathname === '/v1/rooms' && request.method === 'POST') return handleRoomCreationSaga(request, env, store);
  return null;
};
