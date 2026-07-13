import { createHmac } from 'node:crypto';

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

export interface BotIdentity {
  id: string;
  displayName: string;
}

/**
 * Mint an HS256 JWT compatible with the server's @fastify/jwt verifier.
 * The WS route reads `id` and `displayName` from the verified payload, so a
 * self-signed token lets each bot occupy a distinct, stable seat.
 */
export function signBotToken(secret: string, identity: BotIdentity): string {
  const header = { alg: 'HS256', typ: 'JWT' };
  const issuedAt = Math.floor(Date.now() / 1000);
  const payload = {
    id: identity.id,
    sub: identity.id,
    displayName: identity.displayName,
    email: `${identity.id}@bots.local`,
    role: 'bot',
    verified: true,
    tokenVersion: 0,
    iat: issuedAt,
    exp: issuedAt + 60 * 60 * 12,
  };

  const encodedHeader = base64url(JSON.stringify(header));
  const encodedPayload = base64url(JSON.stringify(payload));
  const data = `${encodedHeader}.${encodedPayload}`;
  const signature = base64url(createHmac('sha256', secret).update(data).digest());
  return `${data}.${signature}`;
}
