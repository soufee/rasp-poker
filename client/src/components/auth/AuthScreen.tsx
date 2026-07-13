import { type FormEvent, useState } from 'react';
import { authApi } from '../../services/api';
import type { Session } from '../../types/game';
import { Button, Logo, Spinner } from '../ui';

type AuthMode = 'login' | 'register' | 'forgot' | 'reset' | 'verify' | 'guest';

interface AuthScreenProps {
  bootstrapError?: string | null;
  onAuthenticated: (session: Session) => void;
  onGuest: (name: string) => void;
}

function getInitialMode(): AuthMode {
  const params = new URLSearchParams(window.location.search);

  if (params.has('verify')) {
    return 'verify';
  }

  if (params.has('reset')) {
    return 'reset';
  }

  return 'login';
}

function getInitialToken(key: 'verify' | 'reset'): string {
  return new URLSearchParams(window.location.search).get(key) ?? '';
}

function readableError(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) {
    return fallback;
  }

  const translations: Record<string, string> = {
    'Email already registered': 'Этот адрес уже зарегистрирован',
    'Invalid credentials': 'Неверная почта или пароль',
    'Invalid or expired reset token': 'Код сброса недействителен или устарел',
    'Invalid or expired verification token': 'Код подтверждения недействителен или устарел',
  };

  return translations[error.message] ?? error.message;
}

