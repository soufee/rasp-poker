export interface BotRuntimeConfig {
  host: string;
  roomId: string;
  userId: string;
  userName: string;
  token?: string;
  strategy: 'grok' | 'random';
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
  const userId = argValue(argv, '--userId') || process.env.BOT_USER_ID || 'bot-grok';
  const userName = argValue(argv, '--userName') || process.env.BOT_USER_NAME || 'Grok';
  const token = argValue(argv, '--token') || process.env.BOT_TOKEN;
  const strategy = (argValue(argv, '--strategy') || 'grok') as 'grok' | 'random';
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
    strategy: strategy === 'random' ? 'random' : 'grok',
    smoke,
    players: players === 4 || players === 6 ? players : 3,
    thinkDelayMs,
  };
}
