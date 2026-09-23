/** ui — renders core `Message` objects through tm() with a severity icon; optional click handler. */
import type { Message } from '../../core/types';
import { useI18n } from '../../i18n';

export interface MessageListProps {
  messages: readonly Message[];
  onClick?: ((message: Message, index: number) => void) | undefined;
  className?: string | undefined;
  /** Hide 'info' messages. */
  hideInfo?: boolean | undefined;
  emptyText?: string | undefined;
  testId?: string | undefined;
}

function severityOf(m: Message): 'info' | 'warning' | 'error' {
  return m.severity === 'error' ? 'error' : m.severity === 'info' ? 'info' : 'warning';
}

const ICON = { info: 'ⓘ', warning: '⚠', error: '✖' } as const;

export function MessageList({ messages, onClick, className, hideInfo, emptyText, testId }: MessageListProps) {
  const { tm, t } = useI18n();
  const shown = hideInfo ? messages.filter(m => severityOf(m) !== 'info') : messages;
  if (shown.length === 0) {
    return emptyText ? <p className={className ? `messages-empty ${className}` : 'messages-empty'}>{emptyText}</p> : null;
  }
  return (
    <ul className={className ? `messages ${className}` : 'messages'} data-testid={testId}>
      {shown.map((m, i) => {
        const sev = severityOf(m);
        const text = tm(m);
        const content = (
          <>
            <span className={`msg-icon msg-icon-${sev}`} title={t(`severity.${sev}`)} aria-label={t(`severity.${sev}`)}>{ICON[sev]}</span>
            <span className="msg-text">{text}</span>
          </>
        );
        return (
          <li key={`${m.key}-${i}`} className={`msg msg-${sev}${onClick ? ' msg-clickable' : ''}`}>
            {onClick ? <button type="button" className="msg-btn" onClick={() => onClick(m, i)}>{content}</button> : content}
          </li>
        );
      })}
    </ul>
  );
}
