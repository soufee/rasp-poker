# rasp-poker — «Расписной покер»

Сетевой authoritative server (Node.js + TypeScript + Fastify + Prisma + Redis).

## Локальная разработка (эта машина)

Уже должны крутиться:

| Сервис   | Контейнер           | Порт | Доступ (типично)        |
|----------|---------------------|------|-------------------------|
| Postgres | `postgres_container`| 5432 | `postgres` / `postgres` |
| Redis    | `lims-redis-local`  | 6379 | password в `REDIS_URL`  |

**Не** поднимайте `docker-compose.yml` локально — он для удалённого/prod сервера.

```bash
cp .env.example .env
# Отредактируйте .env: DATABASE_URL и REDIS_URL под ваши локальные инстансы
# (готовый пример для этой машины уже в .env, файл в .gitignore)

npm install
npm run dev
```

При каждом старте:

1. `prisma migrate deploy` — накатывает недостающие миграции
2. проверка Postgres + Redis
3. seed суперпользователя **`dev`** (`dev@local`)

### Автологин (только `APP_ENV=local`)

```bash
curl -s http://localhost:3000/api/auth/session | jq
curl -s http://localhost:3000/api/auth/me -H "Authorization: Bearer <token>"
# без токена /me тоже подставит dev (local middleware fallback)
curl -s http://localhost:3000/ready | jq
```

Авторизация (register/login/verify) **обязательна только на production**.

## Почта (SMTP / Yandex)

Письма: подтверждение email, сброс пароля, прочие уведомления (`src/auth/email.ts`, `src/mail/`).

Соответствие Spring → env:

| Spring | Env |
|--------|-----|
| `spring.mail.host` | `SMTP_HOST=smtp.yandex.ru` |
| `spring.mail.port` | `SMTP_PORT=465` |
| `spring.mail.protocol=smtps` | `SMTP_SECURE=true` |
| `spring.mail.username` | `SMTP_USER` |
| `spring.mail.password` | `SMTP_PASSWORD` (**plain**, не `ENC(...)`) |
| `mail.debug` | `MAIL_DEBUG=true` |

Пароль из Spring `ENC(...)` — это Jasypt-шифрование. В Node его нужно **расшифровать** своим `jasypt.encryptor.password` либо создать [пароль приложения Яндекс](https://id.yandex.ru/security/app-passwords) и положить **только** в `.env` (не в git).

- SMTP не задан → письма пишутся в консоль сервера (удобно local).
- `APP_ENV=production` → SMTP обязателен, при старте `verify()`.

## Production / удалённый сервер

На сервере задайте переменные окружения (или `.env` **вне git**):

```bash
export APP_ENV=production
export JWT_SECRET='...long-random...'
export POSTGRES_USER='...'
export POSTGRES_PASSWORD='...'
export POSTGRES_DB=rasp_poker
export REDIS_PASSWORD='...'
export DATABASE_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@localhost:5432/${POSTGRES_DB}?schema=public"
export REDIS_URL="redis://:${REDIS_PASSWORD}@localhost:6379"
```

Инфраструктура:

```bash
docker compose up -d
npm install
npm start   # migrate deploy на каждом старте
```

Пароли **никогда** не коммитятся: только `.env.example` с плейсхолдерами.

## Миграции БД

| Команда | Когда |
|---------|--------|
| `npm run db:migrate:dev` | разработка: создать новую миграцию после правки `schema.prisma` |
| `npm run db:migrate` / старт приложения | deploy: применить pending миграции |
| `npm run db:generate` | пересобрать Prisma Client |
| `npm run db:studio` | GUI |

Миграции лежат в `prisma/migrations/` и **должны быть в git**.

## Скрипты

- `npm run dev` — одновременно Fastify (`:3000`) и Vite (`:5173`) с proxy для REST/WebSocket
- `npm run dev:server` / `npm run dev:client` — раздельный watch-режим
- `npm run build` — production-сборка сервера и React-клиента
- `npm start` — обычный запуск
- `npm test` — backend Jest и frontend Vitest
- `npm run test:e2e` — browser smoke-test desktop/mobile при запущенном сервере
- `npm run db:*` — Prisma
- `npm run smoke:bots` — 3 бота, short match до `MATCH_FINISHED` (без UI)

После `npm run build` Fastify раздаёт SPA и ассеты из `client/dist`.

## Smoke (MVP gate)

```bash
# Postgres + Redis уже на localhost (см. выше)
npm install
npm run smoke:bots   # exit 0 если партия из 3 ботов завершилась
npm run dev          # server :3000 + Vite client :5173
```

Клиент общается с сервером только через REST + WebSocket intent-actions (без доверия к клиентской логике карт).

