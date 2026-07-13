import { type FormEvent, useState } from 'react';
import type { Preferences, Session } from '../../types/game';
import { Avatar, Button, Logo, Toggle } from '../ui';

type SettingsTab = 'profile' | 'game';

interface SettingsScreenProps {
  session: Session;
  preferences: Preferences;
  onBack: () => void;
  onLogout: () => void;
  onUpdateName: (name: string) => void;
  updatePreference: <Key extends keyof Preferences>(key: Key, value: Preferences[Key]) => void;
}

export function SettingsScreen({
  onBack,
  onLogout,
  onUpdateName,
  preferences,
  session,
  updatePreference,
}: SettingsScreenProps) {
  const [tab, setTab] = useState<SettingsTab>('profile');
  const [displayName, setDisplayName] = useState(session.user.displayName);
  const [saved, setSaved] = useState(false);

  const saveProfile = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalizedName = displayName.trim();

    if (normalizedName.length < 2) {
      return;
    }

    onUpdateName(normalizedName);
    setSaved(true);
  };

  const resetPreferences = () => {
    updatePreference('chatOpen', true);
    updatePreference('compactCards', false);
    updatePreference('reducedMotion', false);
    updatePreference('sound', true);
  };

  return (
    <main className="settings-shell">
      <header className="app-header">
        <Logo />
        <Button onClick={onBack} variant="ghost">
          ← Вернуться в лобби
        </Button>
      </header>

      <div className="settings-layout">
        <aside className="settings-nav">
          <div className="settings-nav__profile">
            <Avatar name={session.user.displayName} size="large" />
            <strong>{session.user.displayName}</strong>
            <span>{session.user.isGuest ? 'Гостевой профиль' : session.user.email}</span>
            <div className="profile-stats-card">
              <div>
                <span>{session.user.ratingPoints ?? 0}</span>
                очков
              </div>
              <div>
                <span>{session.user.gamesPlayed ?? 0}</span>
                игр
              </div>
              <div>
                <span>{session.user.gamesWon ?? 0}</span>
                побед
              </div>
            </div>
          </div>
          <nav aria-label="Разделы настроек">
            <button
              className={tab === 'profile' ? 'is-active' : ''}
              onClick={() => setTab('profile')}
              type="button"
            >
              <span aria-hidden="true">♙</span>
              Профиль
            </button>
            <button
              className={tab === 'game' ? 'is-active' : ''}
              onClick={() => setTab('game')}
              type="button"
            >
              <span aria-hidden="true">⚙</span>
              Игра и интерфейс
            </button>
          </nav>
          <Button onClick={onLogout} variant="danger" wide>
            Выйти из аккаунта
          </Button>
        </aside>

        <section className="settings-content">
          {tab === 'profile' ? (
            <>
              <header className="settings-content__header">
                <span className="eyebrow">Личные данные</span>
                <h1>Профиль игрока</h1>
                <p>Имя отображается в лобби, чате и за игровым столом.</p>
              </header>
              <form className="profile-form" onSubmit={saveProfile}>
                <div className="profile-form__avatar">
                  <Avatar name={displayName || 'Игрок'} size="large" />
                  <div>
                    <strong>Клубный аватар</strong>
                    <p>Используется нейтральный знак игрока.</p>
                  </div>
                </div>
                <label className="field">
                  <span>Имя игрока</span>
                  <input
                    maxLength={24}
                    minLength={2}
                    onChange={(event) => {
                      setDisplayName(event.currentTarget.value);
                      setSaved(false);
                    }}
                    required
                    value={displayName}
                  />
                  <small>{displayName.length} / 24</small>
                </label>
                {session.user.email ? (
                  <label className="field">
                    <span>Электронная почта</span>
                    <input disabled value={session.user.email} />
                    <small>
                      {session.user.verified ? 'Адрес подтверждён' : 'Адрес ожидает подтверждения'}
                    </small>
                  </label>
                ) : (
                  <div className="profile-note">
                    <span aria-hidden="true">◇</span>
                    <div>
                      <strong>Гостевой режим</strong>
                      <p>Имя и настройки хранятся только в этом браузере.</p>
                    </div>
                  </div>
                )}
                <div className="settings-save">
                  {saved ? <span>Изменения сохранены</span> : null}
                  <Button disabled={displayName.trim().length < 2} type="submit">
                    Сохранить профиль
                  </Button>
                </div>
              </form>
            </>
          ) : null}

          {tab === 'game' ? (
            <>
              <header className="settings-content__header">
                <span className="eyebrow">Ваш комфорт</span>
                <h1>Игра и интерфейс</h1>
                <p>Настройки применяются сразу и сохраняются на устройстве.</p>
              </header>
              <div className="preference-groups">
                <section>
                  <h2>За игровым столом</h2>
                  <div className="settings-list">
                    <Toggle
                      checked={preferences.sound}
                      description="Сигналы хода, ставки и нового сообщения"
                      label="Звуковые сигналы"
                      onChange={(value) => updatePreference('sound', value)}
                    />
                    <Toggle
                      checked={preferences.chatOpen}
                      description="Показывать панель чата при входе в комнату"
                      label="Открывать чат"
                      onChange={(value) => updatePreference('chatOpen', value)}
                    />
                    <Toggle
                      checked={preferences.compactCards}
                      description="Меньше перекрытие карт в узком окне"
                      label="Компактная рука"
                      onChange={(value) => updatePreference('compactCards', value)}
                    />
                  </div>
                </section>
                <section>
                  <h2>Доступность</h2>
                  <div className="settings-list">
                    <Toggle
                      checked={preferences.reducedMotion}
                      description="Отключить перелёты карт и декоративные эффекты"
                      label="Уменьшить движение"
                      onChange={(value) => updatePreference('reducedMotion', value)}
                    />
                  </div>
                </section>
              </div>
              <div className="settings-reset">
                <div>
                  <strong>Настройки по умолчанию</strong>
                  <p>Вернуть звук, обычные карты и открытый чат.</p>
                </div>
                <Button onClick={resetPreferences} variant="secondary">
                  Сбросить настройки
                </Button>
              </div>
            </>
          ) : null}
        </section>
      </div>
    </main>
  );
}
