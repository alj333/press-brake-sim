/** ui — toast notices from the project store (bottom right). */
import { useI18n } from '../../i18n';
import { useProjectStore } from '../store';

export function Toasts() {
  const notices = useProjectStore(s => s.notices);
  const dismiss = useProjectStore(s => s.dismissNotice);
  const { tm, t } = useI18n();
  if (notices.length === 0) return null;
  return (
    <div className="toasts" aria-live="polite">
      {notices.map(n => (
        <div key={n.id} className={`toast toast-${n.severity}`} role="status">
          <span className="toast-text">{tm(n.message)}</span>
          <button type="button" className="btn btn-ghost toast-close" onClick={() => dismiss(n.id)} aria-label={t('app.dismiss')}>✕</button>
        </div>
      ))}
    </div>
  );
}
