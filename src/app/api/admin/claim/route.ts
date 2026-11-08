import { proxyGame } from '@/lib/game-service';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  return proxyGame(req, '/api/admin/claim');
}
