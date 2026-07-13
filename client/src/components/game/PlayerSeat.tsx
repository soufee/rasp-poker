import type { CSSProperties } from 'react';
import type { PlayerState } from '../../types/game';
import { formatScore } from '../../utils/game';
import { Avatar } from '../ui';

interface PlayerSeatProps {
  player: PlayerState;
  position: string;
  isCurrent: boolean;
  isDealer: boolean;
  isViewer: boolean;
}

export function PlayerSeat({ isCurrent, isDealer, isViewer, player, position }: PlayerSeatProps) {
  const cardCount = player.cards.length;

  return (
    <article
      className={[
        'player-seat',
        `player-seat--${position}`,
        isCurrent ? 'is-current' : '',
        isViewer ? 'is-viewer' : '',
        player.connected === false ? 'is-offline' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {!isViewer && cardCount > 0 ? (
        <div className="player-seat__cards" aria-label={`${cardCount} карт`}>
          {Array.from({ length: Math.min(cardCount, 5) }, (_, index) => (
            <img
              alt=""
              aria-hidden="true"
              key={index}
              src="/assets/card-back.svg"
              style={{ '--back-index': index } as CSSProperties}
            />
          ))}
          <span>{cardCount}</span>
        </div>
      ) : null}

      <div className="player-seat__identity">
        <div className="player-seat__avatar-wrap">
          <Avatar name={player.name} src={player.avatarUrl} />
          {isDealer ? <span className="dealer-chip">Д</span> : null}
          {isCurrent ? <span className="turn-ring" /> : null}
        </div>
        <div className="player-seat__name">
          <strong>{isViewer ? 'Вы' : player.name}</strong>
          <small>{formatScore(player.score)} очков</small>
        </div>
      </div>

      <div className="player-seat__stats">
        <span>
          <small>Заказ</small>
          <b>{player.currentBid ?? '—'}</b>
        </span>
        <span>
          <small>Взято</small>
          <b>{player.tricksTaken}</b>
        </span>
      </div>

      {isCurrent ? <span className="player-seat__turn-label">Ход</span> : null}
      {player.connected === false ? <span className="player-seat__offline">Не в сети</span> : null}
    </article>
  );
}
