import type { ConnectionStatus } from '../../types/game';
import { Button, Logo, Spinner } from '../ui';

export function SplashScreen() {
  return (
    <main className="splash-screen">
      <div className="splash-screen__halo" aria-hidden="true" />
      <Logo />
      <div className="splash-screen__loader">
        <span />
      </div>
      <p>Собираем игроков за столом</p>
    </main>
  );
}

interface RoomLoadingProps {
  roomId: string;
  onLeave: () => void;
}

export function RoomLoading({ onLeave, roomId }: RoomLoadingProps) {
  return (
    <main className="centered-state">
      <Logo compact />
      <Spinner />
      <h1>Подключаемся к столу</h1>
      <p>Комната {roomId}</p>
      <Button onClick={onLeave} variant="ghost">
        Вернуться в лобби
      </Button>
    </main>
  );
}

interface RoomErrorProps {
  message: string;
  onLeave: () => void;
  onRetry: () => void;
}

export function RoomError({ message, onLeave, onRetry }: RoomErrorProps) {
  return (
    <main className="centered-state centered-state--error">
      <Logo compact />
      <span className="centered-state__symbol" aria-hidden="true">
        !
      </span>
      <h1>Не удалось войти в комнату</h1>
      <p>{message}</p>
      <div className="centered-state__actions">
        <Button onClick={onRetry}>Повторить</Button>
        <Button onClick={onLeave} variant="ghost">
          Вернуться в лобби
        </Button>
      </div>
    </main>
  );
}

interface ReconnectBannerProps {
  status: ConnectionStatus;
  onRetry: () => void;
}

export function ReconnectBanner({ onRetry, status }: ReconnectBannerProps) {
  if (status === 'connected' || status === 'connecting') {
    return null;
  }

  return (
    <div className={`reconnect-banner reconnect-banner--${status}`} role="status">
      <Spinner />
      <span>
        {status === 'reconnecting'
          ? 'Связь прервалась. Восстанавливаем партию…'
          : 'Соединение потеряно'}
      </span>
      {status !== 'reconnecting' ? (
        <button onClick={onRetry} type="button">
          Повторить
        </button>
      ) : null}
    </div>
  );
}

interface ToastProps {
  message: string;
  onClose: () => void;
}

export function Toast({ message, onClose }: ToastProps) {
  return (
    <div className="toast" role="alert">
      <span aria-hidden="true">!</span>
      <p>{message}</p>
      <button aria-label="Закрыть уведомление" onClick={onClose} type="button">
        ×
      </button>
    </div>
  );
}

export function DealingOverlay() {
  return (
    <div className="dealing-overlay" role="status">
      <div className="dealing-cards" aria-hidden="true">
        <img alt="" src="/assets/card-back.svg" />
        <img alt="" src="/assets/card-back.svg" />
        <img alt="" src="/assets/card-back.svg" />
      </div>
      <h2>Раздаём карты</h2>
      <p>Новый раунд начинается</p>
    </div>
  );
}
