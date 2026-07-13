import { FastifyRequest, FastifyReply } from 'fastify';

export async function authenticate(request: FastifyRequest, reply: FastifyReply) {
  try {
    await request.jwtVerify();
  } catch (err) {
    reply.send(err);
  }
}

export async function requireVerification(request: FastifyRequest, reply: FastifyReply) {
  const user = request.user as any;
  if (!user || !user.verified) {
    return reply.status(403).send({ error: 'Account must be verified to perform this action' });
  }
}
