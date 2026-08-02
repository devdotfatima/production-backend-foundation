import { UserStatus } from '@prisma/client';
import { withAuditedTransaction } from '#app/lib/audited-transaction.js';
import {
  auditMetadata,
  type RequestMetadata,
  type TokenPair,
} from '#app/modules/auth/auth.shared.js';
import { createSession } from '#app/modules/auth/auth.sessions.service.js';
import { verifySocialIdentity } from '#app/modules/auth/social.service.js';

export async function loginWithSocial(
  provider: 'google' | 'apple',
  idToken: string,
  displayName: string | undefined,
  metadata: RequestMetadata,
): Promise<TokenPair | null> {
  const identity = await verifySocialIdentity(provider, idToken);
  const userId = await withAuditedTransaction(async (tx, audit) => {
    const linked = await tx.socialAccount.findFirst({
      where: {
        provider: identity.provider,
        providerAccountId: identity.providerAccountId,
        deletedAt: null,
      },
      select: { userId: true, user: { select: { id: true, status: true, deletedAt: true } } },
    });
    if (linked) {
      if (linked.user.deletedAt || linked.user.status !== UserStatus.ACTIVE) return null;
      await tx.socialAccount.updateMany({
        where: { userId: linked.userId, provider: identity.provider, deletedAt: null },
        data: { email: identity.email },
      });
      return linked.userId;
    }
    const existing = identity.email
      ? await tx.user.findUnique({
          where: { email: identity.email },
          select: { id: true, status: true, deletedAt: true },
        })
      : null;
    if (
      existing?.deletedAt ||
      existing?.status === UserStatus.SUSPENDED ||
      existing?.status === UserStatus.DISABLED
    )
      return null;
    let userIdForAccount: string;
    if (existing) {
      const activated = await tx.user.update({
        where: { id: existing.id },
        data: {
          status: UserStatus.ACTIVE,
          ...(identity.emailVerified ? { emailVerifiedAt: new Date() } : {}),
          ...(displayName || identity.displayName
            ? { displayName: displayName ?? identity.displayName }
            : {}),
        },
        select: { id: true },
      });
      userIdForAccount = activated.id;
    } else {
      const created = await tx.user.create({
        data: {
          email: identity.email,
          displayName: displayName ?? identity.displayName,
          status: UserStatus.ACTIVE,
          ...(identity.emailVerified ? { emailVerifiedAt: new Date() } : {}),
        },
        select: { id: true },
      });
      userIdForAccount = created.id;
    }
    await tx.socialAccount.create({
      data: {
        userId: userIdForAccount,
        provider: identity.provider,
        providerAccountId: identity.providerAccountId,
        email: identity.email,
      },
    });
    await audit({
      actorUserId: userIdForAccount,
      action: 'auth.social_account.linked',
      entityType: 'social_account',
      metadata: { provider: identity.provider },
      ...auditMetadata(metadata),
    });
    return userIdForAccount;
  });
  return userId ? createSession(userId, metadata) : null;
}
