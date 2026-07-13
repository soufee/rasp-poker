import type { Session } from '../types/game';
import { createRoomSocketUrl, parseIncomingEvent, serializeOutgoingEvent } from './roomSocket';

const session: Session = {
  token: 'abc',
  user: {
    displayName: 'Север',
    id: 'user-1',
    verified: true,
  },
};

describe('room socket contract', () => {
  test('builds secure room url with identity', () => {
    const url = createRoomSocketUrl('private room', session, {
      host: 'cards.example',
      protocol: 'https:',
    });

    expect(url).toBe(
      'wss://cards.example/ws/room/private%20room?userId=user-1&userName=%D0%A1%D0%B5%D0%B2%D0%B5%D1%80&token=abc',
    );
  });

  test('parses supported events', () => {
    expect(
      parseIncomingEvent(JSON.stringify({ message: 'Ставка запрещена', type: 'ACTION_REJECTED' })),
    ).toEqual({
      message: 'Ставка запрещена',
      type: 'ACTION_REJECTED',
    });
    expect(parseIncomingEvent('not json')).toBeNull();
  });

  test('serializes outgoing event without changing payload', () => {
    expect(
      serializeOutgoingEvent({
        cardIndex: 2,
        jokerAction: { suit: 'HEARTS', type: 'DEMAND_SUIT' },
        type: 'PLAY_CARD',
      }),
    ).toBe(
      '{"cardIndex":2,"jokerAction":{"suit":"HEARTS","type":"DEMAND_SUIT"},"type":"PLAY_CARD"}',
    );
  });
});
