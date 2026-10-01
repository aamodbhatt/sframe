import type {RuntimeEnvironment} from '../../../packages/protocol/src/runtime-config.js';
import {handleAdminCreateInvite, handleEnrollment, handlePackageUpload, handlePublisherGetPackage,
  handleRoomCreationSaga} from './publish-api.js';

type PublishEnvironment = {
  ENVIRONMENT: RuntimeEnvironment;
  ROOMS: Parameters<typeof handleRoomCreationSaga>[1]['ROOMS'];
};

export const handlePublishRoute = async (pathname: string, request: Request, env: PublishEnvironment): Promise<Response | null> => {
  const prototypePath = ['/v1/enroll', '/v1/admin/invite', '/v1/packages', '/v1/rooms'].includes(pathname)
    || pathname.startsWith('/v1/packages/');
  // In-memory publisher storage and the raw genesis saga
  // are local fixtures. Reject before credentials/body/DO access elsewhere.
  if (prototypePath && env.ENVIRONMENT !== 'local') {
    return new Response(JSON.stringify({type: 'urn:smallframe:error:publishing_not_implemented',
      title: 'PUBLISHING_NOT_IMPLEMENTED', status: 503}), {
      status: 503, headers: {'Content-Type': 'application/problem+json; charset=utf-8', 'Cache-Control': 'no-store'},
    });
  }
  if (pathname === '/v1/enroll' && request.method === 'POST') return handleEnrollment(request);
  if (pathname === '/v1/admin/invite' && request.method === 'POST') return handleAdminCreateInvite(request);
  if (pathname === '/v1/packages' && request.method === 'POST') return handlePackageUpload(request);
  if (pathname.startsWith('/v1/packages/') && request.method === 'GET') {
    return handlePublisherGetPackage(request, pathname.slice('/v1/packages/'.length));
  }
  if (pathname === '/v1/rooms' && request.method === 'POST') return handleRoomCreationSaga(request, env);
  return null;
};
