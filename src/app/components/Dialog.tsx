/** ui — modal dialog (overlay + panel), closes on Escape / backdrop click. */
import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { useI18n } from '../../i18n';

export interface DialogProps {
  title: string;
  onClose: () => void;
  children?: ReactNode;
  footer?: ReactNode;
  testId?: string | undefined;
  wide?: boolean | undefined;
}

export function Dialog({ title, onClose, children, footer, testId, wide }: DialogProps) {
  const { t } = useI18n();
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return (
    <div className="dialog-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={wide ? 'dialog dialog-wide' : 'dialog'} role="dialog" aria-modal="true" aria-label={title} data-testid={testId}>
        <div className="dialog-header">
          <h2 className="dialog-title">{title}</h2>
          <button type="button" className="btn btn-ghost" onClick={onClose} aria-label={t('common.close')}>✕</button>
        </div>
        <div className="dialog-body">{children}</div>
        {footer && <div className="dialog-footer">{footer}</div>}
      </div>
    </div>
  );
}
