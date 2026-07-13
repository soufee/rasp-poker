import { type FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { roomsApi } from '../../services/api';
import type { RoomSummary, Session } from '../../types/game';
import { Avatar, Button, Logo, Modal, Spinner, Toggle } from '../ui';

type LobbyFilter = 'all' | 'waiting' | 'playing';

interface LobbyScreenProps {
  session: Session;
  onJoinRoom: (roomId: string) => void;
  onOpenSettings: () => void;
  onLogout: () => void;
}

interface CreateRoomModalProps {
  session: Session;
  onClose: () => void;
  onCreated: (room: RoomSummary) => void;
}

const filterLabels: Record<LobbyFilter, string> = {
  all: 'Все столы',
  playing: 'Идёт игра',
  waiting: 'Ожидают',
};

function CreateRoomModal({ onClose, onCreated, session }: CreateRoomModalProps) {
  const [name, setName] = useState('Вечерняя партия');
  const [playersCount, setPlayersCount] = useState<3 | 4 | 6>(4);
  const [hasLadder, setHasLadder] = useState(true);
  const [hasMiser, setHasMiser] = useState(true);
  const [isPrivate, setIsPrivate] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsSubmitting(true);
    setError(null);

    try {
      const room = await roomsApi.create(
        {
          hasLadder,
          hasMiser,
          isPrivate,
          name: name.trim(),
          playersCount,
        },
        session,
      );
      onCreated(room);
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : 'Не удалось создать комнату');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Modal
      onClose={isSubmitting ? undefined : onClose}
      subtitle="Параметры можно проверить в комнате ожидания"
      title="Новый игровой стол"
    >
      <form className="form-stack create-room-form" onSubmit={submit}>
        <label className="field">
          <span>Название стола</span>
          <input
            maxLength={36}
            minLength={3}
            onChange={(event) => setName(event.currentTarget.value)}
            required
            value={name}
          />
        </label>
        <fieldset className="segmented-field">
          <legend>Количество игроков</legend>
          <div className="segmented-control segmented-control--three">
            {([3, 4, 6] as const).map((count) => (
              <button
                aria-pressed={playersCount === count}
                className={playersCount === count ? 'is-active' : ''}
                key={count}
                onClick={() => setPlayersCount(count)}
                type="button"
              >
                <strong>{count}</strong>
                <span>игрока</span>
              </button>
            ))}
          </div>
        </fieldset>
        <div className="settings-list">
          <Toggle
            checked={hasLadder}
            description="Раунды от одной карты вверх"
            label="Лесенка"
            onChange={setHasLadder}
          />
          <Toggle
            checked={hasMiser}
            description="Серия раундов без взяток"
            label="Мизер"
            onChange={setHasMiser}
          />
          <Toggle
            checked={isPrivate}
            description="Комната доступна только по коду"
            label="Закрытый стол"
            onChange={setIsPrivate}
          />
        </div>
        {error ? <p className="form-message form-message--error">{error}</p> : null}
        <div className="modal-actions">
          <Button disabled={isSubmitting} onClick={onClose} variant="ghost">
            Отмена
          </Button>
          <Button disabled={isSubmitting} type="submit">
            {isSubmitting ? <Spinner /> : 'Создать стол'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function RoomCard({ onJoin, room }: { room: RoomSummary; onJoin: (roomId: string) => void }) {
  const isFull = room.playersCount >= room.maxPlayers;
  const canJoin = room.status === 'waiting' && !isFull;

  return (
    <article className="room-card">
      <div className="room-card__felt" aria-hidden="true">
        <span>{room.maxPlayers}</span>
      </div>
      <div className="room-card__content">
        <header>
          <div>
            <span className={`room-status room-status--${room.status}`}>
              {room.status === 'waiting'
                ? 'Набор игроков'
                : room.status === 'playing'
                  ? 'Идёт партия'
                  : 'Завершена'}
            </span>
            <h3>{room.name}</h3>
          </div>
          <span aria-label={room.isPrivate ? 'Закрытая комната' : 'Открытая комната'}>
            {room.isPrivate ? '◆' : '◇'}
          </span>
        </header>
        <div className="room-card__meta">
          <span>
            <b>{room.playersCount}</b> / {room.maxPlayers} игроков
          </span>
          {room.ownerName ? <span>Хозяин: {room.ownerName}</span> : null}
        </div>
        <div className="seat-dots" aria-hidden="true">
          {Array.from({ length: room.maxPlayers }, (_, index) => (
            <span className={index < room.playersCount ? 'is-filled' : ''} key={index} />
          ))}
        </div>
        <Button
          disabled={!canJoin}
          onClick={() => onJoin(room.id)}
          variant={canJoin ? 'secondary' : 'ghost'}
          wide
        >
          {isFull ? 'Нет мест' : room.status === 'waiting' ? 'Занять место' : 'Партия началась'}
        </Button>
      </div>
    </article>
  );
}

export function LobbyScreen({ onJoinRoom, onLogout, onOpenSettings, session }: LobbyScreenProps) {
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [filter, setFilter] = useState<LobbyFilter>('all');
  const [query, setQuery] = useState('');
  const [roomCode, setRoomCode] = useState('');
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadRooms = useCallback(
    async (signal?: AbortSignal) => {
      setIsLoading(true);
      setError(null);

      try {
        const nextRooms = await roomsApi.list(session.token, signal);
        setRooms(nextRooms);
      } catch (caught: unknown) {
        if (caught instanceof DOMException && caught.name === 'AbortError') {
          return;
        }

        setError(caught instanceof Error ? caught.message : 'Не удалось загрузить список столов');
      } finally {
        if (!signal?.aborted) {
          setIsLoading(false);
        }
      }
    },
    [session.token],
  );

  useEffect(() => {
    const controller = new AbortController();
    void loadRooms(controller.signal);

    return () => {
      controller.abort();
    };
  }, [loadRooms]);

  const visibleRooms = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    return rooms.filter((room) => {
      const matchesFilter = filter === 'all' || room.status === filter;
      const matchesQuery =
        !normalizedQuery
        || room.name.toLowerCase().includes(normalizedQuery)
        || room.id.toLowerCase().includes(normalizedQuery);

      return matchesFilter && matchesQuery;
    });
  }, [filter, query, rooms]);

  const joinByCode = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalizedCode = roomCode.trim();

    if (normalizedCode) {
      onJoinRoom(normalizedCode);
    }
  };

  const roomCounts = {
    all: rooms.length,
    playing: rooms.filter((room) => room.status === 'playing').length,
    waiting: rooms.filter((room) => room.status === 'waiting').length,
  };

  return (
    <main className="lobby-shell">
      <header className="app-header">
        <Logo />
        <nav className="app-header__actions" aria-label="Профиль">
          <button className="profile-chip" onClick={onOpenSettings} type="button">
            <Avatar name={session.user.displayName} size="small" />
            <span>
              <strong>{session.user.displayName}</strong>
              <small>{session.user.isGuest ? 'Гость' : 'Профиль игрока'}</small>
            </span>
          </button>
          <button
            aria-label="Настройки"
            className="icon-button"
            onClick={onOpenSettings}
            type="button"
          >
            ⚙
          </button>
          <button aria-label="Выйти" className="icon-button" onClick={onLogout} type="button">
            ↪
          </button>
        </nav>
      </header>

      <section className="lobby-hero">
        <div>
          <span className="eyebrow">Игровой зал</span>
          <h1>Выберите свой стол</h1>
          <p>Присоединитесь к открытой партии или задайте собственные правила.</p>
        </div>
        <Button className="lobby-hero__create" onClick={() => setIsCreateOpen(true)}>
          <span aria-hidden="true">＋</span> Создать стол
        </Button>
      </section>

      <section className="lobby-toolbar">
        <div className="lobby-tabs" role="tablist" aria-label="Фильтр комнат">
          {(Object.keys(filterLabels) as LobbyFilter[]).map((key) => (
            <button
              aria-selected={filter === key}
              className={filter === key ? 'is-active' : ''}
              key={key}
              onClick={() => setFilter(key)}
              role="tab"
              type="button"
            >
              {filterLabels[key]} <span>{roomCounts[key]}</span>
            </button>
          ))}
        </div>
        <label className="search-field">
          <span aria-hidden="true">⌕</span>
          <input
            aria-label="Поиск комнаты"
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="Название или код"
            type="search"
            value={query}
          />
        </label>
        <button
          aria-label="Обновить список"
          className="icon-button"
          disabled={isLoading}
          onClick={() => void loadRooms()}
          type="button"
        >
          ↻
        </button>
      </section>

      {error ? (
        <section className="inline-state inline-state--error">
          <span aria-hidden="true">!</span>
          <div>
            <strong>Список столов пока недоступен</strong>
            <p>{error}</p>
          </div>
          <Button onClick={() => void loadRooms()} variant="secondary">
            Повторить
          </Button>
        </section>
      ) : null}

      {isLoading && rooms.length === 0 ? (
        <section className="room-grid" aria-label="Загрузка комнат">
          {Array.from({ length: 4 }, (_, index) => (
            <div className="room-card room-card--skeleton" key={index}>
              <Spinner />
            </div>
          ))}
        </section>
      ) : null}

      {!isLoading && !error && visibleRooms.length === 0 ? (
        <section className="empty-state">
          <span aria-hidden="true">♠</span>
          <h2>{rooms.length === 0 ? 'Зал пока пуст' : 'Столы не найдены'}</h2>
          <p>
            {rooms.length === 0
              ? 'Станьте хозяином первой партии.'
              : 'Измените фильтр или строку поиска.'}
          </p>
          {rooms.length === 0 ? (
            <Button onClick={() => setIsCreateOpen(true)}>Создать стол</Button>
          ) : (
            <Button
              onClick={() => {
                setFilter('all');
                setQuery('');
              }}
              variant="secondary"
            >
              Сбросить фильтры
            </Button>
          )}
        </section>
      ) : null}

      {visibleRooms.length > 0 ? (
        <section className="room-grid" aria-label="Доступные комнаты">
          {visibleRooms.map((room) => (
            <RoomCard key={room.id} onJoin={onJoinRoom} room={room} />
          ))}
        </section>
      ) : null}

      <form className="join-code" onSubmit={joinByCode}>
        <div>
          <strong>Есть код приглашения?</strong>
          <span>Войдите напрямую в закрытую комнату.</span>
        </div>
        <label className="field">
          <span className="sr-only">Код комнаты</span>
          <input
            onChange={(event) => setRoomCode(event.currentTarget.value)}
            placeholder="Введите код комнаты"
            required
            value={roomCode}
          />
        </label>
        <Button type="submit" variant="secondary">
          Войти по коду
        </Button>
      </form>

      {isCreateOpen ? (
        <CreateRoomModal
          onClose={() => setIsCreateOpen(false)}
          onCreated={(room) => onJoinRoom(room.id)}
          session={session}
        />
      ) : null}
    </main>
  );
}
