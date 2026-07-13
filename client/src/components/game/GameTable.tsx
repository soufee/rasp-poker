import { type CSSProperties, useEffect, useMemo, useState } from 'react';
import type {
  ChatMessage,
  ConnectionStatus,
  GameSnapshot,
  OutgoingRoomEvent,
  Preferences,
  RoomInfo,
  Session,
} from '../../types/game';
import {
  getExcludedDealerBid,
  getSeatPosition,
  isJoker,
  rotatePlayersForViewer,
  roundNames,
  suitNames,
  suitSymbols,
} from '../../utils/game';
import { ReconnectBanner, DealingOverlay } from '../status/StatusViews';
import { Button, ConnectionBadge, Logo, Modal } from '../ui';
import { ChatPanel } from './ChatPanel';
import { ControlSetup, JokerModal, ResultModal, ScoreSheet } from './GameOverlays';
import { PlayerSeat } from './PlayerSeat';
import { PlayingCard } from './PlayingCard';

interface GameTableProps {
  roomId: string;
  roomInfo: RoomInfo | null;
  game: GameSnapshot;
  session: Session;
  connectionStatus: ConnectionStatus;
  messages: ChatMessage[];
  preferences: Preferences;
  send: (event: OutgoingRoomEvent) => boolean;
  onLeave: () => void;
  onReconnect: () => void;
}

