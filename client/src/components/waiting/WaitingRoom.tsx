import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  ChatMessage,
  ConnectionStatus,
  GameSnapshot,
  OutgoingRoomEvent,
  RoomInfo,
  RoomSettings,
  Session,
} from '../../types/game';
import { ChatPanel } from '../game/ChatPanel';
import { Avatar, Button, ConnectionBadge, Logo, Spinner, Toggle } from '../ui';

interface WaitingRoomProps {
  roomId: string;
  roomInfo: RoomInfo | null;
  game: GameSnapshot | null;
  session: Session;
  connectionStatus: ConnectionStatus;
  messages: ChatMessage[];
  send: (event: OutgoingRoomEvent) => boolean;
  onLeave: () => void;
}

export function WaitingRoom({
  connectionStatus,
  game,
  messages,
  onLeave,
  roomId,
  roomInfo,
  send,
  session,
}: WaitingRoomProps) {
  const maxPlayers = roomInfo?.maxPlayers ?? game?.maxPlayers ?? 4;
  const [settings, setSettings] = useState<RoomSettings>({
    hasLadder: true,
    hasMiser: true,
    playersCount: maxPlayers,
  });
  const [copyLabel, setCopyLabel] = useState('Копировать ссылку');
  const settingsHydrated = useRef(false);
  const players = game?.players ?? [];
  const hostId = game?.hostId ?? roomInfo?.hostId ?? players[0]?.id ?? session.user.id;
  const isHost = hostId === session.user.id;
  const canStart =
    connectionStatus === 'connected' && players.length === settings.playersCount && isHost;
  const slots = useMemo(
    () => Array.from({ length: maxPlayers }, (_, index) => players[index] ?? null),
    [maxPlayers, players],
  );

  useEffect(() => {
    setSettings((current) => {
      if (current.playersCount === maxPlayers) {
        return current;
      }

      return {
        ...current,
        playersCount: maxPlayers,
      };
    });
  }, [maxPlayers]);

  useEffect(() => {
    if (!roomInfo?.settings || settingsHydrated.current) {
      return;
    }

    settingsHydrated.current = true;
    setSettings(roomInfo.settings);
  }, [roomInfo?.settings]);

  const copyInvite = async () => {
    const url = new URL(window.location.href);
    url.searchParams.set('room', roomId);

    try {
      await navigator.clipboard.writeText(url.toString());
      setCopyLabel('Ссылка скопирована');
    } catch {
      setCopyLabel(`Код: ${roomInfo?.inviteCode ?? roomId}`);
    }
  };

  return (
    <main className="waiting-shell">
      <header className="app-header app-header--room">
        <Logo />
        <div className="app-header__room-meta">
          <ConnectionBadge status={connectionStatus} />
          <Button onClick={onLeave} variant="ghost">
            Покинуть комнату
          </Button>
        </div>
      </header>

      <div className="waiting-layout">
        <section className="waiting-main">
          <header className="waiting-title">
            <div>
              <span className="eyebrow">Комната ожидания</span>
              <h1>{roomInfo?.name ?? 'Игровой стол'}</h1>
              <p>
                Код комнаты: <strong>{roomInfo?.inviteCode ?? roomId}</strong>
              </p>
            </div>
            <Button onClick={() => void copyInvite()} variant="secondary">
              {copyLabel}
            </Button>
          </header>

          <div className={`waiting-table waiting-table--${maxPlayers}`}>
            <div className="waiting-table__surface">
              <img alt="" aria-hidden="true" src="/assets/logo-mark.svg" />
              <span>
                {players.length} / {maxPlayers}
              </span>
              <small>игроков за столом</small>
            </div>
            {slots.map((player, index) => (
              <article
                className={`waiting-seat waiting-seat--${index} ${player ? 'is-occupied' : ''}`}
                key={player?.id ?? `empty-${index}`}
              >
                {player ? (
                  <>
                    <div className="waiting-seat__avatar">
                      <Avatar name={player.name} src={player.avatarUrl} />
                      {player.id === hostId ? <span>Хозяин</span> : null}
                    </div>
                    <strong>{player.name}</strong>
                    <small>{player.connected === false ? 'Не в сети' : 'За столом'}</small>
                  </>
                ) : (
                  <>
                    <span className="waiting-seat__empty">＋</span>
                    <strong>Свободное место</strong>
                    <small>Ожидаем игрока</small>
                  </>
                )}
              </article>
            ))}
          </div>

          {!game ? (
            <div className="waiting-connection">
              <Spinner />
              <span>Получаем данные комнаты…</span>
            </div>
          ) : null}

          <section className="waiting-settings">
            <header>
              <div>
                <span className="eyebrow">Формат партии</span>
                <h2>{isHost ? 'Настройте игру' : 'Настройки хозяина'}</h2>
              </div>
              <span className="players-badge">{settings.playersCount} игроков</span>
            </header>
            <div className="settings-list">
              <Toggle
                checked={settings.hasLadder}
                description="Раунды с постепенным увеличением руки"
                disabled={!isHost}
                label="Лесенка"
                onChange={(checked) => {
                  if (isHost) {
                    setSettings((current) => ({
                      ...current,
                      hasLadder: checked,
                    }));
                  }
                }}
              />
              <Toggle
                checked={settings.hasMiser}
                description="Дополнительная серия без взяток"
                disabled={!isHost}
                label="Мизер"
                onChange={(checked) => {
                  if (isHost) {
                    setSettings((current) => ({
                      ...current,
                      hasMiser: checked,
                    }));
                  }
                }}
              />
            </div>
            {isHost ? (
              <div className="waiting-start">
                <p>
                  {players.length < settings.playersCount
                    ? `Нужно ещё ${settings.playersCount - players.length} игрока`
                    : 'Все места заняты — можно начинать'}
                </p>
                <Button disabled={!canStart} onClick={() => send({ settings, type: 'START_GAME' })}>
                  Начать игру
                </Button>
              </div>
            ) : (
              <div className="waiting-start">
                <p>Партия начнётся, когда хозяин подтвердит настройки.</p>
                <span className="waiting-pulse">Ожидаем хозяина</span>
              </div>
            )}
          </section>
        </section>

        <ChatPanel
          chatEnabled={Boolean(game?.chatEnabled)}
          currentUserId={session.user.id}
          messages={messages}
          onSend={(text) => send({ text, type: 'CHAT_SEND' })}
        />
      </div>
    </main>
  );
}
