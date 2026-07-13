import type { Strategy } from './Strategy';

export type BotStrength = 'strong' | 'medium' | 'basic';

export interface BotDefinition {
  id: string;
  label: string;
  description: string;
  strength: BotStrength;
  // Lazy factory: each strategy is imported on demand so a single broken
  // strategy module can never take down the whole catalogue.
  create: () => Promise<Strategy>;
}

export interface BotMeta {
  id: string;
  label: string;
  description: string;
  strength: BotStrength;
}

const REGISTRY: readonly BotDefinition[] = [
  {
    id: 'solaris',
    label: 'Solaris',
    description: 'Расчётливый предиктивный бот с моделированием скрытых карт и концовки.',
    strength: 'strong',
    create: async () => new (await import('./SolarisStrategy')).SolarisStrategy(),
  },
  {
    id: 'claude',
    label: 'Claude',
    description: 'Сильнейший бот: расчёт вероятностей взяток и планирование ходов.',
    strength: 'strong',
    create: async () => new (await import('./ClaudeStrategy')).ClaudeStrategy(),
  },
  {
    id: 'grok',
    label: 'Grok',
    description:
      'Конкурентный бот: suit-establishment ставки, void-tracking, tournament EV, lookahead, эндгейм к нулю.',
    strength: 'strong',
    create: async () => new (await import('./GrokStrategy')).GrokStrategy(),
  },
  {
    id: 'glm',
    label: 'GLM',
    description: 'Предиктивный бот: EV-ставки с учётом давления соперников, lookahead-розыгрыш, эндгейм к нулевому счёту.',
    strength: 'strong',
    create: async () => new (await import('./GlmStrategy')).GlmStrategy(),
  },
  {
    id: 'composer',
    label: 'Composer',
    description: 'Аккуратный бот с планированием розыгрыша раздачи.',
    strength: 'medium',
    create: async () => new (await import('./ComposerStrategy')).ComposerStrategy(),
  },
  {
    id: 'antigravity',
    label: 'Antigravity',
    description: 'Агрессивный экспериментальный бот.',
    strength: 'medium',
    create: async () => new (await import('./AntigravityStrategy')).AntigravityStrategy(),
  },
  {
    id: 'random',
    label: 'Новичок',
    description: 'Новичок: расчетливый, прагматичный и предиктивный алгоритм.',
    strength: 'basic',
    create: async () => new (await import('./RandomStrategy')).RandomStrategy(),
  },
];

const BY_ID = new Map<string, BotDefinition>(REGISTRY.map((bot) => [bot.id, bot]));

export function listBots(): BotMeta[] {
  return REGISTRY.map((bot) => ({
    id: bot.id,
    label: bot.label,
    description: bot.description,
    strength: bot.strength,
  }));
}

export function getBotDefinition(id: string): BotDefinition | undefined {
  return BY_ID.get(id);
}

export function isKnownBot(id: string): boolean {
  return BY_ID.has(id);
}

export async function createStrategy(id: string): Promise<Strategy> {
  const definition = BY_ID.get(id);
  if (!definition) {
    throw new Error(`Unknown bot strategy: ${id}`);
  }
  return definition.create();
}

/**
 * Pick `count` bot ids at random, preferring distinct strategies. When more
 * seats than strategies are requested, ids repeat (deterministically shuffled).
 */
export function pickRandomBotIds(count: number, exclude: readonly string[] = []): string[] {
  const excluded = new Set(exclude);
  const pool = REGISTRY.map((bot) => bot.id).filter((id) => !excluded.has(id));
  const source = pool.length > 0 ? pool : REGISTRY.map((bot) => bot.id);

  const shuffled = [...source];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  const picked: string[] = [];
  for (let i = 0; i < count; i += 1) {
    picked.push(shuffled[i % shuffled.length]);
  }
  return picked;
}
