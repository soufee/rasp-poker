import { FastifyRequest, FastifyReply } from 'fastify';
import { isLocal } from '../config/env';
import { getLocalDevUser } from '../db/seedLocal';

export type AuthUser = {
  id: string;
  email: string;
  verified: boolean;
  role?: string;
  displayName?: string;
};

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: AuthUser;
    user: AuthUser;
  }
}

/**
 * Require JWT. In local APP_ENV, missing/invalid token falls back to superuser `dev`.
 */
export async function authenticate(request: FastifyRequest, reply: FastifyReply) {
  try {
    await request.jwtVerify();
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
        };
        return;
      }
    }
    return reply.status(401).send({ error: 'Unauthorized' });
  }
}

export async function requireVerification(request: FastifyRequest, reply: FastifyReply) {
  // Local superuser always allowed
  if (isLocal) {
    return;
  }
  const user = request.user as AuthUser | undefined;
  if (!user || !user.verified) {
    return reply.status(403).send({ error: 'Account must be verified to perform this action' });
  }
}
