/**
 * ui — <AppRoot/>: language provider + the shell (header with project name / language toggle /
 * save-load, left tabs Part / Tools / Machine, centre 3D viewport + section + transport bar,
 * right tabs Sequence / Program, toasts, keyboard shortcuts). See docs/specs/ui.md §3.
 */
import { useEffect, useRef } from 'react';
import { SimViewport, SectionView, TransportBar, useSimStore } from '../sim';
import { LanguageProvider, useI18n } from '../i18n';
import { useProjectStore, selectMachine } from './store';
import type { LeftTab, RightTab } from './store';
import { Tabs } from './components/Tabs';
import { Toasts } from './components/Toasts';
import { PartPanel } from './panels/PartPanel';
import { ToolsPanel } from './panels/ToolsPanel';
import { MachinePanel } from './panels/MachinePanel';
import { SequencePanel } from './panels/SequencePanel';
import { ProgramPanel } from './panels/ProgramPanel';
import { AppError, downloadText, safeFileName } from './project';

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.closest !== 'function') return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'BUTTON' || el.isContentEditable) return true;
  return el.closest('[role="dialog"]') !== null;
}

function Header() {
  const { t, lang, setLanguage } = useI18n();
  const name = useProjectStore(s => s.project.name);
  const actions = useProjectStore.getState();
  const loadInput = useRef<HTMLInputElement>(null);

  const onLoad = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    try {
      actions.loadProject(await file.text());
    } catch (err) {
      actions.notify(err instanceof AppError ? err.toMessage() : { key: 'errors.app.invalidProject', severity: 'error' }, 'error');
    }
  };

  return (
    <header className="app-header">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">⌐</span>
        <span className="brand-name">{t('app.name')}</span>
      </div>
      <label className="field field-grow project-name">
        <span className="field-label sr-only">{t('app.projectName')}</span>
        <input type="text" value={name} placeholder={t('app.untitled')} onChange={e => actions.setProjectName(e.target.value)} data-testid="project-name" />
      </label>
      <div className="header-actions">
        <button type="button" className="btn" data-testid="new-project" onClick={() => { if (!useProjectStore.getState().project.part || window.confirm(t('app.newConfirm'))) actions.newProject(); }}>{t('app.new')}</button>
        <button type="button" className="btn" data-testid="save-project" onClick={() => downloadText(`${safeFileName(useProjectStore.getState().project.name, 'project')}.pbsim.json`, actions.saveProject())}>{t('app.save')}</button>
        <label className="btn">
          {t('app.load')}
          <input ref={loadInput} type="file" accept=".json,application/json" hidden data-testid="load-project" onChange={() => { const f = loadInput.current?.files?.[0]; if (loadInput.current) loadInput.current.value = ''; void onLoad(f); }} />
        </label>
        <button
          type="button"
          className="btn btn-lang"
          data-testid="language-toggle"
          aria-label={t('app.language')}
          title={t('app.language')}
          onClick={() => setLanguage(lang === 'en' ? 'th' : 'en')}
        >
          <span className={lang === 'en' ? 'lang-on' : ''}>EN</span> / <span className={lang === 'th' ? 'lang-on' : ''}>ไทย</span>
        </button>
      </div>
    </header>
  );
}

function AppShell() {
  const { t, lang } = useI18n();
  const part = useProjectStore(s => s.project.part);
  const program = useProjectStore(s => s.project.program);
  const setup = useProjectStore(s => s.project.setup);
  const machine = useProjectStore(selectMachine);
  const simLibrary = useProjectStore(s => s.simLibrary);
  const leftTab = useProjectStore(s => s.activeLeftTab);
  const rightTab = useProjectStore(s => s.activeRightTab);
  const setLeftTab = useProjectStore(s => s.setLeftTab);
  const setRightTab = useProjectStore(s => s.setRightTab);
  const showSection = useSimStore(s => s.showSection);
  const stepCount = program?.steps.length ?? 0;

  useEffect(() => { void useProjectStore.getState().loadLibrary(); }, []);
  useEffect(() => { document.documentElement.lang = lang; }, [lang]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (isTypingTarget(e.target)) return;
      const sim = useSimStore.getState();
      if (e.code === 'Space') { e.preventDefault(); if (sim.keyframes.length) sim.toggle(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); sim.stepPhase(-1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); sim.stepPhase(1); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const leftTabs: Array<{ id: LeftTab; label: string; testId: string }> = [
    { id: 'part', label: t('app.tab.part'), testId: 'tab-part' },
    { id: 'tools', label: t('app.tab.tools'), testId: 'tab-tools' },
    { id: 'machine', label: t('app.tab.machine'), testId: 'tab-machine' },
  ];
  const rightTabs: Array<{ id: RightTab; label: string; testId: string; badge?: number }> = [
    { id: 'sequence', label: t('app.tab.sequence'), testId: 'tab-sequence', badge: stepCount },
    { id: 'program', label: t('app.tab.program'), testId: 'tab-program' },
  ];

  return (
    <div className="app">
      <Header />
      <div className="app-body">
        <aside className="col col-left">
          <Tabs tabs={leftTabs} active={leftTab} onChange={setLeftTab} />
          <div className="col-scroll">
            {leftTab === 'part' && <PartPanel />}
            {leftTab === 'tools' && <ToolsPanel />}
            {leftTab === 'machine' && <MachinePanel />}
          </div>
        </aside>
        <main className="col col-centre">
          <div className="viewport-frame" aria-label={t('app.viewport')}>
            <SimViewport part={part} program={program} machine={machine} library={simLibrary} setup={setup} t={t} sectionInset={false} className="viewport" />
          </div>
          {showSection && (
            <div className="section-frame" aria-label={t('app.sectionView')}>
              <SectionView part={part} program={program} machine={machine} library={simLibrary} setup={setup} t={t} className="section" />
            </div>
          )}
          <TransportBar t={t} program={program} hideSteps className="transport" />
          <p className="shortcuts small muted">{t('app.shortcuts')}</p>
        </main>
        <aside className="col col-right">
          <Tabs tabs={rightTabs} active={rightTab} onChange={setRightTab} />
          <div className="col-scroll">
            {rightTab === 'sequence' && <SequencePanel />}
            {rightTab === 'program' && <ProgramPanel />}
          </div>
        </aside>
      </div>
      <Toasts />
    </div>
  );
}

/** The application root (the integrator mounts this from main.tsx). */
export function AppRoot() {
  const language = useProjectStore(s => s.project.language);
  const setLanguage = useProjectStore(s => s.setLanguage);
  return (
    <LanguageProvider language={language} onChange={setLanguage}>
      <AppShell />
    </LanguageProvider>
  );
}

export default AppRoot;
