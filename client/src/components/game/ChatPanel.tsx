import { type FormEvent, useEffect, useRef, useState } from 'react';
import type { ChatMessage } from '../../types/game';
import { Avatar, Button } from '../ui';

interface ChatPanelProps {
  messages: ChatMessage[];
  currentUserId: string;
  onSend: (text: string) => boolean;
  onClose?: () => void;
  compact?: boolean;
  /** Server rule: chat only when ≥2 live humans */
  chatEnabled?: boolean;
}

const timeFormatter = new Intl.DateTimeFormat('ru-RU', {
  hour: '2-digit',
  minute: '2-digit',
});

function formatTime(value: string): string {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return '';
  }

  return timeFormatter.format(date);
}

export function ChatPanel({
  chatEnabled = true,
  compact = false,
  currentUserId,
  messages,
  onClose,
  onSend,
}: ChatPanelProps) {
  const [text, setText] = useState('');
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const list = listRef.current;

    if (!list) {
      return;
    }

    list.scrollTo({
      behavior: 'smooth',
      top: list.scrollHeight,
    });
  }, [messages]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalizedText = text.trim();

    if (!normalizedText) {
      return;
    }

    if (onSend(normalizedText)) {
      setText('');
    }
  };

  return (
    <aside className={`chat-panel ${compact ? 'chat-panel--compact' : ''}`}>
      <header className="panel-header">
        <div>
          <span aria-hidden="true">✦</span>
          <strong>Чат стола</strong>
        </div>
        {onClose ? (
          <button aria-label="Закрыть чат" className="icon-button" onClick={onClose} type="button">
            ×
          </button>
        ) : null}
      </header>
      <div className="chat-messages" ref={listRef}>
        {!chatEnabled ? (
          <div className="chat-empty">
            <span aria-hidden="true">♣</span>
            <p>Чат откроется, когда за столом будет минимум двое живых игроков.</p>
          </div>
        ) : messages.length === 0 ? (
          <div className="chat-empty">
            <span aria-hidden="true">♣</span>
            <p>Здесь появятся сообщения игроков.</p>
          </div>
        ) : (
          messages.map((message) => {
            const isOwn = message.userId === currentUserId;

            return (
              <article
                className={`chat-message ${isOwn ? 'chat-message--own' : ''}`}
                key={message.id}
              >
                {!isOwn ? <Avatar name={message.userName} size="small" /> : null}
                <div>
                  <header>
                    <strong>{isOwn ? 'Вы' : message.userName}</strong>
                    <time dateTime={message.createdAt}>{formatTime(message.createdAt)}</time>
                  </header>
                  <p>{message.text}</p>
                </div>
              </article>
            );
          })
        )}
      </div>
      <form className="chat-compose" onSubmit={submit}>
        <input
          aria-label="Сообщение"
          disabled={!chatEnabled}
          maxLength={400}
          onChange={(event) => setText(event.currentTarget.value)}
          placeholder={chatEnabled ? 'Сообщение столу…' : 'Чат недоступен'}
          value={text}
        />
        <Button
          aria-label="Отправить сообщение"
          disabled={!chatEnabled || !text.trim()}
          type="submit"
        >
          ↑
        </Button>
      </form>
    </aside>
  );
}
