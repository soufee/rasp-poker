export interface BotRuntimeConfig {
  host: string;
  roomId: string;
  userId: string;
  userName: string;
  token?: string;
  strategy: 'solaris' | 'grok' | 'composer' | 'random' | 'glm';
  /** Create a room and fill with bots (smoke) */
  smoke: boolean;
  players: 3 | 4 | 6;
  thinkDelayMs: number;
}

function argValue(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx >= 0 && args[idx + 1]) {
    return args[idx + 1];
  }
  const pref = `${name}=`;
  const hit = args.find((a) => a.startsWith(pref));
  return hit ? hit.slice(pref.length) : undefined;
}

export function parseConfig(argv = process.argv.slice(2)): BotRuntimeConfig {
  const smoke = argv.includes('--smoke');
  const host = argValue(argv, '--host') || process.env.BOT_HOST || 'http://127.0.0.1:3000';
  const roomId = argValue(argv, '--room') || process.env.BOT_ROOM || '';
  const strategyRaw = (argValue(argv, '--strategy') || process.env.BOT_STRATEGY || 'composer') as string;
  const strategy: BotRuntimeConfig['strategy'] =
    strategyRaw === 'solaris' ? 'solaris'
    : strategyRaw === 'grok' ? 'grok'
    : strategyRaw === 'random' ? 'random'
    : strategyRaw === 'glm' ? 'glm'
    : 'composer';
  const userId = argValue(argv, '--userId') || process.env.BOT_USER_ID
    || (strategy === 'solaris' ? 'bot-solaris'
      : strategy === 'grok' ? 'bot-grok'
      : strategy === 'composer' ? 'bot-composer'
      : strategy === 'glm' ? 'bot-glm'
      : 'bot-random');
  const userName = argValue(argv, '--userName') || process.env.BOT_USER_NAME
    || (strategy === 'solaris' ? 'Solaris'
      : strategy === 'grok' ? 'Grok'
      : strategy === 'composer' ? 'Composer'
      : strategy === 'glm' ? 'GLM'
      : 'RandomBot');
  const token = argValue(argv, '--token') || process.env.BOT_TOKEN;
  const players = Number(argValue(argv, '--players') || 3) as 3 | 4 | 6;
  const thinkDelayMs = Number(argValue(argv, '--delay') || 40);

  if (!smoke && !roomId) {
    throw new Error('Pass --room <id> or --smoke');
  }

  return {
    host,
    roomId,
    userId,
    userName,
    token,
    strategy,
    smoke,
    players: players === 4 || players === 6 ? players : 3,
    thinkDelayMs,
  };
}
