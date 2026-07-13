import { FastifyRequest, FastifyReply } from 'fastify';
import { isLocal } from '../config/env';
import { getLocalDevUser } from '../db/seedLocal';
import prisma from '../db/prisma';

export type AuthUser = {
  id: string;
  email: string;
  verified: boolean;
  role?: string;
  displayName?: string;
  tokenVersion?: number;
};

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: AuthUser;
    user: AuthUser;
  }
}

/**
 * Require JWT. In local APP_ENV, missing/invalid token falls back to superuser `dev`.
 * Validates tokenVersion against DB so password-reset logs out all devices.
 */
export async function authenticate(request: FastifyRequest, reply: FastifyReply) {
  try {
    await request.jwtVerify();
    const payload = request.user as AuthUser;
    if (!isLocal && payload?.id) {
      const dbUser = await prisma.user.findUnique({
        where: { id: payload.id },
        select: { tokenVersion: true, verified: true, email: true, displayName: true, role: true },
      });
      if (!dbUser) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }
      if ((payload.tokenVersion ?? 0) !== dbUser.tokenVersion) {
        return reply.status(401).send({ error: 'Session expired. Please log in again.' });
      }
      request.user = {
        id: payload.id,
        email: dbUser.email,
        verified: dbUser.verified,
        role: dbUser.role,
        displayName: dbUser.displayName,
        tokenVersion: dbUser.tokenVersion,
      };
    }
    return;
  } catch {
    if (isLocal) {
      const dev = await getLocalDevUser();
      if (dev) {
        request.user = {
          id: dev.id,
          email: dev.email,
          verified: true,
          role: dev.role,
          displayName: dev.displayName,
          tokenVersion: 0,
        };
        return;
      }
    }
    return reply.status(401).send({ error: 'Unauthorized' });
  }
}

/** Ranked / human tables: require verified email (skipped in local). */
export async function requireVerification(request: FastifyRequest, reply: FastifyReply) {
  if (isLocal) {
    return;
  }
  const user = request.user as AuthUser | undefined;
  if (!user || !user.verified) {
    return reply.status(403).send({
      error: 'Account must be verified to join ranked games with real players',
      code: 'EMAIL_NOT_VERIFIED',
    });
  }
}
