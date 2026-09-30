import { useRef, useState, type DragEvent } from 'react';
import { Keycap } from '../../components/ui/Keycap';
import { useI18n } from '../../i18n/I18nProvider';

interface ZipUploaderProps {
  file: File | null;
  onChange: (file: File | null) => void;
  disabled?: boolean;
}

/** 기존 규칙 그대로 — 확장자가 .zip인 파일만 받는다. */
function acceptZip(file: File | null | undefined): File | null {
  return file?.name.toLowerCase().endsWith('.zip') ? file : null;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function EmptyZipArt() {
  return <svg className="zip-art" width="84" height="72" viewBox="0 0 84 72" aria-hidden="true">
    <path className="zip-art__arrow" d="M42 4 V26" />
    <path className="zip-art__arrow" d="M33 14 L42 4 L51 14" />
    <rect className="zip-art__box" x="14" y="32" width="56" height="34" rx="4" />
    <path className="zip-art__seam" d="M14 44 H70" />
    <path className="zip-art__tape" d="M14 32 L70 66 M70 32 L14 66" />
    <rect className="zip-art__tag" x="30" y="38" width="24" height="12" rx="2" />
    <text className="zip-art__tag-text" x="42" y="47" textAnchor="middle" fontSize="8">ZIP</text>
  </svg>;
}

function ReadyZipArt() {
  return <svg className="zip-art" width="120" height="104" viewBox="0 0 120 104" aria-hidden="true">
    <rect className="zip-art__pad" x="4" y="80" width="112" height="18" rx="6" />
    <rect className="zip-art__pad-base" x="4" y="92" width="112" height="8" rx="4" />
    <rect className="zip-art__box" x="20" y="30" width="80" height="50" rx="5" />
    <path className="zip-art__seam" d="M20 46 H100" />
    <path className="zip-art__tape" d="M20 30 L100 80 M100 30 L20 80" />
    <rect className="zip-art__tag" x="44" y="36" width="32" height="16" rx="2" />
    <text className="zip-art__tag-text" x="60" y="48" textAnchor="middle" fontSize="10">ZIP</text>
    <circle className="zip-art__check-bg" cx="106" cy="20" r="12" />
    <path className="zip-art__check" d="M100 20 L104.5 24.5 L112 16" />
  </svg>;
}

export function ZipUploader({ file, onChange, disabled = false }: ZipUploaderProps) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [rejectedName, setRejectedName] = useState<string | null>(null);

  function select(candidate: File | null | undefined) {
    const accepted = acceptZip(candidate);
    setRejectedName(candidate && !accepted ? candidate.name : null);
    onChange(accepted);
  }

  function openPicker() { inputRef.current?.click(); }

  const dragHandlers = disabled ? {} : {
    onDragEnter: (event: DragEvent<HTMLDivElement>) => { event.preventDefault(); setDragging(true); },
    onDragOver: (event: DragEvent<HTMLDivElement>) => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; },
    onDragLeave: (event: DragEvent<HTMLDivElement>) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
    },
    onDrop: (event: DragEvent<HTMLDivElement>) => { event.preventDefault(); setDragging(false); select(event.dataTransfer.files[0]); },
  };

  return <div className="zip-uploader">
    <input ref={inputRef} className="visually-hidden" type="file" accept=".zip,application/zip" tabIndex={-1} aria-hidden="true"
      disabled={disabled}
      onChange={(event) => { select(event.target.files?.[0]); event.target.value = ''; }} />

    {file
      ? <div className={`dropzone dropzone--ready ${dragging ? 'is-dragging' : ''}`} {...dragHandlers}>
        <ReadyZipArt />
        <div className="dropzone__file">
          <span className="dropzone__file-name">{file.name}</span>
          <span className="dropzone__file-meta">{t.deploy.fileMeta(formatBytes(file.size))}</span>
          <span className="dropzone__file-copy">{t.deploy.fileCopy}</span>
        </div>
        <div className="dropzone__file-actions">
          <Keycap variant="secondary" disabled={disabled} onClick={openPicker}>{t.deploy.replace}</Keycap>
          <Keycap variant="ghost" disabled={disabled} onClick={() => select(null)}>{t.deploy.remove}</Keycap>
        </div>
      </div>
      : <div className={`dropzone dropzone--empty ${dragging ? 'is-dragging' : ''}`} {...dragHandlers}>
        <EmptyZipArt />
        <strong className="dropzone__title">{t.deploy.dropTitle}</strong>
        <div className="dropzone__or">
          <span>{t.deploy.or}</span>
          <Keycap variant="secondary" disabled={disabled} onClick={openPicker}>{t.deploy.choose}</Keycap>
        </div>
        <span className="dropzone__hint">{t.deploy.zipOnly}</span>
      </div>}

    {rejectedName && <p className="zip-uploader__error" role="alert">{t.deploy.rejected(rejectedName)}</p>}
  </div>;
}
