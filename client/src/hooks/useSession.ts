import { useCallback, useEffect, useState } from 'react';
import { authApi } from '../services/api';
import type { Session } from '../types/game';

const STORAGE_KEY = 'rasp-poker.session';
const GUEST_STATS_KEY = 'rasp-poker.guest-stats';

interface GuestStats {
  ratingPoints: number;
  gamesPlayed: number;
  gamesWon: number;
}

export function readGuestStats(): GuestStats {
  const raw = localStorage.getItem(GUEST_STATS_KEY);
  if (!raw) {
    return { ratingPoints: 0, gamesPlayed: 0, gamesWon: 0 };
  }
  try {
    return JSON.parse(raw) as GuestStats;
  } catch {
    return { ratingPoints: 0, gamesPlayed: 0, gamesWon: 0 };
  }
}

export function writeGuestStats(stats: GuestStats): void {
  localStorage.setItem(GUEST_STATS_KEY, JSON.stringify(stats));
}

interface UseSessionResult {
  session: Session | null;
  isLoading: boolean;
  bootstrapError: string | null;
  acceptSession: (session: Session) => void;
  continueAsGuest: (name: string) => void;
  updateDisplayName: (name: string) => void;
  logout: () => void;
  clearBootstrapError: () => void;
  refreshSession: () => void;
}

function readStoredSession(): Session | null {
  const raw = localStorage.getItem(STORAGE_KEY);

  if (!raw) {
    return null;
  }

  try {
    const value = JSON.parse(raw) as Session;

    if (!value.user?.id || !value.user.displayName) {
      return null;
    }

    return value;
  } catch {
    return null;
  }
}

function persistSession(session: Session | null): void {
  if (!session) {
    localStorage.removeItem(STORAGE_KEY);
    return;
  }

  localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
}

export function useSession(): UseSessionResult {
  const [session, setSession] = useState<Session | null>(() => readStoredSession());
  const [isLoading, setIsLoading] = useState(true);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const stored = readStoredSession();

    if (stored && !stored.token) {
      setIsLoading(false);
      return;
    }

    authApi
      .bootstrap(stored?.token)
      .then((nextSession) => {
        if (!active) {
          return;
        }

        persistSession(nextSession);
        setSession(nextSession);
        setBootstrapError(null);
      })
      .catch((error: unknown) => {
        if (!active) {
          return;
        }

        if (stored?.token) {
          const message = error instanceof Error ? error.message : 'Не удалось проверить сессию';
          persistSession(null);
          setSession(null);
          setBootstrapError(message);
        }
      })
      .finally(() => {
        if (active) {
          setIsLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, []);

  const acceptSession = useCallback((nextSession: Session) => {
    persistSession(nextSession);
    setSession(nextSession);
    setBootstrapError(null);
  }, []);

  const continueAsGuest = useCallback((name: string) => {
    const stats = readGuestStats();
    const nextSession: Session = {
      user: {
        displayName: name.trim(),
        id: `guest-${crypto.randomUUID()}`,
        isGuest: true,
        verified: true,
        ratingPoints: stats.ratingPoints,
        gamesPlayed: stats.gamesPlayed,
        gamesWon: stats.gamesWon,
      },
    };

    persistSession(nextSession);
    setSession(nextSession);
    setBootstrapError(null);
  }, []);

  const refreshSession = useCallback(() => {
    const stored = readStoredSession();
    if (!stored) return;

    if (stored.user.isGuest) {
      const stats = readGuestStats();
      setSession((current) => {
        if (!current) return null;
        const nextSession = {
          ...current,
          user: {
            ...current.user,
            ratingPoints: stats.ratingPoints,
            gamesPlayed: stats.gamesPlayed,
            gamesWon: stats.gamesWon,
          },
        };
        persistSession(nextSession);
        return nextSession;
      });
    } else {
      authApi
        .bootstrap(stored.token)
        .then((nextSession) => {
          persistSession(nextSession);
          setSession(nextSession);
        })
        .catch((err) => {
          console.error('Failed to refresh session stats:', err);
        });
    }
  }, []);

  const updateDisplayName = useCallback((name: string) => {
    setSession((current) => {
      if (!current) {
        return current;
      }

      const nextSession = {
        ...current,
        user: {
          ...current.user,
          displayName: name.trim(),
        },
      };
      persistSession(nextSession);

      return nextSession;
    });
  }, []);

  const logout = useCallback(() => {
    persistSession(null);
    setSession(null);
  }, []);

  const clearBootstrapError = useCallback(() => {
    setBootstrapError(null);
  }, []);

  return {
    acceptSession,
    bootstrapError,
    clearBootstrapError,
    continueAsGuest,
    isLoading,
    logout,
    session,
    updateDisplayName,
    refreshSession,
  };
}
