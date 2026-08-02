import { candidateOpaqueTokenHashes, hashOpaqueToken, randomToken } from '#app/lib/crypto.js';
import { errors } from '#app/lib/errors.js';
import { prisma } from '#app/lib/prisma.js';

export const createServiceAccount = (input: { name: string; permissions: string[] }) =>
  prisma.serviceAccount.create({ data: input });

export async function createApiKey(
  serviceAccountId: string,
  input: { name: string; expiresAt?: Date },
) {
  const account = await prisma.serviceAccount.findFirst({
    where: { id: serviceAccountId, active: true, deletedAt: null },
  });
  if (!account) throw errors.notFound('Service account not found');
  const rawKey = `sk_service_${randomToken(32)}`;
  const apiKey = await prisma.apiKey.create({
    data: {
      serviceAccountId,
      name: input.name,
      prefix: rawKey.slice(0, 18),
      keyHash: hashOpaqueToken(rawKey),
      expiresAt: input.expiresAt,
    },
    select: { id: true, name: true, prefix: true, expiresAt: true, createdAt: true },
  });
  return { apiKey, secret: rawKey };
}

export async function revokeApiKey(serviceAccountId: string, apiKeyId: string) {
  const result = await prisma.apiKey.updateMany({
    where: { id: apiKeyId, serviceAccountId, revokedAt: null, deletedAt: null },
    data: { revokedAt: new Date() },
  });
  if (result.count !== 1) throw errors.notFound('API key not found');
}

export async function authenticateApiKey(rawKey: string, requiredPermission?: string) {
  const key = await prisma.apiKey.findFirst({
    where: {
      keyHash: { in: candidateOpaqueTokenHashes(rawKey) },
      revokedAt: null,
      deletedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      serviceAccount: { active: true, deletedAt: null },
    },
    include: { serviceAccount: true },
  });
  if (!key || (requiredPermission && !key.serviceAccount.permissions.includes(requiredPermission)))
    return null;
  void prisma.apiKey
    .update({ where: { id: key.id }, data: { lastUsedAt: new Date() } })
    .catch(() => undefined);
  return {
    apiKeyId: key.id,
    serviceAccountId: key.serviceAccountId,
    permissions: key.serviceAccount.permissions,
    permissionEpoch: key.serviceAccount.permissionEpoch,
  };
}
