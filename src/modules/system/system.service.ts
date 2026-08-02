import { appRedis } from '#app/lib/redis.js';
import { prisma } from '#app/lib/prisma.js';

export async function checkReadiness(): Promise<void> {
  await Promise.all([prisma.$queryRaw`SELECT 1`, appRedis.ping()]);
}
