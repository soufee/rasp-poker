import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import prisma from '../db/prisma';
import { getRedis } from '../db/redis';
import { sendVerificationEmail, sendPasswordResetEmail } from './email';
import { authenticate, AuthUser } from './middleware';
import { config, isLocal, isProduction } from '../config/env';
import { getLocalDevUser } from '../db/seedLocal';

const MIN_PASSWORD_LENGTH = 8;

function signUserToken(
  fastify: FastifyInstance,
  user: {
    id: string;
    email: string;
    verified: boolean;
    role?: string;
    displayName?: string;
    tokenVersion?: number;
  },
) {
  return fastify.jwt.sign({
    id: user.id,
    email: user.email,
    verified: user.verified,
    role: user.role,
    displayName: user.displayName,
    tokenVersion: user.tokenVersion ?? 0,
  });
}

function validatePassword(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  }
  return null;
}

const authRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  fastify.get('/session', async (request, reply) => {
    if (isLocal) {
      const dev = await getLocalDevUser();
      if (!dev) {
        return reply.status(500).send({ error: 'Local superuser not seeded' });
      }
      const dbUser = await prisma.user.findUnique({ where: { id: dev.id } });
      const token = signUserToken(fastify, {
        id: dev.id,
        email: dev.email,
        verified: true,
        role: dev.role,
        displayName: dev.displayName,
        tokenVersion: dbUser?.tokenVersion ?? 0,
      });
      return {
        mode: 'local',
        autoLogin: true,
        token,
        user: {
          id: dev.id,
          email: dev.email,
          displayName: dev.displayName,
          role: dev.role,
          verified: true,
        },
      };
    }

    try {
      await request.jwtVerify();
    } catch {
      return reply.status(401).send({ error: 'Unauthorized', mode: 'production' });
    }

    const u = request.user as AuthUser;
    return {
      mode: 'production',
      autoLogin: false,
      user: {
        id: u.id,
        email: u.email,
        displayName: u.displayName,
        role: u.role,
        verified: u.verified,
      },
    };
  });

  fastify.get('/dev-login', async (_request, reply) => {
    if (!isLocal) {
      return reply.status(404).send({ error: 'Not available in production' });
    }
    const dev = await getLocalDevUser();
    if (!dev) {
      return reply.status(500).send({ error: 'Local superuser not seeded' });
    }
    const dbUser = await prisma.user.findUnique({ where: { id: dev.id } });
    const token = signUserToken(fastify, {
      id: dev.id,
      email: dev.email,
      verified: true,
      role: dev.role,
      displayName: dev.displayName,
      tokenVersion: dbUser?.tokenVersion ?? 0,
    });
    return {
      mode: 'local',
      autoLogin: true,
      token,
      user: {
        id: dev.id,
        email: dev.email,
        displayName: dev.displayName,
        role: dev.role,
        verified: true,
      },
    };
  });

  fastify.post('/register', async (request, reply) => {
    if (isLocal) {
      return reply.status(400).send({
        error:
          'Registration disabled in local mode. Use GET /api/auth/session for auto-login as dev.',
      });
    }

    const { email, password, displayName } = request.body as {
      email?: string;
      password?: string;
      displayName?: string;
    };
    if (!email || !password) {
      return reply.status(400).send({ error: 'Email and password are required' });
    }
    const passwordError = validatePassword(password);
    if (passwordError) {
      return reply.status(400).send({ error: passwordError });
    }

    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      return reply.status(400).send({ error: 'Email already registered' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: {
        email,
        password: hashedPassword,
        displayName: displayName || email.split('@')[0],
      },
    });

    const token = uuidv4();
    const redis = getRedis();
    await redis.set(`verify:${token}`, user.id, 'EX', 86400);
    await sendVerificationEmail(email, token);

    return reply.status(201).send({
      message: 'User registered. Please verify your email.',
      // Ranked play blocked until verified; training with bots is allowed.
      rankedPlayAllowed: false,
    });
  });

  fastify.get('/verify', async (request, reply) => {
    if (isLocal) {
      return reply.send({ message: 'Verification skipped in local mode' });
    }

    const { token } = request.query as { token?: string };
    if (!token) return reply.status(400).send({ error: 'Token is required' });

    const redis = getRedis();
    const userId = await redis.get(`verify:${token}`);
    if (!userId) {
      return reply.status(400).send({ error: 'Invalid or expired verification token' });
    }

    await prisma.user.update({
      where: { id: userId },
      data: { verified: true },
    });
    await redis.del(`verify:${token}`);

    return reply.send({ message: 'Email verified successfully', rankedPlayAllowed: true });
  });

  fastify.post('/login', async (request, reply) => {
    if (isLocal) {
      const dev = await getLocalDevUser();
      if (dev) {
        const dbUser = await prisma.user.findUnique({ where: { id: dev.id } });
        const token = signUserToken(fastify, {
          id: dev.id,
          email: dev.email,
          verified: true,
          role: dev.role,
          displayName: dev.displayName,
          tokenVersion: dbUser?.tokenVersion ?? 0,
        });
        return {
          token,
          user: dev,
          note: 'Local mode: auto-authenticated as superuser dev',
        };
      }
    }

    const { email, password } = request.body as { email?: string; password?: string };
    if (!email || !password) {
      return reply.status(400).send({ error: 'Email and password are required' });
    }

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      return reply.status(401).send({ error: 'Invalid credentials' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return reply.status(401).send({ error: 'Invalid credentials' });
    }

    const token = signUserToken(fastify, {
      id: user.id,
      email: user.email,
      verified: user.verified,
      role: user.role,
      displayName: user.displayName,
      tokenVersion: user.tokenVersion,
    });
    return {
      token,
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        role: user.role,
        verified: user.verified,
      },
      rankedPlayAllowed: user.verified,
    };
  });

  fastify.post('/forgot-password', async (request, reply) => {
    if (isLocal) {
      return reply.send({ message: 'Password reset disabled in local mode' });
    }

    const { email } = request.body as { email?: string };
    const user = email ? await prisma.user.findUnique({ where: { email } }) : null;
    if (!user) {
      return reply.send({ message: 'If email exists, a reset link was sent.' });
    }

    const resetToken = uuidv4();
    const redis = getRedis();
    await redis.set(`reset:${resetToken}`, user.id, 'EX', 3600);
    await sendPasswordResetEmail(email!, resetToken);

    return reply.send({ message: 'If email exists, a reset link was sent.' });
  });

  fastify.post('/reset-password', async (request, reply) => {
    if (isLocal) {
      return reply.status(400).send({ error: 'Password reset disabled in local mode' });
    }

    const { token, newPassword } = request.body as { token?: string; newPassword?: string };
    if (!token || !newPassword) {
      return reply.status(400).send({ error: 'Token and new password are required' });
    }
    const passwordError = validatePassword(newPassword);
    if (passwordError) {
      return reply.status(400).send({ error: passwordError });
    }

    const redis = getRedis();
    const userId = await redis.get(`reset:${token}`);
    if (!userId) {
      return reply.status(400).send({ error: 'Invalid or expired reset token' });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    // Increment tokenVersion → all prior JWTs become invalid
    await prisma.user.update({
      where: { id: userId },
      data: {
        password: hashedPassword,
        tokenVersion: { increment: 1 },
      },
    });
    await redis.del(`reset:${token}`);

    return reply.send({
      message: 'Password has been reset. Please log in again on all devices.',
    });
  });

  fastify.get('/me', { preHandler: [authenticate] }, async (request) => {
    const u = request.user as AuthUser;
    return {
      id: u.id,
      email: u.email,
      displayName: u.displayName,
      role: u.role,
      verified: u.verified,
      rankedPlayAllowed: isLocal || u.verified === true,
      mode: isProduction ? 'production' : 'local',
      authRequired: isProduction,
    };
  });

  fastify.get('/mode', async () => ({
    appEnv: config.appEnv,
    authRequired: isProduction,
    localAutoLogin: isLocal,
  }));
};

export default authRoutes;
