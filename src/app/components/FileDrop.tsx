/** ui — drag & drop zone with two labelled file inputs (3D models and DXF flats). */
import { useRef, useState } from 'react';
import type { DragEvent, ReactNode } from 'react';
import { useI18n } from '../../i18n';

export interface FileDropProps {
  onFiles: (files: File[]) => void;
  disabled?: boolean | undefined;
  children?: ReactNode;
}

export const MODEL_ACCEPT = '.step,.stp,.stl,.obj,.glb,.gltf';
export const DXF_ACCEPT = '.dxf';

export function FileDrop({ onFiles, disabled, children }: FileDropProps) {
  const { t } = useI18n();
  const [over, setOver] = useState(false);
  const modelInput = useRef<HTMLInputElement>(null);
  const dxfInput = useRef<HTMLInputElement>(null);

  const onDrop = (e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault();
    setOver(false);
    if (disabled) return;
    const files = Array.from(e.dataTransfer.files ?? []);
    if (files.length) onFiles(files);
  };

  const pick = (input: HTMLInputElement | null): void => {
    if (!input) return;
    const files = Array.from(input.files ?? []);
    input.value = '';
    if (files.length) onFiles(files);
  };

  return (
    <div
      className={over ? 'filedrop filedrop-over' : 'filedrop'}
      onDragOver={e => { e.preventDefault(); if (!disabled) setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
    >
      <p className="filedrop-hint">{t('part.dropHere')}</p>
      <div className="filedrop-buttons">
        <label className="btn btn-primary">
          {t('part.import3d')}
          <input ref={modelInput} type="file" accept={MODEL_ACCEPT} multiple hidden disabled={disabled} data-testid="import-3d" onChange={() => pick(modelInput.current)} />
        </label>
        <label className="btn">
          {t('part.importDxf')}
          <input ref={dxfInput} type="file" accept={DXF_ACCEPT} hidden disabled={disabled} data-testid="import-dxf" onChange={() => pick(dxfInput.current)} />
        </label>
        {children}
      </div>
    </div>
  );
}
