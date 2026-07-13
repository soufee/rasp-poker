# Grok — бот для «Расписного покера»

Сетевой бот по гайду [issue #22](https://github.com/soufee/rasp-poker/issues/22).  
Подключается по **WebSocket** как обычный клиент, решения принимает стратегия **Grok** (эвристики + contract play).

## Возможности Grok

| Фаза | Поведение |
|------|-----------|
| **BIDDING** | Оценка руки (козыри, тузы, джокер), чуть underbid vs штраф −10×; dark — prior H/N |
| **PLAYING** | Режимы: need tricks / avoid / GOLD take-all / MISER dump; дешёвый виннер vs сброс |
| **Joker** | TAKE / DROP / DEMAND_SUIT по давлению контракта и типу раунда |
| **CONTROL** | Выбор типа из `playedRoundTypes` (variance vs stabilize), dealer smart |

Укладывается в серверный таймер (think delay ~40 ms, без MCTS).

## Запуск

Терминал 1 — сервер:

```bash
cd ..   # корень rasp-poker
npm run dev:server
```

Терминал 2 — бот:

```bash
cd bot
npm install
# Войти в существующую комнату:
npm start -- --room <ROOM_ID> --userId bot-grok --userName Grok

# Smoke: создать комнату, Grok-хост + random-филлеры, short plan
BOT_SHORT_PLAN=1 npm run smoke
```

### CLI

| Флаг | Описание |
|------|----------|
| `--room <id>` | Комната |
| `--userId` / `--userName` | Identity (guest query, reconnect-stable) |
| `--host` | default `http://127.0.0.1:3000` |
| `--strategy grok\|random` | default `grok` |
| `--smoke` | create room + multi-bot match |
| `--players 3\|4\|6` | для smoke |
| `--token` | JWT (опционально) |
| `--delay` | ms перед отправкой хода |

## Структура (как в гайде)

```
bot/src/
  index.ts
  config.ts
  protocol/types.ts
  transport/RoomConnection.ts
  core/BotClient.ts
  core/stateSelectors.ts
  strategy/Strategy.ts
  strategy/RandomStrategy.ts
  strategy/GrokStrategy.ts   ← умный бот
```

Своя стратегия: реализуй `Strategy` и передай в `BotClient`.

## Тесты

```bash
npm test
```

## Протокол

См. issue #22: `STATE_UPDATE` → одно действие из `allowedBids` / `validCardIndices`, обработка `ACTION_REJECTED`, reconnect с тем же `userId`.
