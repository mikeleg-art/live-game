import { proxyGame } from '@/lib/game-service';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  return proxyGame(req, '/api/health');
}
