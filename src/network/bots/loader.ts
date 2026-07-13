import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * The strong strategies live in the standalone `bot/` package (single source of
 * truth, also used by the external network client). The server runs them
 * in-process, but importing `bot/src` statically would drag that package into
 * the server's `tsc` root and couple the two builds. Instead we load the bot
 * registry through a runtime dynamic import: the path is computed, so the
 * compiler never follows it, while `tsx` (our runtime) transpiles the modules
 * on demand.
 */

export type BotStrength = 'strong' | 'medium' | 'basic';

export interface BotMeta {
  id: string;
  label: string;
  description: string;
  strength: BotStrength;
}

export interface BotDecisionContext {
  state: Record<string, unknown>;
  myId: string;
  myIndex: number;
  me: Record<string, unknown>;
}

export interface BotStrategy {
  observe?(ctx: BotDecisionContext): void;
  chooseBid(ctx: BotDecisionContext): number;
  chooseCard(ctx: BotDecisionContext): number;
  chooseJokerAction(ctx: BotDecisionContext, cardIndex: number): { type: string; suit?: string };
  chooseControlGame(ctx: BotDecisionContext): { roundType: string; dealerIndex: number };
  shouldStartGame?(ctx: BotDecisionContext): boolean;
}

interface BotRegistryModule {
  listBots: () => BotMeta[];
  isKnownBot: (id: string) => boolean;
  createStrategy: (id: string) => Promise<BotStrategy>;
  pickRandomBotIds: (count: number, exclude?: readonly string[]) => string[];
}

let registryPromise: Promise<BotRegistryModule> | null = null;

function loadRegistry(): Promise<BotRegistryModule> {
  if (!registryPromise) {
    const registryPath = path.resolve(process.cwd(), 'bot', 'src', 'strategy', 'registry.ts');
    const specifier = pathToFileURL(registryPath).href;
    registryPromise = import(specifier).then((mod) => mod as BotRegistryModule);
    registryPromise.catch(() => {
      // Reset so a transient failure can be retried on the next request.
      registryPromise = null;
    });
  }
  return registryPromise;
}

export async function listBotMeta(): Promise<BotMeta[]> {
  const registry = await loadRegistry();
  return registry.listBots();
}

export async function isKnownBot(id: string): Promise<boolean> {
  const registry = await loadRegistry();
  return registry.isKnownBot(id);
}

export async function createBotStrategy(id: string): Promise<BotStrategy> {
  const registry = await loadRegistry();
  return registry.createStrategy(id);
}

export async function pickRandomBotIds(
  count: number,
  exclude: readonly string[] = [],
): Promise<string[]> {
  const registry = await loadRegistry();
  return registry.pickRandomBotIds(count, exclude);
}
