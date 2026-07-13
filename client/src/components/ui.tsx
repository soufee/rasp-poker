import { type ButtonHTMLAttributes, type ReactNode, useEffect, useId } from 'react';
import type { ConnectionStatus } from '../types/game';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  wide?: boolean;
}

export function Button({
  children,
  className = '',
  variant = 'primary',
  wide = false,
  type = 'button',
  ...props
}: ButtonProps) {
  const classes = ['button', `button--${variant}`, wide ? 'button--wide' : '', className]
    .filter(Boolean)
    .join(' ');

  return (
    <button className={classes} type={type} {...props}>
      {children}
    </button>
  );
}

interface LogoProps {
  compact?: boolean;
  className?: string;
}

export function Logo({ compact = false, className = '' }: LogoProps) {
  return (
    <img
      alt="Расписной покер"
      className={`logo ${compact ? 'logo--compact' : ''} ${className}`}
      height={compact ? 52 : 64}
      src={compact ? '/assets/logo-mark.svg' : '/assets/logo-horizontal.svg'}
      width={compact ? 52 : 270}
    />
  );
}

interface ModalProps {
  children: ReactNode;
  title: string;
  subtitle?: string;
  onClose?: () => void;
  size?: 'small' | 'medium' | 'large';
}

export function Modal({ children, onClose, size = 'medium', subtitle, title }: ModalProps) {
  const titleId = useId();

  useEffect(() => {
    if (!onClose) {
      return undefined;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

  return (
    <div
      aria-labelledby={titleId}
      aria-modal="true"
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) {
          onClose?.();
        }
      }}
      role="dialog"
    >
      <section className={`modal modal--${size}`}>
        <header className="modal__header">
          <div>
            <h2 id={titleId}>{title}</h2>
            {subtitle ? <p>{subtitle}</p> : null}
          </div>
          {onClose ? (
            <button aria-label="Закрыть" className="icon-button" onClick={onClose} type="button">
              ×
            </button>
          ) : null}
        </header>
        <div className="modal__body">{children}</div>
      </section>
    </div>
  );
}

interface ToggleProps {
  checked: boolean;
  label: string;
  description?: string;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}

export function Toggle({ checked, description, disabled = false, label, onChange }: ToggleProps) {
  return (
    <label className={`toggle-row ${disabled ? 'is-disabled' : ''}`}>
      <span>
        <strong>{label}</strong>
        {description ? <small>{description}</small> : null}
      </span>
      <input
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.checked)}
        type="checkbox"
      />
      <span aria-hidden="true" className="toggle-track">
        <span />
      </span>
    </label>
  );
}

interface ConnectionBadgeProps {
  status: ConnectionStatus;
}

const statusLabels: Record<ConnectionStatus, string> = {
  connected: 'В сети',
  connecting: 'Подключение',
  disconnected: 'Нет связи',
  error: 'Ошибка сети',
  reconnecting: 'Возвращаемся',
};

export function ConnectionBadge({ status }: ConnectionBadgeProps) {
  return (
    <span className={`connection-badge connection-badge--${status}`}>
      <span aria-hidden="true" />
      {statusLabels[status]}
    </span>
  );
}

interface AvatarProps {
  name: string;
  src?: string;
  size?: 'small' | 'medium' | 'large';
}

export function Avatar({ name, size = 'medium', src }: AvatarProps) {
  return (
    <img
      alt={`Аватар: ${name}`}
      className={`avatar avatar--${size}`}
      src={src || '/assets/avatar-placeholder.svg'}
    />
  );
}

export function Spinner() {
  return <span aria-label="Загрузка" className="spinner" role="status" />;
}
