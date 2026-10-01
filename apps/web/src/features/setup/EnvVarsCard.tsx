import { useEffect, useId, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { listProjectEnv, patchProjectEnv, type ProjectEnvVar } from '../../api/deployment-api';
import { Keycap } from '../../components/ui/Keycap';
import { errorMessage, serverReason, useI18n } from '../../i18n/I18nProvider';
import { relativeTime } from '../dashboard/format';
import { envSource, loadEnvPlan, looksSecret, parseDotEnv, type EnvPlan, type EnvSource } from './env-plan';

/** 서버 계약과 같은 이름 규칙 (packages/contracts env.ts). */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const NAME_MAX = 128;
const VALUE_MAX = 4096;
const DOTENV_MAX_BYTES = 256 * 1024;

interface Row {
  name: string;
  /** 프로젝트에 등록한 값. 없으면 서버가 fallback으로 채운다. */
  registered: ProjectEnvVar | null;
  /** 등록하지 않았을 때 무엇으로 채워지는지. null이면 분석이 찾지 못한 이름(앱에 전달되지 않음) */
  source: EnvSource | null;
  /** 등록하지 않았을 때 쓰이는 값. 화면에서 알 수 없으면 null */
  fallback: string | null;
}

/**
 * 프로젝트 환경변수 (DAT-01, #155). 최근 배포의 분석 결과에 따라 세 묶음으로 보여 준다:
 * 입력 필요(등록해야 배포됨) · 기본값(분석기가 .env.example에서 찾음) · 자동(플랫폼이 넣어 줌).
 * 등록한 값은 평문으로 저장되고 다음 배포부터 적용된다. 값을 대신 지어내 등록하지 않는다.
 */
export function EnvVarsCard({ projectId, awsRegion }: { projectId: string | null; /** AWS_REGION 자동 값 표시용 */ awsRegion: string | null }) {
  const { t } = useI18n();
  const copy = t.setup.env;
  const ids = { name: useId(), value: useId() };
  const fileInput = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<ProjectEnvVar[] | null>(null);
  const [plan, setPlan] = useState<EnvPlan | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [editing, setEditing] = useState<{ name: string; value: string; fixedName: boolean } | null>(null);
  const [revealed, setRevealed] = useState<ReadonlySet<string>>(new Set());
  const [pendingImport, setPendingImport] = useState<{ vars: Record<string, string>; skipped: number } | null>(null);
  const [importError, setImportError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<unknown>(null);

  useEffect(() => {
    if (!projectId) return;
    let active = true;
    setItems(null); setPlan(null); setLoadError(null); setEditing(null); setPendingImport(null);
    listProjectEnv(projectId).then((list) => { if (active) setItems(list); }, (error) => { if (active) setLoadError(error); });
    loadEnvPlan(projectId).then((next) => { if (active) setPlan(next); }, () => { /* 분석 결과를 못 읽으면 등록한 값만 보여 준다 */ });
    return () => { active = false; };
  }, [projectId]);

  if (!projectId) return <p>{t.setup.needsApp}</p>;

  async function apply(vars: Record<string, string | null>) {
    if (!projectId || saving) return false;
    setSaving(true);
    setSaveError(null);
    try { setItems(await patchProjectEnv(projectId, vars)); return true; } catch (error) { setSaveError(error); return false; } finally { setSaving(false); }
  }

  async function submitEdit(event: FormEvent) {
    event.preventDefault();
    if (!editing) return;
    const name = editing.name.trim();
    if (!ENV_NAME.test(name)) return;
    if (await apply({ [name]: editing.value })) setEditing(null);
  }

  async function pickFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    setImportError(false);
    setPendingImport(null);
    if (!file) return;
    if (file.size > DOTENV_MAX_BYTES) { setImportError(true); return; }
    const parsed = parseDotEnv(await file.text());
    if (Object.keys(parsed.vars).length === 0) { setImportError(true); return; }
    setPendingImport(parsed);
  }

  const fallbackOf = (name: string, source: EnvSource): string | null => {
    if (source === 'default') return plan?.defaults[name] ?? null;
    if (source !== 'auto') return null;
    if (name === 'PORT') return plan?.port != null ? String(plan.port) : null;
    if (name === 'NODE_ENV') return 'production';
    if (name === 'AWS_REGION') return awsRegion;
    return null; // DEPLOY_TARGET은 배포할 때 고른 대상에 따라 정해진다
  };

  const registered = items ?? [];
  const rows: Row[] = [
    ...(plan?.names ?? []).map((name): Row => {
      const source = envSource(name, plan!);
      return { name, registered: registered.find((item) => item.name === name) ?? null, source, fallback: fallbackOf(name, source) };
    }),
    ...registered.filter((item) => !plan?.names.includes(item.name)).map((item): Row => ({ name: item.name, registered: item, source: null, fallback: null })),
  ];
  const sections: Array<{ key: 'required' | 'default' | 'auto' | 'extra'; rows: Row[] }> = plan
    ? [
      { key: 'required' as const, rows: rows.filter((row) => row.source === 'required') },
      { key: 'default' as const, rows: rows.filter((row) => row.source === 'default') },
      { key: 'auto' as const, rows: rows.filter((row) => row.source === 'auto') },
      { key: 'extra' as const, rows: rows.filter((row) => row.source === null) },
    ].filter((section) => section.rows.length > 0)
    : rows.length > 0 ? [{ key: 'extra', rows }] : [];
  const missing = rows.filter((row) => row.source === 'required' && row.registered === null);

  const editName = editing?.name.trim() ?? '';
  const editNameInvalid = editName !== '' && !ENV_NAME.test(editName);
  const importNames = pendingImport ? Object.keys(pendingImport.vars) : [];
  const now = Date.now();

  function valueCell(row: Row) {
    if (row.registered) {
      const shown = revealed.has(row.name);
      return <span className="env-table__value">
        <code>{shown ? (row.registered.value === '' ? copy.emptyValue : row.registered.value) : '••••••••'}</code>
        <button type="button" className="env-table__reveal" aria-pressed={shown} aria-label={shown ? copy.hideLabel(row.name) : copy.showLabel(row.name)}
          onClick={() => setRevealed((current) => { const next = new Set(current); if (shown) next.delete(row.name); else next.add(row.name); return next; })}>{shown ? copy.hide : copy.show}</button>
      </span>;
    }
    if (row.source === 'required') return <span className="env-table__missing">{copy.notRegistered}</span>;
    if (row.fallback !== null) return <code>{row.fallback}</code>;
    return <span className="env-table__hint">{row.name === 'DEPLOY_TARGET' ? copy.autoTarget : copy.autoUnknown}</span>;
  }

  function badge(row: Row) {
    if (row.registered && row.source !== null && row.source !== 'required') return <span className="env-badge is-custom">{copy.badge.custom}</span>;
    if (row.source === 'required') return <span className={`env-badge ${row.registered ? 'is-ok' : 'is-required'}`}>{row.registered ? copy.badge.registered : copy.badge.required}</span>;
    if (row.source === 'default') return <span className="env-badge">{copy.badge.default}</span>;
    if (row.source === 'auto') return <span className="env-badge">{copy.badge.auto}</span>;
    return <span className="env-badge">{copy.badge.extra}</span>;
  }

  return <>
    <div className="env-head">
      <p>{copy.copy}</p>
      <div className="env-head__actions">
        <input ref={fileInput} type="file" className="visually-hidden" tabIndex={-1} aria-hidden="true" onChange={(event) => void pickFile(event)} />
        <Keycap variant="secondary" disabled={saving || items === null} onClick={() => fileInput.current?.click()}>{copy.importFile}</Keycap>
        <Keycap variant="secondary" disabled={saving || items === null} onClick={() => setEditing({ name: '', value: '', fixedName: false })}>{copy.add}</Keycap>
      </div>
    </div>

    {loadError !== null && <div className="notice error" role="alert">{errorMessage(loadError, t, copy.loadError)}</div>}
    {items === null && loadError === null && <p role="status">{copy.loading}</p>}
    {missing.length > 0 && <div className="notice error" role="alert"><strong>{copy.missingTitle(missing.length)}</strong><br />{copy.missingCopy}</div>}
    {importError && <div className="notice error" role="alert">{copy.importInvalid}</div>}

    {pendingImport && <div className="notice env-import">
      <strong>{copy.importTitle(importNames.length)}</strong>
      <p><code>{importNames.join(', ')}</code></p>
      {pendingImport.skipped > 0 && <p>{copy.importSkipped(pendingImport.skipped)}</p>}
      {importNames.some(looksSecret) && <p className="env-warning">{copy.secretWarning(importNames.filter(looksSecret).join(', '))}</p>}
      <div className="aws-key-form__actions">
        <Keycap variant="secondary" disabled={saving} onClick={() => void apply(pendingImport.vars).then((ok) => { if (ok) setPendingImport(null); })}>{saving ? t.deploy.aws.saving : copy.importConfirm}</Keycap>
        <Keycap variant="ghost" disabled={saving} onClick={() => setPendingImport(null)}>{t.deploy.aws.cancel}</Keycap>
      </div>
    </div>}

    {editing && <form className="aws-key-form env-edit" onSubmit={(event) => void submitEdit(event)} autoComplete="off">
      <div className="aws-key-form__field">
        <label htmlFor={ids.name}>{copy.name}</label>
        <input id={ids.name} value={editing.name} onChange={(event) => setEditing({ ...editing, name: event.target.value })} maxLength={NAME_MAX} readOnly={editing.fixedName}
          autoFocus={!editing.fixedName} autoComplete="off" spellCheck={false} disabled={saving} aria-invalid={editNameInvalid} />
      </div>
      <div className="aws-key-form__field">
        <label htmlFor={ids.value}>{copy.value}</label>
        <input id={ids.value} value={editing.value} onChange={(event) => setEditing({ ...editing, value: event.target.value })} maxLength={VALUE_MAX}
          autoFocus={editing.fixedName} autoComplete="off" spellCheck={false} disabled={saving} />
      </div>
      <p className={`aws-key-form__note ${looksSecret(editName) && !editNameInvalid ? 'env-warning' : ''}`}>
        {editNameInvalid ? copy.nameInvalid : looksSecret(editName) ? copy.secretWarning(editName) : copy.note}
      </p>
      <div className="aws-key-form__actions">
        <Keycap type="submit" variant="secondary" disabled={saving || !editName || editNameInvalid}>{saving ? t.deploy.aws.saving : copy.save}</Keycap>
        <Keycap variant="ghost" disabled={saving} onClick={() => setEditing(null)}>{t.deploy.aws.cancel}</Keycap>
      </div>
    </form>}
    {saveError !== null && <div className="notice error" role="alert"><strong>{copy.saveError}</strong><br />
      {serverReason(saveError, t, copy.saveError)}</div>}

    {items !== null && sections.length === 0 && <p>{copy.empty}</p>}
    {items !== null && plan === null && <p className="aws-key-form__note">{copy.noAnalysis}</p>}

    {sections.map((section) => <section key={section.key} className="env-section" aria-label={copy.sections[section.key].title}>
      <h3>{copy.sections[section.key].title} <span className="env-section__count">{section.rows.length}</span></h3>
      <p>{copy.sections[section.key].copy}</p>
      <div className="env-table-wrap"><table className="env-table">
        <thead><tr><th scope="col">{copy.name}</th><th scope="col">{copy.value}</th><th scope="col">{copy.kind}</th><th scope="col">{copy.updated}</th><th scope="col"><span className="visually-hidden">{copy.actions}</span></th></tr></thead>
        <tbody>{section.rows.map((row) => <tr key={row.name} className={row.source === 'required' && !row.registered ? 'is-missing' : ''}>
          <th scope="row"><code>{row.name}</code></th>
          <td>{valueCell(row)}</td>
          <td>{badge(row)}</td>
          <td>{row.registered?.updatedAt ? relativeTime(row.registered.updatedAt, now, t) : '—'}</td>
          <td className="env-table__actions">
            {/* 자동 값은 참고용이다. 이미 직접 등록한 경우에만 고치거나 되돌릴 수 있다. */}
            {(row.source !== 'auto' || row.registered) && <Keycap variant="ghost" disabled={saving} aria-label={copy.editLabel(row.name)}
              onClick={() => setEditing({ name: row.name, value: row.registered?.value ?? row.fallback ?? '', fixedName: true })}>{row.registered || row.source !== 'required' ? copy.edit : copy.enter}</Keycap>}
            {row.registered && <Keycap variant="ghost" disabled={saving} aria-label={row.source === 'default' || row.source === 'auto' ? copy.resetLabel(row.name) : copy.removeLabel(row.name)}
              onClick={() => void apply({ [row.name]: null })}>{row.source === 'default' || row.source === 'auto' ? copy.reset : copy.remove}</Keycap>}
          </td>
        </tr>)}</tbody>
      </table></div>
    </section>)}
  </>;
}
