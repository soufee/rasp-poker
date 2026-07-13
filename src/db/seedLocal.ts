import bcrypt from 'bcryptjs';
import { UserRole } from '@prisma/client';
import prisma from './prisma';
import { config, isLocal } from '../config/env';

export type DevUser = {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
  verified: boolean;
};

/**
 * Ensures local superuser `dev` exists so developers can play without registration.
 * No-op outside local environment.
 */
export async function ensureLocalDevUser(): Promise<DevUser | null> {
  if (!isLocal) {
    return null;
  }

  const { email, displayName, password } = config.localDev;
  const hashed = await bcrypt.hash(password, 10);

  const user = await prisma.user.upsert({
    where: { email },
    update: {
      displayName,
      role: UserRole.SUPERUSER,
      verified: true,
      password: hashed,
    },
    create: {
      email,
      displayName,
      role: UserRole.SUPERUSER,
      verified: true,
      password: hashed,
    },
  });

  console.log(
    `[auth] Local superuser ready: ${user.displayName} <${user.email}> (role=${user.role})`,
  );

  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    verified: user.verified,
  };
}

export async function getLocalDevUser(): Promise<DevUser | null> {
  if (!isLocal) return null;
  const user = await prisma.user.findUnique({ where: { email: config.localDev.email } });
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    verified: user.verified,
  };
}
