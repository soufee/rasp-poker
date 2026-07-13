import { useRoomSocket } from '../../hooks/useRoomSocket';
import type { Preferences, Session } from '../../types/game';
import { GameTable } from '../game/GameTable';
import { RoomError, RoomLoading, Toast } from '../status/StatusViews';
import { WaitingRoom } from '../waiting/WaitingRoom';

interface RoomExperienceProps {
  roomId: string;
  session: Session;
  preferences: Preferences;
  onLeave: () => void;
}

export function RoomExperience({ onLeave, preferences, roomId, session }: RoomExperienceProps) {
  const {
    chatMessages,
    clearNotice,
    connectionStatus,
    game,
    notice,
    reconnect,
    roomInfo,
    send,
    serverError,
  } = useRoomSocket(roomId, session);

  if (!game && serverError && connectionStatus === 'disconnected') {
    return <RoomError message={serverError} onLeave={onLeave} onRetry={reconnect} />;
  }

  if (!game) {
    return <RoomLoading onLeave={onLeave} roomId={roomId} />;
  }

  const content =
    game.state === 'WAITING_PLAYERS' ? (
      <WaitingRoom
        connectionStatus={connectionStatus}
        game={game}
        messages={chatMessages}
        onLeave={onLeave}
        roomId={roomId}
        roomInfo={roomInfo}
        send={send}
        session={session}
      />
    ) : (
      <GameTable
        connectionStatus={connectionStatus}
        game={game}
        messages={chatMessages}
        onLeave={onLeave}
        onReconnect={reconnect}
        preferences={preferences}
        roomId={roomId}
        roomInfo={roomInfo}
        send={send}
        session={session}
      />
    );

  return (
    <>
      {content}
      {notice ? <Toast message={notice} onClose={clearNotice} /> : null}
    </>
  );
}
