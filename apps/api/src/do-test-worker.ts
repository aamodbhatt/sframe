import productionWorker, {RoomDurableObject, type WorkerEnvironment} from './do-worker.js';
import {ROOM_ID_RE} from './do-crypto.js';

const TEST_ROUTE = /^\/__phase0\/rooms\/([A-Za-z0-9_-]{22})\/(?:init|init-envelope|status)$/u;

const testWorker = {
  async fetch(request: Request, env: WorkerEnvironment): Promise<Response> {
    const url = new URL(request.url);
    const match = TEST_ROUTE.exec(url.pathname);
    const roomId = match?.[1];
    if (roomId && ROOM_ID_RE.test(roomId)) {
      const object = env.ROOMS.get(env.ROOMS.idFromName(roomId));
      return object.fetch(request);
    }
    return productionWorker.fetch(request, env);
  },
};

export {RoomDurableObject};
export default testWorker;
