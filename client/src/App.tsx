import { useEffect, useState } from 'react';
import { AuthScreen } from './components/auth/AuthScreen';
import { LobbyScreen } from './components/lobby/LobbyScreen';
import { RoomExperience } from './components/room/RoomExperience';
import { SettingsScreen } from './components/settings/SettingsScreen';
import { SplashScreen } from './components/status/StatusViews';
import { usePreferences } from './hooks/usePreferences';
import { useSession } from './hooks/useSession';

type AppView = 'lobby' | 'settings';

function getInitialRoomId(): string | null {
  return new URLSearchParams(window.location.search).get('room');
}

export default function App() {
  const {
    acceptSession,
    bootstrapError,
    continueAsGuest,
    isLoading,
    logout,
    session,
    updateDisplayName,
    refreshSession,
  } = useSession();
  const { preferences, updatePreference } = usePreferences();
  const [view, setView] = useState<AppView>('lobby');
  const [roomId, setRoomId] = useState<string | null>(() => getInitialRoomId());
  const [splashReady, setSplashReady] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setSplashReady(true), 900);

    return () => {
      window.clearTimeout(timer);
    };
  }, []);

  const joinRoom = (nextRoomId: string) => {
    const normalizedRoomId = nextRoomId.trim();

    if (!normalizedRoomId) {
      return;
    }

    const url = new URL(window.location.href);
    url.searchParams.set('room', normalizedRoomId);
    window.history.replaceState(null, '', url);
    setRoomId(normalizedRoomId);
  };

  const leaveRoom = () => {
    const url = new URL(window.location.href);
    url.searchParams.delete('room');
    window.history.replaceState(null, '', url);
    setRoomId(null);
    setView('lobby');
    refreshSession();
  };

  const handleLogout = () => {
    leaveRoom();
    logout();
  };

  if (isLoading || !splashReady) {
    return <SplashScreen />;
  }

  if (!session) {
    return (
      <AuthScreen
        bootstrapError={bootstrapError}
        onAuthenticated={acceptSession}
        onGuest={continueAsGuest}
      />
    );
  }

  if (roomId) {
    return (
      <RoomExperience
        onLeave={leaveRoom}
        preferences={preferences}
        roomId={roomId}
        session={session}
      />
    );
  }

  if (view === 'settings') {
    return (
      <SettingsScreen
        onBack={() => setView('lobby')}
        onLogout={handleLogout}
        onUpdateName={updateDisplayName}
        preferences={preferences}
        session={session}
        updatePreference={updatePreference}
      />
    );
  }

  return (
    <LobbyScreen
      onJoinRoom={joinRoom}
      onLogout={handleLogout}
      onOpenSettings={() => setView('settings')}
      session={session}
    />
  );
}
