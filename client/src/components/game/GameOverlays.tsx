import { useMemo, useState } from 'react';
import type { GameSnapshot, JokerAction, RoundType, Suit } from '../../types/game';
import { formatScore, getWinner, roundNames, suitNames, suitSymbols } from '../../utils/game';
import { Avatar, Button, Modal } from '../ui';

const suits: Suit[] = ['SPADES', 'HEARTS', 'DIAMONDS', 'CLUBS'];

interface JokerModalProps {
  isLeading: boolean;
  onCancel: () => void;
  onConfirm: (action: JokerAction) => void;
}

export function JokerModal({ isLeading, onCancel, onConfirm }: JokerModalProps) {
  const [actionType, setActionType] = useState<JokerAction['type']>('TAKE');
  const [suit, setSuit] = useState<Suit | null>(null);
  const needsSuit = actionType === 'DEMAND_SUIT' || (actionType === 'DROP' && isLeading);

  const confirm = () => {
    if (actionType === 'TAKE') {
      onConfirm({ type: 'TAKE' });
      return;
    }

    if (actionType === 'DEMAND_SUIT' && suit) {
      onConfirm({ suit, type: 'DEMAND_SUIT' });
      return;
    }

    if (actionType === 'DROP') {
      if (isLeading && suit) {
        onConfirm({ suit, type: 'DROP' });
        return;
      }

      if (!isLeading) {
        onConfirm({ type: 'DROP' });
      }
    }
  };

  return (
    <Modal
      onClose={onCancel}
      subtitle="Семёрка пик требует особого действия"
      title="Разыграть джокера"
    >
      <div className="joker-preview">
        <span>7</span>
        <b>♠</b>
        <small>Джокер</small>
      </div>
      <div className="joker-actions">
        <button
          aria-pressed={actionType === 'TAKE'}
          className={actionType === 'TAKE' ? 'is-active' : ''}
          onClick={() => {
            setActionType('TAKE');
            setSuit(null);
          }}
          type="button"
        >
          <span>↑</span>
          <strong>Взять</strong>
          <small>Джокер забирает взятку</small>
        </button>
        {isLeading ? (
          <button
            aria-pressed={actionType === 'DEMAND_SUIT'}
            className={actionType === 'DEMAND_SUIT' ? 'is-active' : ''}
            onClick={() => setActionType('DEMAND_SUIT')}
            type="button"
          >
            <span>◆</span>
            <strong>Заказать масть</strong>
            <small>Соперники должны продолжить мастью</small>
          </button>
        ) : null}
        <button
          aria-pressed={actionType === 'DROP'}
          className={actionType === 'DROP' ? 'is-active' : ''}
          onClick={() => {
            setActionType('DROP');

            if (!isLeading) {
              setSuit(null);
            }
          }}
          type="button"
        >
          <span>↓</span>
          <strong>Сбросить</strong>
          <small>Джокер становится младшей картой</small>
        </button>
      </div>
      {needsSuit ? (
        <fieldset className="suit-picker">
          <legend>Выберите масть</legend>
          <div>
            {suits.map((item) => (
              <button
                aria-label={suitNames[item]}
                aria-pressed={suit === item}
                className={[
                  suit === item ? 'is-active' : '',
                  item === 'HEARTS' || item === 'DIAMONDS' ? 'is-red' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                key={item}
                onClick={() => setSuit(item)}
                type="button"
              >
                {suitSymbols[item]}
              </button>
            ))}
          </div>
        </fieldset>
      ) : null}
      <div className="modal-actions">
        <Button onClick={onCancel} variant="ghost">
          Отмена
        </Button>
        <Button disabled={needsSuit && !suit} onClick={confirm}>
          Сыграть джокера
        </Button>
      </div>
    </Modal>
  );
}

interface ScoreSheetProps {
  game: GameSnapshot;
  onClose: () => void;
}

export function ScoreSheet({ game, onClose }: ScoreSheetProps) {
  const history = game.scoreHistory ?? [];

  return (
    <Modal
      onClose={onClose}
      size="large"
      subtitle={`Раунд ${game.currentRoundIndex + 1} из ${game.plan.length || '—'}`}
      title="Протокол партии"
    >
      <div className="score-sheet-wrap">
        <table className="score-sheet">
          <thead>
            <tr>
              <th>Раунд</th>
              {game.players.map((player) => (
                <th key={player.id}>{player.name}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {history.map((round) => (
              <tr key={round.roundNumber}>
                <th>
                  <span>{round.roundNumber}</span>
                  <small>{roundNames[round.roundType]}</small>
                </th>
                {game.players.map((player) => (
                  <td key={player.id}>
                    {formatScore(round.scores[player.id] ?? 0)}
                    {round.bids ? (
                      <small>
                        {round.tricks?.[player.id] ?? 0} / {round.bids[player.id] ?? '—'}
                      </small>
                    ) : null}
                  </td>
                ))}
              </tr>
            ))}
            {history.length === 0 ? (
              <tr>
                <th>
                  <span>{game.currentRoundIndex + 1}</span>
                  <small>{roundNames[game.currentRoundType]}</small>
                </th>
                {game.players.map((player) => (
                  <td key={player.id}>
                    {formatScore(player.score)}
                    <small>
                      {player.tricksTaken} / {player.currentBid ?? '—'}
                    </small>
                  </td>
                ))}
              </tr>
            ) : null}
          </tbody>
          <tfoot>
            <tr>
              <th>Итого</th>
              {game.players.map((player) => (
                <td key={player.id}>{formatScore(player.score)}</td>
              ))}
            </tr>
          </tfoot>
        </table>
      </div>
      <div className="score-legend">
        <span>
          <i className="is-positive" /> Выполненный заказ
        </span>
        <span>
          <i className="is-negative" /> Штраф
        </span>
        <span>Под числом: взято / заказано</span>
      </div>
    </Modal>
  );
}

interface ControlSetupProps {
  game: GameSnapshot;
  viewerId: string;
  onSubmit: (roundType: RoundType, dealerIndex: number) => void;
}

export function ControlSetup({ game, onSubmit, viewerId }: ControlSetupProps) {
  const types = useMemo(
    () => Array.from(new Set(game.plan.map((round) => round.type))),
    [game.plan],
  );
  const availableTypes = types.length > 0 ? types : [game.currentRoundType];
  const [roundType, setRoundType] = useState<RoundType>(availableTypes[0] ?? game.currentRoundType);
  const [dealerIndex, setDealerIndex] = useState(game.dealerIndex);
  const canChoose = game.controlGameChooserId === viewerId;
  const chooser = game.players.find((player) => player.id === game.controlGameChooserId);

  return (
    <Modal subtitle="Дополнительная партия определит итоговый порядок" title="Контрольная игра">
      {canChoose ? (
        <div className="control-setup">
          <p>У вас наименьший счёт — выберите формат контрольной игры и раздающего.</p>
          <fieldset className="choice-grid">
            <legend>Тип раунда</legend>
            <div>
              {availableTypes.map((type) => (
                <button
                  aria-pressed={roundType === type}
                  className={roundType === type ? 'is-active' : ''}
                  key={type}
                  onClick={() => setRoundType(type)}
                  type="button"
                >
                  {roundNames[type]}
                </button>
              ))}
            </div>
          </fieldset>
          <fieldset className="dealer-picker">
            <legend>Раздающий</legend>
            <div>
              {game.players.map((player, index) => (
                <button
                  aria-pressed={dealerIndex === index}
                  className={dealerIndex === index ? 'is-active' : ''}
                  key={player.id}
                  onClick={() => setDealerIndex(index)}
                  type="button"
                >
                  <Avatar name={player.name} size="small" />
                  <span>{player.id === viewerId ? 'Вы' : player.name}</span>
                </button>
              ))}
            </div>
          </fieldset>
          <Button onClick={() => onSubmit(roundType, dealerIndex)} wide>
            Начать контрольную игру
          </Button>
        </div>
      ) : (
        <div className="control-waiting">
          <SpinnerMark />
          <h3>Выбирает {chooser?.name ?? 'игрок'}</h3>
          <p>Стол продолжит игру после подтверждения настроек.</p>
        </div>
      )}
    </Modal>
  );
}

function SpinnerMark() {
  return (
    <span className="control-waiting__mark" aria-hidden="true">
      ♠
    </span>
  );
}

interface ResultModalProps {
  game: GameSnapshot;
  viewerId: string;
  onLeave: () => void;
}

export function ResultModal({ game, onLeave, viewerId }: ResultModalProps) {
  const ranking = [...game.players].sort((left, right) => right.score - left.score);
  const winner = getWinner(game.players);

  return (
    <Modal
      size="large"
      subtitle={`${game.plan.length} раундов · ${game.controlGamesPlayed} контрольных`}
      title="Партия завершена"
    >
      <div className="result-hero">
        <span className="result-hero__crown" aria-hidden="true">
          ♛
        </span>
        <Avatar name={winner?.name ?? 'Победитель'} size="large" />
        <span className="eyebrow">Победитель</span>
        <h3>{winner?.id === viewerId ? 'Вы победили!' : winner?.name}</h3>
        <strong>{winner?.score ?? 0} очков</strong>
      </div>
      <ol className="result-ranking">
        {ranking.map((player, index) => (
          <li className={player.id === viewerId ? 'is-viewer' : ''} key={player.id}>
            <span>{index + 1}</span>
            <Avatar name={player.name} size="small" />
            <strong>{player.id === viewerId ? 'Вы' : player.name}</strong>
            <b>{player.score}</b>
          </li>
        ))}
      </ol>
      <div className="modal-actions modal-actions--center">
        <Button onClick={onLeave}>Вернуться в лобби</Button>
      </div>
    </Modal>
  );
}