export function GameTable({
  connectionStatus,
  game,
  messages,
  onLeave,
  onReconnect,
  preferences,
  roomId,
  roomInfo,
  send,
  session,
}: GameTableProps) {
  const [isChatOpen, setIsChatOpen] = useState(preferences.chatOpen);
  const [isScoreOpen, setIsScoreOpen] = useState(false);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isLeaveConfirmOpen, setIsLeaveConfirmOpen] = useState(false);
  const [jokerCardIndex, setJokerCardIndex] = useState<number | null>(null);
  const viewer = game.players.find((player) => player.id === session.user.id);
  const currentPlayer = game.players[game.currentPlayerIndex];
  const viewerTurn = currentPlayer?.id === session.user.id;
  const visualPlayers = useMemo(
    () => rotatePlayersForViewer(game.players, session.user.id),
    [game.players, session.user.id],
  );
  const excludedBid = getExcludedDealerBid(game);
  const roundNumber = game.currentRoundIndex + 1;
  const totalRounds = game.plan.length;
  const progress =
    totalRounds > 0 ? Math.min(100, Math.round((roundNumber / totalRounds) * 100)) : 0;

  useEffect(() => {
    setIsChatOpen(preferences.chatOpen);
  }, [preferences.chatOpen]);

  const playCard = (cardIndex: number) => {
    const card = viewer?.cards[cardIndex];

    if (!card) {
      return;
    }

    if (isJoker(card)) {
      setJokerCardIndex(cardIndex);
      return;
    }

    send({ cardIndex, type: 'PLAY_CARD' });
  };

  const isCardAllowed = (cardIndex: number): boolean => {
    if (!viewerTurn || game.state !== 'PLAYING_TRICKS') {
      return false;
    }

    if (game.validCardIndices) {
      return game.validCardIndices.includes(cardIndex);
    }

    return true;
  };

  return (
    <main className={`game-shell ${isChatOpen ? 'game-shell--with-chat' : ''}`}>
      <header className="game-header">
        <div className="game-header__brand">
          <Logo compact />
          <div>
            <strong>{roomInfo?.name ?? 'Игровой стол'}</strong>
            <small>#{roomInfo?.inviteCode ?? roomId}</small>
          </div>
        </div>

        <div className="round-hud">
          <div className="round-hud__name">
            <span>{roundNames[game.currentRoundType]}</span>
            <strong>
              Раунд {roundNumber}
              {totalRounds > 0 ? ` / ${totalRounds}` : ''}
            </strong>
          </div>
          <div className="round-progress" aria-label={`Прогресс ${progress}%`}>
            <span style={{ width: `${progress}%` }} />
          </div>
          <div className="round-hud__cards">
            <span>Карт</span>
            <strong>{game.currentRoundCards}</strong>
          </div>
        </div>

        <div className="game-header__actions">
          <ConnectionBadge status={connectionStatus} />
          <button
            className="game-header__control"
            onClick={() => setIsScoreOpen(true)}
            type="button"
          >
            <span aria-hidden="true">▥</span>
            <span>Счёт</span>
          </button>
          <button
            aria-pressed={isChatOpen}
            className={`game-header__control ${isChatOpen ? 'is-active' : ''}`}
            onClick={() => setIsChatOpen((current) => !current)}
            type="button"
          >
            <span aria-hidden="true">◌</span>
            <span>Чат</span>
            {messages.length > 0 ? <b>{Math.min(messages.length, 99)}</b> : null}
          </button>
          <div className="game-menu-wrap">
            <button
              aria-expanded={isMenuOpen}
              aria-label="Меню игры"
              className="icon-button"
              onClick={() => setIsMenuOpen((current) => !current)}
              type="button"
            >
              •••
            </button>
            {isMenuOpen ? (
              <div className="game-menu">
                <button
                  onClick={() => {
                    setIsScoreOpen(true);
                    setIsMenuOpen(false);
                  }}
                  type="button"
                >
                  Открыть протокол
                </button>
                <button
                  onClick={() => {
                    setIsChatOpen(true);
                    setIsMenuOpen(false);
                  }}
                  type="button"
                >
                  Открыть чат
                </button>
                <button
                  className="is-danger"
                  onClick={() => {
                    setIsLeaveConfirmOpen(true);
                    setIsMenuOpen(false);
                  }}
                  type="button"
                >
                  Покинуть партию
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </header>

      <section className="table-stage">
        <div className="table-rail">
          <div className="table-felt">
            <div className="table-felt__pattern" />
            <div className="trump-chip">
              <span>Козырь</span>
              {game.currentRoundType === 'NO_TRUMP' || !game.trumpSuit ? (
                <strong>—</strong>
              ) : (
                <strong
                  className={
                    game.trumpSuit === 'HEARTS' || game.trumpSuit === 'DIAMONDS' ? 'is-red' : ''
                  }
                  title={suitNames[game.trumpSuit]}
                >
                  {suitSymbols[game.trumpSuit]}
                </strong>
              )}
            </div>

            {visualPlayers.map((player, visualIndex) => {
              const originalIndex = game.players.findIndex((item) => item.id === player.id);

              return (
                <PlayerSeat
                  isCurrent={originalIndex === game.currentPlayerIndex}
                  isDealer={originalIndex === game.dealerIndex}
                  isViewer={player.id === session.user.id}
                  key={player.id}
                  player={player}
                  position={getSeatPosition(game.maxPlayers, visualIndex)}
                />
              );
            })}

            <div
              className={`table-cards table-cards--${game.tableCards.length}`}
              aria-label="Карты текущей взятки"
            >
              {game.tableCards.length === 0 ? (
                <div className="table-cards__empty">
                  <img alt="" aria-hidden="true" src="/assets/logo-mark.svg" />
                  <span>Первый ход определит масть</span>
                </div>
              ) : (
                game.tableCards.map((played, index) => {
                  const playerIndex = visualPlayers.findIndex(
                    (player) => player.id === played.playerId,
                  );
                  const player = game.players.find((item) => item.id === played.playerId);

                  return (
                    <div
                      className="table-play"
                      key={`${played.playerId}-${index}`}
                      style={
                        {
                          '--play-index': index,
                          '--player-index': playerIndex,
                        } as CSSProperties
                      }
                    >
                      <PlayingCard card={played.card} />
                      <span>{player?.name ?? 'Игрок'}</span>
                      {played.jokerAction ? (
                        <small>
                          {played.jokerAction.type === 'TAKE'
                            ? 'Берёт'
                            : played.jokerAction.type === 'DEMAND_SUIT'
                              ? `Заказ ${suitSymbols[played.jokerAction.suit]}`
                              : 'Сброс'}
                        </small>
                      ) : null}
                    </div>
                  );
                })
              )}
            </div>

            <div className="table-score-mini">
              {[...game.players]
                .sort((left, right) => right.score - left.score)
                .map((player, index) => (
                  <span key={player.id}>
                    <i>{index + 1}</i>
                    <b>{player.id === session.user.id ? 'Вы' : player.name}</b>
                    <strong>{player.score}</strong>
                  </span>
                ))}
            </div>
          </div>
        </div>
      </section>

      <section className="game-action-zone">
        {game.state === 'BIDDING' ? (
          <div className="bidding-panel">
            <div className="bidding-panel__title">
              <span aria-hidden="true">◇</span>
              <div>
                <strong>
                  {viewerTurn ? 'Ваш заказ' : `Заказывает ${currentPlayer?.name ?? 'игрок'}`}
                </strong>
                <small>
                  {viewerTurn ? 'Сколько взяток вы планируете взять?' : 'Ожидаем выбор соперника'}
                </small>
              </div>
              {excludedBid !== null ? (
                <span className="except-badge">Кроме {excludedBid}</span>
              ) : null}
            </div>
            {viewerTurn && game.allowedBids ? (
              <div className="bid-options">
                {game.allowedBids.map((bid) => (
                  <button key={bid} onClick={() => send({ bid, type: 'PLACE_BID' })} type="button">
                    <strong>{bid === 0 ? 'Пас' : bid}</strong>
                    {bid > 0 ? <span>взяток</span> : null}
                  </button>
                ))}
              </div>
            ) : (
              <div className="turn-waiting">
                <span />
                <span />
                <span />
              </div>
            )}
          </div>
        ) : (
          <div
            className={`turn-prompt ${
              viewerTurn && game.state === 'PLAYING_TRICKS' ? 'is-active' : ''
            }`}
          >
            <span aria-hidden="true">
              {viewerTurn && game.state === 'PLAYING_TRICKS' ? '♠' : '◷'}
            </span>
            <div>
              <strong>
                {viewerTurn && game.state === 'PLAYING_TRICKS'
                  ? 'Ваш ход'
                  : `Ходит ${currentPlayer?.name ?? 'игрок'}`}
              </strong>
              <small>
                {viewerTurn && game.state === 'PLAYING_TRICKS'
                  ? 'Выберите карту из руки'
                  : 'Следим за розыгрышем'}
              </small>
            </div>
            <div className="turn-prompt__tricks">
              <span>Ваши взятки</span>
              <strong>{viewer?.tricksTaken ?? 0}</strong>
              <small>из {viewer?.currentBid ?? '—'}</small>
            </div>
          </div>
        )}

        <div className="player-hand" aria-label="Ваши карты">
          {viewer?.cards.map((card, cardIndex) => (
            <PlayingCard
              card={card}
              className={isCardAllowed(cardIndex) ? 'is-allowed' : ''}
              disabled={!card || !isCardAllowed(cardIndex)}
              faceDown={!card}
              interactive
              key={`${card?.rank ?? 'hidden'}-${card?.suit ?? 'card'}-${cardIndex}`}
              onClick={() => playCard(cardIndex)}
            />
          ))}
          {!viewer || viewer.cards.length === 0 ? (
            <div className="hand-empty">Карты появятся после раздачи</div>
          ) : null}
        </div>
      </section>

      {isChatOpen ? (
        <ChatPanel
          chatEnabled={game.chatEnabled !== false && (game.humanCount ?? 0) >= 2}
          compact
          currentUserId={session.user.id}
          messages={messages}
          onClose={() => setIsChatOpen(false)}
          onSend={(text) => send({ text, type: 'CHAT_SEND' })}
        />
      ) : null}

      <ReconnectBanner onRetry={onReconnect} status={connectionStatus} />

      {game.state === 'SHUFFLING_AND_DEALING' ? <DealingOverlay /> : null}

      {jokerCardIndex !== null ? (
        <JokerModal
          isLeading={game.tableCards.length === 0}
          onCancel={() => setJokerCardIndex(null)}
          onConfirm={(jokerAction) => {
            if (
              send({
                cardIndex: jokerCardIndex,
                jokerAction,
                type: 'PLAY_CARD',
              })
            ) {
              setJokerCardIndex(null);
            }
          }}
        />
      ) : null}

      {isScoreOpen ? <ScoreSheet game={game} onClose={() => setIsScoreOpen(false)} /> : null}

      {game.state === 'CONTROL_GAME_SETUP' ? (
        <ControlSetup
          game={game}
          onSubmit={(roundType, dealerIndex) =>
            send({
              dealerIndex,
              roundType,
              type: 'SETUP_CONTROL',
            })
          }
          viewerId={session.user.id}
        />
      ) : null}

      {game.state === 'MATCH_FINISHED' ? (
        <ResultModal game={game} onLeave={onLeave} viewerId={session.user.id} />
      ) : null}

      {isLeaveConfirmOpen ? (
        <Modal
          onClose={() => setIsLeaveConfirmOpen(false)}
          subtitle="Текущее место может занять другой игрок"
          title="Покинуть партию?"
          size="small"
        >
          <p className="leave-confirm-copy">
            При возвращении сервер попробует восстановить ваше место по профилю.
          </p>
          <div className="modal-actions">
            <Button onClick={() => setIsLeaveConfirmOpen(false)} variant="ghost">
              Остаться
            </Button>
            <Button onClick={onLeave} variant="danger">
              Покинуть
            </Button>
          </div>
        </Modal>
      ) : null}
    </main>
  );
}
