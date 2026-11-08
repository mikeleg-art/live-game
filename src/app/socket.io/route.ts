import { proxySocket } from '@/lib/game-service';

/* Socket.io polling transport, proxied same-origin to the game service.
   Clients connect with  io({ path: '/socket.io', transports: ['polling'],
   addTrailingSlash: false })  so no gateway query param is ever needed. */
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  return proxySocket(req);
}

export async function POST(req: Request) {
  return proxySocket(req);
}
