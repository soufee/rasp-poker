import { execSync } from 'child_process';
import path from 'path';

/**
 * Apply pending Prisma migrations on every process start.
 * Uses `prisma migrate deploy` (safe for prod; no interactive prompts).
 */
export function runMigrations(): void {
  const projectRoot = process.cwd();
  console.log('[db] Checking and applying Prisma migrations...');

  try {
    execSync('npx prisma migrate deploy', {
      cwd: projectRoot,
      stdio: 'inherit',
      env: process.env,
    });
    console.log('[db] Migrations up to date');
  } catch (err) {
    console.error('[db] Migration failed');
    throw err;
  }
}

/**
 * Ensure Prisma Client is generated (useful after fresh clone).
 */
export function generatePrismaClient(): void {
  try {
    execSync('npx prisma generate', {
      cwd: path.resolve(process.cwd()),
      stdio: 'inherit',
      env: process.env,
    });
  } catch (err) {
    console.error('[db] prisma generate failed');
    throw err;
  }
}
