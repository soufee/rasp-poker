import { randomUUID } from 'node:crypto';
import { roomManager } from '../RoomManager';
import { BotSeat } from './BotSeat';
import {
  createBotStrategy,
  isKnownBot,
  listBotMeta,
  pickRandomBotIds,
  type BotMeta,
} from './loader';

export const RANDOM_BOT_TOKEN = 'random';

export interface SeatedBot {
  strategyId: string;
  userId: string;
  name: string;
}

/**
 * Unified, in-process launcher for every bot in the catalogue. Owns the bot
 * seats for each room and disposes them once the match is over.
 */
export class BotManager {
  private readonly seatsByRoom = new Map<string, BotSeat[]>();

  public constructor() {
    roomManager.onMatchFinished((roomId) => {
      this.removeRoom(roomId);
    });
  }

  public async listAvailable(): Promise<BotMeta[]> {
    return listBotMeta();
  }

  /**
   * Resolve a requested bot list (explicit ids and/or `random` tokens) into
   * concrete strategy ids, capped to the number of free seats.
   */
  public async resolveBotIds(requested: string[], freeSeats: number): Promise<string[]> {
    const capped = requested.slice(0, Math.max(0, freeSeats));
    const explicit: string[] = [];
    let randomCount = 0;
    for (const entry of capped) {
      if (entry === RANDOM_BOT_TOKEN) {
        randomCount += 1;
      } else if (await isKnownBot(entry)) {
        explicit.push(entry);
      }
    }
    if (randomCount === 0) {
      return explicit;
    }
    const randoms = await pickRandomBotIds(randomCount, explicit);
    return [...explicit, ...randoms];
  }

  /** Seat the given bot strategies into a waiting room. */
  public async addBots(roomId: string, strategyIds: string[]): Promise<SeatedBot[]> {
    const meta = await listBotMeta();
    const labelById = new Map(meta.map((bot) => [bot.id, bot.label]));
    const usedNames = new Set<string>();
    const seated: SeatedBot[] = [];

    for (const strategyId of strategyIds) {
      let strategy;
      try {
        strategy = await createBotStrategy(strategyId);
      } catch (error) {
        console.error(`[bots] Failed to create strategy "${strategyId}":`, error);
        continue;
      }

      const baseLabel = labelById.get(strategyId) ?? strategyId;
      const name = this.uniqueName(baseLabel, usedNames);
      usedNames.add(name);
      const userId = `bot-${strategyId}-${randomUUID().slice(0, 8)}`;

      const bot = new BotSeat(roomId, userId, name, strategy);
      if (!bot.seat()) {
        continue;
      }
      this.trackSeat(roomId, bot);
      seated.push({ strategyId, userId, name });
    }

    return seated;
  }

  public removeRoom(roomId: string): void {
    const seats = this.seatsByRoom.get(roomId);
    if (!seats) {
      return;
    }
    for (const seat of seats) {
      seat.dispose();
    }
    this.seatsByRoom.delete(roomId);
  }

  private trackSeat(roomId: string, seat: BotSeat): void {
    const seats = this.seatsByRoom.get(roomId);
    if (seats) {
      seats.push(seat);
    } else {
      this.seatsByRoom.set(roomId, [seat]);
    }
  }

  private uniqueName(base: string, used: Set<string>): string {
    if (!used.has(base)) {
      return base;
    }
    let index = 2;
    let candidate = `${base} ${index}`;
    while (used.has(candidate)) {
      index += 1;
      candidate = `${base} ${index}`;
    }
    return candidate;
  }
}

export const botManager = new BotManager();
