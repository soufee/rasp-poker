import type { CardModel } from '../../types/game';
import { isJoker, suitNames, suitSymbols } from '../../utils/game';

interface PlayingCardProps {
  card: CardModel | null;
  faceDown?: boolean;
  interactive?: boolean;
  disabled?: boolean;
  selected?: boolean;
  className?: string;
  onClick?: () => void;
}

export function PlayingCard({
  card,
  className = '',
  disabled = false,
  faceDown = false,
  interactive = false,
  onClick,
  selected = false,
}: PlayingCardProps) {
  const hidden = faceDown || !card;
  const joker = card ? isJoker(card) : false;
  const red = card?.suit === 'HEARTS' || card?.suit === 'DIAMONDS';
  const classes = [
    'playing-card',
    hidden ? 'playing-card--back' : '',
    red ? 'playing-card--red' : '',
    joker ? 'playing-card--joker' : '',
    selected ? 'is-selected' : '',
    interactive ? 'playing-card--interactive' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  const content = hidden ? (
    <img alt="Рубашка карты" draggable={false} src="/assets/card-back.svg" />
  ) : (
    <>
      <span className="playing-card__corner">
        <b>{card.rank}</b>
        <i>{suitSymbols[card.suit]}</i>
      </span>
      <span aria-hidden="true" className="playing-card__suit">
        {suitSymbols[card.suit]}
      </span>
      {joker ? <span className="playing-card__joker-label">Джокер</span> : null}
      <span className="playing-card__corner playing-card__corner--bottom">
        <b>{card.rank}</b>
        <i>{suitSymbols[card.suit]}</i>
      </span>
    </>
  );
  const label = hidden
    ? 'Закрытая карта'
    : `${joker ? 'Джокер, ' : ''}${card.rank}, ${suitNames[card.suit]}`;

  if (interactive) {
    return (
      <button
        aria-label={label}
        className={classes}
        disabled={disabled}
        onClick={onClick}
        type="button"
      >
        {content}
      </button>
    );
  }

  return (
    <div aria-label={label} className={classes} role="img">
      {content}
    </div>
  );
}
