import { useCallback, useEffect, useState } from 'react';
import type { Preferences } from '../types/game';

const STORAGE_KEY = 'rasp-poker.preferences';

const defaults: Preferences = {
  chatOpen: false,
  compactCards: false,
  reducedMotion: false,
  sound: true,
};

function readPreferences(): Preferences {
  const raw = localStorage.getItem(STORAGE_KEY);

  if (!raw) {
    return defaults;
  }

  try {
    const stored = JSON.parse(raw) as Partial<Preferences>;

    return {
      ...defaults,
      ...stored,
    };
  } catch {
    return defaults;
  }
}

interface UsePreferencesResult {
  preferences: Preferences;
  updatePreference: <Key extends keyof Preferences>(key: Key, value: Preferences[Key]) => void;
}

export function usePreferences(): UsePreferencesResult {
  const [preferences, setPreferences] = useState<Preferences>(() => readPreferences());

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
    document.documentElement.classList.toggle('reduce-motion', preferences.reducedMotion);
    document.documentElement.classList.toggle('compact-cards', preferences.compactCards);
  }, [preferences]);

  const updatePreference = useCallback(
    <Key extends keyof Preferences>(key: Key, value: Preferences[Key]) => {
      setPreferences((current) => ({
        ...current,
        [key]: value,
      }));
    },
    [],
  );

  return {
    preferences,
    updatePreference,
  };
}
