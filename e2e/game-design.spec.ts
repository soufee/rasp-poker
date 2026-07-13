import { expect, test, type Page } from '@playwright/test';
import WebSocket from 'ws';

interface CardPayload {
  isJoker?: boolean;
  rank?: string;
  suit?: string;
}

interface PlayerPayload {
  id: string;
  cards: Array<CardPayload | null>;
}

interface GamePayload {
  allowedBids?: number[] | null;
  controlGameChooserId?: string | null;
  currentPlayerIndex: number;
  playedRoundTypes?: string[];
  players: PlayerPayload[];
  state: string;
  tableCards?: unknown[];
  validCardIndices?: number[] | null;
}

function connectBot(roomId: string, botId: string, botName: string): Promise<WebSocket> {
  const query = new URLSearchParams({ userId: botId, userName: botName });
  const socket = new WebSocket(
    `ws://127.0.0.1:3000/ws/room/${encodeURIComponent(roomId)}?${query.toString()}`,
  );

  socket.on('message', (data) => {
    const message = JSON.parse(data.toString()) as {
      type?: string;
      payload?: GamePayload;
    };
    if (message.type !== 'STATE_UPDATE' || !message.payload) {
      return;
    }

    const game = message.payload;
    const currentPlayer = game.players[game.currentPlayerIndex];
    if (currentPlayer?.id !== botId) {
      return;
    }
    if (game.state === 'BIDDING' && game.allowedBids?.length) {
      socket.send(JSON.stringify({ bid: game.allowedBids[0], type: 'PLACE_BID' }));
      return;
    }
    if (game.state === 'PLAYING_TRICKS' && game.validCardIndices?.length) {
      const cardIndex = game.validCardIndices[0];
      const card = currentPlayer.cards[cardIndex];
      socket.send(
        JSON.stringify({
          cardIndex,
          jokerAction: card?.isJoker ? { type: 'TAKE' } : undefined,
          type: 'PLAY_CARD',
        }),
      );
      return;
    }
    if (game.state === 'CONTROL_GAME_SETUP' && game.controlGameChooserId === botId) {
      socket.send(
        JSON.stringify({
          dealerIndex: 0,
          roundType: game.playedRoundTypes?.[0] ?? 'STANDARD',
          type: 'SETUP_CONTROL',
        }),
      );
    }
  });

  return new Promise((resolve, reject) => {
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

async function enterAsGuest(page: Page, userId: string, userName: string): Promise<void> {
  await page.addInitScript(
    ({ id, name }) => {
      localStorage.setItem(
        'rasp-poker.session',
        JSON.stringify({
          user: {
            displayName: name,
            id,
            isGuest: true,
            verified: true,
          },
        }),
      );
    },
    { id: userId, name: userName },
  );
}

test('renders a playable responsive room and game table', async ({ page }, testInfo) => {
  const ownerId = `visual-owner-${testInfo.project.name}-${Date.now()}`;
  const ownerName = testInfo.project.name === 'mobile' ? 'Мобильный игрок' : 'Хозяин стола';
  await enterAsGuest(page, ownerId, ownerName);
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Выберите свой стол' })).toBeVisible();
  await page.screenshot({
    fullPage: true,
    path: `test-results/${testInfo.project.name}-lobby.png`,
  });

  await page
    .getByRole('button', { name: /Создать стол/ })
    .first()
    .click();
  await page.locator('.segmented-control button').last().click();
  await page.getByRole('checkbox', { name: /Лесенка/ }).uncheck({ force: true });
  await page.getByRole('checkbox', { name: /Мизер/ }).uncheck({ force: true });
  await page.locator('.create-room-form button[type="submit"]').click();
  await expect(page).toHaveURL(/[?&]room=/);

  const roomId = new URL(page.url()).searchParams.get('room');
  expect(roomId).not.toBeNull();
  await expect(page.getByRole('heading', { name: 'Вечерняя партия' })).toBeVisible();

  const bots = await Promise.all([
    connectBot(roomId as string, `${ownerId}-bot-1`, 'Север'),
    connectBot(roomId as string, `${ownerId}-bot-2`, 'Восток'),
    connectBot(roomId as string, `${ownerId}-bot-3`, 'Юго-восток'),
    connectBot(roomId as string, `${ownerId}-bot-4`, 'Юго-запад'),
    connectBot(roomId as string, `${ownerId}-bot-5`, 'Запад'),
  ]);

  try {
    await expect(page.getByText('6 / 6').first()).toBeVisible();
    await page.screenshot({
      fullPage: true,
      path: `test-results/${testInfo.project.name}-waiting.png`,
    });

    await page.getByRole('button', { name: 'Начать игру' }).click();
    await expect(page.locator('.bid-options button').first()).toBeVisible();
    await page.locator('.bid-options button').first().click();
    await expect(page.locator('.table-play')).toHaveCount(5);
    await expect(page.locator('.turn-prompt.is-active')).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
      )
      .toBe(true);

    await page.screenshot({
      fullPage: true,
      path: `test-results/${testInfo.project.name}-game.png`,
    });

    await page.locator('.player-hand .playing-card.is-allowed').first().click();
    const jokerDialog = page.getByRole('dialog', { name: 'Разыграть джокера' });
    if (await jokerDialog.isVisible()) {
      await page.getByRole('button', { name: 'Сыграть джокера' }).click();
    }
  } finally {
    for (const bot of bots) {
      bot.close();
    }
  }
});
