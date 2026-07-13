import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import prisma from '../db/prisma';
import redis from '../db/redis';
import { sendVerificationEmail, sendPasswordResetEmail } from './email';

const authRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  fastify.post('/register', async (request, reply) => {
    const { email, password } = request.body as any;
    if (!email || !password) {
      return reply.status(400).send({ error: 'Email and password are required' });
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
      },
    });

    // Verification token TTL 24 hours
    const token = uuidv4();
    await redis.set(`verify:${token}`, user.id, 'EX', 86400);

    await sendVerificationEmail(email, token);

    return reply.status(201).send({ message: 'User registered. Please verify your email.' });
  });

  fastify.get('/verify', async (request, reply) => {
    const { token } = request.query as any;
    if (!token) return reply.status(400).send({ error: 'Token is required' });

    const userId = await redis.get(`verify:${token}`);
    if (!userId) {
      return reply.status(400).send({ error: 'Invalid or expired verification token' });
    }

    await prisma.user.update({
      where: { id: userId },
      data: { verified: true },
    });
    await redis.del(`verify:${token}`);

    return reply.send({ message: 'Email verified successfully' });
  });

  fastify.post('/login', async (request, reply) => {
    const { email, password } = request.body as any;
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

    const token = fastify.jwt.sign({ id: user.id, email: user.email, verified: user.verified });
    return reply.send({ token });
  });

  fastify.post('/forgot-password', async (request, reply) => {
    const { email } = request.body as any;
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      // Don't reveal user existence
      return reply.send({ message: 'If email exists, a reset link was sent.' });
    }

    const resetToken = uuidv4();
    await redis.set(`reset:${resetToken}`, user.id, 'EX', 3600); // 1 hour TTL
    await sendPasswordResetEmail(email, resetToken);

    return reply.send({ message: 'If email exists, a reset link was sent.' });
  });

  fastify.post('/reset-password', async (request, reply) => {
    const { token, newPassword } = request.body as any;
    if (!token || !newPassword) {
      return reply.status(400).send({ error: 'Token and new password are required' });
    }

    const userId = await redis.get(`reset:${token}`);
    if (!userId) {
      return reply.status(400).send({ error: 'Invalid or expired reset token' });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await prisma.user.update({
      where: { id: userId },
      data: { password: hashedPassword },
    });
    await redis.del(`reset:${token}`);

    return reply.send({ message: 'Password has been reset' });
  });
};

export default authRoutes;
