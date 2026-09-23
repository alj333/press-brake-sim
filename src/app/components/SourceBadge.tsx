/** ui — small provenance badge for a bend attribute (dxf / step / mesh / user / default). */
import type { BendSource } from '../../core/types';
import { useI18n } from '../../i18n';

export function SourceBadge({ source }: { source: BendSource }) {
  const { t } = useI18n();
  const label = t(`source.${source}`);
  return (
    <span className={`badge badge-${source}`} title={t('source.title', { source: label })} aria-label={t('source.title', { source: label })}>
      {label}
    </span>
  );
}
