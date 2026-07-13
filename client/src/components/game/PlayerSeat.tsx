import type { CSSProperties } from 'react';
import type { GamePhase, PlayerState } from '../../types/game';
import { formatScore } from '../../utils/game';
import { Avatar } from '../ui';

interface PlayerSeatProps {
  player: PlayerState;
  position: string;
  isCurrent: boolean;
  isDealer: boolean;
  isViewer: boolean;
  phase: GamePhase;
  scoreDelta?: number;
}

function getBidClass(bid: number | null, taken: number): string {
  if (bid === null) {
    return '';
  }
  if (taken > bid) {
    return 'is-over';
  }
  if (taken === bid) {
    return 'is-exact';
  }
  return 'is-under';
}

export function PlayerSeat({
  isCurrent,
  isDealer,
  isViewer,
  phase,
  player,
  position,
  scoreDelta,
}: PlayerSeatProps) {
  const cardCount = player.cards.length;
  const showProgress =
    phase === 'BIDDING'
    || phase === 'PLAYING_TRICKS'
    || phase === 'SCORING';
  const bidClass = getBidClass(player.currentBid, player.tricksTaken);
  const hasDelta = typeof scoreDelta === 'number' && scoreDelta !== 0;
  const isSubstituted = player.substituted === true;

  return (
    <article
      className={[
        'player-seat',
        `player-seat--${position}`,
        isCurrent ? 'is-current' : '',
        isViewer ? 'is-viewer' : '',
        player.connected === false ? 'is-offline' : '',
        isSubstituted ? 'is-substituted' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {hasDelta ? (
        <span className={`seat-delta ${scoreDelta! > 0 ? 'is-plus' : 'is-minus'}`}>
          {scoreDelta! > 0 ? `+${scoreDelta}` : scoreDelta}
        </span>
      ) : null}

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

      {showProgress ? (
        <div className="player-seat__progress">
          <span className={`seat-bidcount ${bidClass}`}>
            <b>{player.tricksTaken}</b>
            <i>/</i>
            <b>{player.currentBid ?? '—'}</b>
          </span>
          <small>взято / заказ</small>
        </div>
      ) : null}

      {isCurrent ? <span className="player-seat__turn-label">Ход</span> : null}
      {isSubstituted ? (
        <span className="player-seat__substitute">За него играет «Новичок»</span>
      ) : null}
      {!isSubstituted && player.connected === false ? (
        <span className="player-seat__offline">Не в сети</span>
      ) : null}
    </article>
  );
}