export function AuthScreen({ bootstrapError, onAuthenticated, onGuest }: AuthScreenProps) {
  const [mode, setMode] = useState<AuthMode>(() => getInitialMode());
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [passwordRepeat, setPasswordRepeat] = useState('');
  const [resetToken, setResetToken] = useState(() => getInitialToken('reset'));
  const [verifyToken, setVerifyToken] = useState(() => getInitialToken('verify'));
  const [showPassword, setShowPassword] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(bootstrapError ?? null);
  const [message, setMessage] = useState<string | null>(null);

  const switchMode = (nextMode: AuthMode) => {
    setMode(nextMode);
    setError(null);
    setMessage(null);
    setPassword('');
    setPasswordRepeat('');
  };

  const submitLogin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsSubmitting(true);
    setError(null);

    try {
      const session = await authApi.login({ email: email.trim(), password });
      onAuthenticated(session);
    } catch (caught: unknown) {
      setError(readableError(caught, 'Не удалось войти'));
    } finally {
      setIsSubmitting(false);
    }
  };

  const submitRegister = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (password.length < 8) {
      setError('Пароль должен содержать не менее 8 символов');
      return;
    }

    if (password !== passwordRepeat) {
      setError('Пароли не совпадают');
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      await authApi.register({
        displayName: displayName.trim(),
        email: email.trim(),
        password,
      });
      setMessage('Письмо отправлено. Вставьте код из ссылки для подтверждения.');
      setMode('verify');
    } catch (caught: unknown) {
      setError(readableError(caught, 'Не удалось создать аккаунт'));
    } finally {
      setIsSubmitting(false);
    }
  };

  const submitForgot = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsSubmitting(true);
    setError(null);

    try {
      await authApi.forgotPassword(email.trim());
      setMessage('Если адрес найден, на него отправлена ссылка для восстановления.');
    } catch (caught: unknown) {
      setError(readableError(caught, 'Не удалось отправить письмо'));
    } finally {
      setIsSubmitting(false);
    }
  };

  const submitReset = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (password.length < 8) {
      setError('Пароль должен содержать не менее 8 символов');
      return;
    }

    if (password !== passwordRepeat) {
      setError('Пароли не совпадают');
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      await authApi.resetPassword(resetToken.trim(), password);
      setMessage('Пароль изменён. Теперь можно войти.');
      setMode('login');
      setPassword('');
      setPasswordRepeat('');
    } catch (caught: unknown) {
      setError(readableError(caught, 'Не удалось изменить пароль'));
    } finally {
      setIsSubmitting(false);
    }
  };

  const submitVerify = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsSubmitting(true);
    setError(null);

    try {
      await authApi.verifyEmail(verifyToken.trim());
      setMessage('Адрес подтверждён. Войдите в свой аккаунт.');
      setMode('login');
    } catch (caught: unknown) {
      setError(readableError(caught, 'Не удалось подтвердить адрес'));
    } finally {
      setIsSubmitting(false);
    }
  };

  const submitGuest = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = displayName.trim();

    if (name.length < 2) {
      setError('Введите имя из двух или более символов');
      return;
    }

    onGuest(name);
  };

  return (
    <main className="auth-shell">
      <div aria-hidden="true" className="auth-shell__glow auth-shell__glow--one" />
      <div aria-hidden="true" className="auth-shell__glow auth-shell__glow--two" />
      <section className="auth-intro">
        <Logo />
        <div className="auth-intro__copy">
          <span className="eyebrow">Клубная карточная игра</span>
          <h1>Партия, в которой важен каждый заказ</h1>
          <p>
            Продумывайте раунды, управляйте джокером и ведите точный счёт — вместе за одним
            виртуальным столом.
          </p>
        </div>
        <div className="auth-intro__cards" aria-hidden="true">
          <span>7♠</span>
          <span>A♥</span>
          <span>K♣</span>
        </div>
        <p className="auth-intro__footer">3 · 4 · 6 игроков</p>
      </section>

      <section className="auth-panel">
        <div className="auth-card">
          {mode === 'login' ? (
            <>
              <header className="auth-card__header">
                <span className="eyebrow">С возвращением</span>
                <h2>Войти в клуб</h2>
                <p>Продолжите незавершённую партию или начните новую.</p>
              </header>
              <form className="form-stack" onSubmit={submitLogin}>
                <label className="field">
                  <span>Электронная почта</span>
                  <input
                    autoComplete="email"
                    onChange={(event) => setEmail(event.currentTarget.value)}
                    placeholder="name@example.ru"
                    required
                    type="email"
                    value={email}
                  />
                </label>
                <label className="field">
                  <span>Пароль</span>
                  <span className="field__password">
                    <input
                      autoComplete="current-password"
                      onChange={(event) => setPassword(event.currentTarget.value)}
                      placeholder="Ваш пароль"
                      required
                      type={showPassword ? 'text' : 'password'}
                      value={password}
                    />
                    <button
                      aria-label={showPassword ? 'Скрыть пароль' : 'Показать пароль'}
                      onClick={() => setShowPassword((current) => !current)}
                      type="button"
                    >
                      {showPassword ? 'Скрыть' : 'Показать'}
                    </button>
                  </span>
                </label>
                <button
                  className="auth-link auth-link--right"
                  onClick={() => switchMode('forgot')}
                  type="button"
                >
                  Забыли пароль?
                </button>
                {error ? <p className="form-message form-message--error">{error}</p> : null}
                {message ? <p className="form-message form-message--success">{message}</p> : null}
                <Button disabled={isSubmitting} type="submit" wide>
                  {isSubmitting ? <Spinner /> : 'Войти'}
                </Button>
              </form>
              <div className="auth-divider">
                <span>или</span>
              </div>
              <Button onClick={() => switchMode('guest')} variant="secondary" wide>
                Продолжить как гость
              </Button>
              <p className="auth-card__switch">
                Впервые здесь?{' '}
                <button onClick={() => switchMode('register')} type="button">
                  Создать аккаунт
                </button>
              </p>
            </>
          ) : null}

          {mode === 'register' ? (
            <>
              <header className="auth-card__header">
                <span className="eyebrow">Новый игрок</span>
                <h2>Создать аккаунт</h2>
                <p>Имя будет видно соперникам за столом.</p>
              </header>
              <form className="form-stack" onSubmit={submitRegister}>
                <label className="field">
                  <span>Имя игрока</span>
                  <input
                    autoComplete="nickname"
                    maxLength={24}
                    minLength={2}
                    onChange={(event) => setDisplayName(event.currentTarget.value)}
                    placeholder="Например, Север"
                    required
                    value={displayName}
                  />
                </label>
                <label className="field">
                  <span>Электронная почта</span>
                  <input
                    autoComplete="email"
                    onChange={(event) => setEmail(event.currentTarget.value)}
                    placeholder="name@example.ru"
                    required
                    type="email"
                    value={email}
                  />
                </label>
                <label className="field">
                  <span>Пароль</span>
                  <input
                    autoComplete="new-password"
                    minLength={8}
                    onChange={(event) => setPassword(event.currentTarget.value)}
                    placeholder="Не менее 8 символов"
                    required
                    type="password"
                    value={password}
                  />
                </label>
                <label className="field">
                  <span>Повторите пароль</span>
                  <input
                    autoComplete="new-password"
                    onChange={(event) => setPasswordRepeat(event.currentTarget.value)}
                    placeholder="Ещё раз"
                    required
                    type="password"
                    value={passwordRepeat}
                  />
                </label>
                {error ? <p className="form-message form-message--error">{error}</p> : null}
                <Button disabled={isSubmitting} type="submit" wide>
                  {isSubmitting ? <Spinner /> : 'Создать аккаунт'}
                </Button>
              </form>
              <p className="auth-card__switch">
                Уже есть аккаунт?{' '}
                <button onClick={() => switchMode('login')} type="button">
                  Войти
                </button>
              </p>
            </>
          ) : null}

          {mode === 'forgot' ? (
            <>
              <header className="auth-card__header">
                <span className="eyebrow">Восстановление</span>
                <h2>Вернуть доступ</h2>
                <p>Отправим ссылку на адрес, связанный с аккаунтом.</p>
              </header>
              <form className="form-stack" onSubmit={submitForgot}>
                <label className="field">
                  <span>Электронная почта</span>
                  <input
                    autoComplete="email"
                    onChange={(event) => setEmail(event.currentTarget.value)}
                    placeholder="name@example.ru"
                    required
                    type="email"
                    value={email}
                  />
                </label>
                {error ? <p className="form-message form-message--error">{error}</p> : null}
                {message ? <p className="form-message form-message--success">{message}</p> : null}
                <Button disabled={isSubmitting} type="submit" wide>
                  {isSubmitting ? <Spinner /> : 'Отправить ссылку'}
                </Button>
                <Button onClick={() => switchMode('reset')} variant="ghost" wide>
                  У меня есть код сброса
                </Button>
              </form>
              <button className="auth-back" onClick={() => switchMode('login')} type="button">
                ← Вернуться ко входу
              </button>
            </>
          ) : null}

          {mode === 'reset' ? (
            <>
              <header className="auth-card__header">
                <span className="eyebrow">Новый пароль</span>
                <h2>Сменить пароль</h2>
                <p>Введите код из ссылки и придумайте новый пароль.</p>
              </header>
              <form className="form-stack" onSubmit={submitReset}>
                <label className="field">
                  <span>Код сброса</span>
                  <input
                    onChange={(event) => setResetToken(event.currentTarget.value)}
                    placeholder="Код из письма"
                    required
                    value={resetToken}
                  />
                </label>
                <label className="field">
                  <span>Новый пароль</span>
                  <input
                    autoComplete="new-password"
                    minLength={8}
                    onChange={(event) => setPassword(event.currentTarget.value)}
                    required
                    type="password"
                    value={password}
                  />
                </label>
                <label className="field">
                  <span>Повторите пароль</span>
                  <input
                    autoComplete="new-password"
                    onChange={(event) => setPasswordRepeat(event.currentTarget.value)}
                    required
                    type="password"
                    value={passwordRepeat}
                  />
                </label>
                {error ? <p className="form-message form-message--error">{error}</p> : null}
                <Button disabled={isSubmitting} type="submit" wide>
                  {isSubmitting ? <Spinner /> : 'Сохранить новый пароль'}
                </Button>
              </form>
              <button className="auth-back" onClick={() => switchMode('login')} type="button">
                ← Вернуться ко входу
              </button>
            </>
          ) : null}

          {mode === 'verify' ? (
            <>
              <header className="auth-card__header">
                <span className="eyebrow">Подтверждение</span>
                <h2>Подтвердить почту</h2>
                <p>Код находится в ссылке из приветственного письма.</p>
              </header>
              <form className="form-stack" onSubmit={submitVerify}>
                <label className="field">
                  <span>Код подтверждения</span>
                  <input
                    onChange={(event) => setVerifyToken(event.currentTarget.value)}
                    placeholder="Код из письма"
                    required
                    value={verifyToken}
                  />
                </label>
                {error ? <p className="form-message form-message--error">{error}</p> : null}
                {message ? <p className="form-message form-message--success">{message}</p> : null}
                <Button disabled={isSubmitting} type="submit" wide>
                  {isSubmitting ? <Spinner /> : 'Подтвердить адрес'}
                </Button>
              </form>
              <button className="auth-back" onClick={() => switchMode('login')} type="button">
                ← Вернуться ко входу
              </button>
            </>
          ) : null}

          {mode === 'guest' ? (
            <>
              <header className="auth-card__header">
                <span className="eyebrow">Быстрый вход</span>
                <h2>Играть гостем</h2>
                <p>Прогресс сохранится только на этом устройстве.</p>
              </header>
              <form className="form-stack" onSubmit={submitGuest}>
                <label className="field">
                  <span>Имя за столом</span>
                  <input
                    autoFocus
                    maxLength={24}
                    minLength={2}
                    onChange={(event) => setDisplayName(event.currentTarget.value)}
                    placeholder="Как к вам обращаться?"
                    required
                    value={displayName}
                  />
                </label>
                {error ? <p className="form-message form-message--error">{error}</p> : null}
                <Button type="submit" wide>
                  Войти в лобби
                </Button>
              </form>
              <button className="auth-back" onClick={() => switchMode('login')} type="button">
                ← Вернуться ко входу
              </button>
            </>
          ) : null}
        </div>
        <p className="auth-legal">Продолжая, вы соглашаетесь с правилами честной игры.</p>
      </section>
    </main>
  );
}
