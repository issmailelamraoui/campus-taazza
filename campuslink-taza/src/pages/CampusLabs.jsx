import React, { useCallback, useDeferredValue, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Braces, ChartLine, CheckCircle2, Code2, Play, Plus, RefreshCw, Save, Square, TerminalSquare, Trash2 } from 'lucide-react';
import { api } from '../api';
import { useApp } from '../context';
import { Button, EmptyState, Field, PageHeader, Tabs } from '../components/ui';
import { Select } from '../components/Select';
import { sampleGraph, MATH_FUNCTIONS } from '../../shared/math';
import { LabsEditor } from '../lib/labs-editor';
import { runLabCode } from '../lib/labs-runner';
import { quotationHint } from '../lib/labs-source-hints';
import './labs.css';

const LANGUAGE_LABELS = { javascript: 'JavaScript', json: 'JSON', python: 'Python', c: 'C', cpp: 'C++' };
const STARTERS = {
  javascript: 'function moyenne(valeurs) {\n  let total = 0;\n  for (const valeur of valeurs) {\n    total += valeur;\n  }\n  return valeurs.length ? total / valeurs.length : 0;\n}\n\nconsole.log(moyenne([12, 14, 16]));\n',
  json: '{\n  "module": "Mon cours",\n  "chapitres": [1, 2, 3]\n}',
  python: 'def moyenne(valeurs):\n    total = 0\n    for valeur in valeurs:\n        total += valeur\n    return total / len(valeurs) if valeurs else 0\n\nprint(moyenne([12, 14, 16]))\n',
  c: '#include <stdio.h>\n\ndouble moyenne(const double valeurs[], int nombre) {\n    double total = 0;\n    for (int i = 0; i < nombre; i++) {\n        total += valeurs[i];\n    }\n    return nombre > 0 ? total / nombre : 0;\n}\n\nint main(void) {\n    double valeurs[] = {12, 14, 16};\n    printf("%g\\n", moyenne(valeurs, 3));\n    return 0;\n}\n',
  cpp: '#include <iostream>\n#include <vector>\n\ndouble moyenne(const std::vector<double>& valeurs) {\n    double total = 0;\n    for (double valeur : valeurs) {\n        total += valeur;\n    }\n    return valeurs.empty() ? 0 : total / valeurs.size();\n}\n\nint main() {\n    std::cout << moyenne({12, 14, 16}) << "\\n";\n    return 0;\n}\n',
};
const starter = language => STARTERS[language] || '';
export default function CampusLabs() {
  const { tr, language: locale, refresh } = useApp();
  const [tab, setTab] = useState('code'), [language, setLanguage] = useState('javascript');
  const [source, setSourceState] = useState(starter('javascript')), [voluntaryXp, setVoluntaryXp] = useState(false);
  const sourceRef = useRef(source);
  const setSource = useCallback(value => {
    sourceRef.current = typeof value === 'function' ? value(sourceRef.current) : value;
    setSourceState(sourceRef.current);
  }, []);
  const [session, setSession] = useState(null), [sessions, setSessions] = useState([]), [languages, setLanguages] = useState(null);
  const [sessionsLoading, setSessionsLoading] = useState(true), [sessionsError, setSessionsError] = useState(''), [sessionsRevision, setSessionsRevision] = useState(0);
  const [executing, setExecuting] = useState(false), [saving, setSaving] = useState(false), [completing, setCompleting] = useState(false);
  const busy = executing || saving || completing;
  const [error, setError] = useState(''), [message, setMessage] = useState('');
  const [editorDocument, setEditorDocument] = useState(0);
  const [editorReplacement, setEditorReplacement] = useState(null);
  const [expression, setExpression] = useState('sin(x)'), [min, setMin] = useState(-10), [max, setMax] = useState(10);
  const [yMin, setYMin] = useState(-2), [yMax, setYMax] = useState(2), [graph, setGraph] = useState(() => ({ points: sampleGraph('sin(x)'), min: -10, max: 10, yMin: -2, yMax: 2, expression: 'sin(x)' }));
  const [graphError, setGraphError] = useState('');
  const graphId = useId().replace(/:/g, '');
  const [output, setOutput] = useState([]), [execution, setExecution] = useState(null), [runPhase, setRunPhase] = useState('idle'), [runtimeProgress, setRuntimeProgress] = useState(0), [input, setInput] = useState('');
  const controller = useRef(null), consoleEnd = useRef(null), outputFrame = useRef(null), queuedOutput = useRef([]);
  const checkRef = useRef(null);
  const runFromEditor = useCallback(() => checkRef.current?.(), []);
  const deferredSource = useDeferredValue(source);
  useEffect(() => () => { controller.current?.abort(); cancelAnimationFrame(outputFrame.current); queuedOutput.current = []; }, []);
  function flushOutput() {
    cancelAnimationFrame(outputFrame.current);
    outputFrame.current = null;
    const batch = queuedOutput.current;
    queuedOutput.current = [];
    if (batch.length) setOutput(previous => {
      const next = previous.slice();
      for (const item of batch) {
        const last = next.at(-1);
        if (last?.stream === item.stream) next[next.length - 1] = { stream: last.stream, text: last.text + item.text };
        else next.push(item);
      }
      return next;
    });
  }
  function appendOutput(item) {
    queuedOutput.current.push({ stream: item.stream, text: item.text });
    if (outputFrame.current === null) outputFrame.current = requestAnimationFrame(flushOutput);
  }
  useEffect(() => { const panel = consoleEnd.current?.parentElement; if (panel) panel.scrollTop = panel.scrollHeight; }, [output, tab]);
  useEffect(() => {
    let active = true; const request = new AbortController();
    setSessionsLoading(true);
    api('/labs', { signal: request.signal }).then(data => {
      if (active) { setSessions(data.sessions || []); setLanguages((data.languages || []).filter(item => Object.hasOwn(LANGUAGE_LABELS, item))); setSessionsError(''); }
    }).catch(err => { if (active && !request.signal.aborted) { setSessionsError(err.message); setLanguages(null); } })
      .finally(() => { if (active) setSessionsLoading(false); });
    return () => { active = false; request.abort(); };
  }, [sessionsRevision]);
  const updateSession = next => {
    setSession(next);
    setSessions(previous => [next, ...previous.filter(item => item.id !== next.id)].slice(0, 20));
  };
  const newSession = () => { setSession(null); setMessage(''); setError(''); setOutput([]); setExecution(null); setEditorReplacement(null); setEditorDocument(previous => previous + 1); };
  const check = async () => {
    const code = sourceRef.current;
    if (busy || controller.current || !code.trim()) return;
    setExecuting(true); setSaving(true); setError(''); setMessage(''); setOutput([]); setExecution(null); setRunPhase('loading'); setRuntimeProgress(0);
    const abort = new AbortController(); controller.current = abort;
    const started = performance.now();
    const save = async () => {
      if (session?.completedAt) return 'completed';
      if (sessionsLoading || sessionsError || !languages) return 'unavailable';
      if (!languages.includes(language)) return 'unsupported';
      let current = session;
      if (!current) { current = (await api('/labs', { method: 'POST', body: { language, voluntaryXp: language === 'javascript' && voluntaryXp } })).session; updateSession(current); }
      const response = await api(`/labs/${current.id}/check`, { method: 'POST', body: { source: code } });
      updateSession(response.session);
      return 'saved';
    };
    const execute = async () => {
      try {
        const result = await runLabCode(language, code, { input, signal: abort.signal, onEvent: event => {
          if (event.type === 'output') appendOutput(event);
          if (event.type === 'phase') setRunPhase(event.phase);
          if (event.type === 'progress') setRuntimeProgress(event.progress);
        } });
        setExecution({ ...result, durationMs: Math.round(performance.now() - started) });
      } catch (err) {
        appendOutput({ stream: 'stderr', text: err.message + '\n' });
        setExecution({ status: 'error', exitCode: null });
      } finally {
        flushOutput(); setRunPhase('idle'); setExecuting(false); controller.current = null;
      }
    };
    const [, saved] = await Promise.allSettled([execute(), save().finally(() => setSaving(false))]);
    if (saved.status === 'rejected') setError(tr('Le code a été lancé, mais la session n’a pas été enregistrée : ', 'Code was launched, but the session could not be saved: ', 'تم تشغيل الشيفرة، لكن تعذّر حفظ الجلسة: ') + saved.reason.message);
    else if (saved.value === 'unavailable') setMessage(tr('Exécution locale uniquement : cette exécution n’a pas été enregistrée. Une fois les sessions disponibles, relancez le code pour l’enregistrer.', 'Local execution only: this run was not saved. Once sessions are available, run the code again to save it.', 'تشغيل محلي فقط: لم يُحفظ هذا التشغيل. بعد توفر الجلسات، شغّل الشيفرة مجدداً لحفظها.'));
    else if (saved.value === 'unsupported') setMessage(tr('Exécution locale uniquement : l’enregistrement n’est pas disponible pour ce langage.', 'Local execution only: saving is unavailable for this language.', 'تشغيل محلي فقط: الحفظ غير متوفر لهذه اللغة.'));
  };
  checkRef.current = check;
  const complete = async () => {
    if (!session || busy) return;
    setCompleting(true); setError('');
    try {
      const result = await api(`/labs/${session.id}/complete`, { method: 'POST', body: {} });
      updateSession(result.session);
      const reasons = {
        more_practice_required: tr('Session enregistrée. Les vérifications doivent couvrir au moins 90 secondes et deux révisions différentes pour être éligibles.', 'Session saved. Checks must span at least 90 seconds and two different revisions to qualify.', 'حُفظت الجلسة. يجب أن تمتد المراجعات 90 ثانية على الأقل وتشمل تعديلين مختلفين للتأهل.'),
        similar_program_already_rewarded: tr('Un programme de structure similaire a déjà reçu ses XP.', 'A program with a similar structure already received XP.', 'سبق منح نقاط لبرنامج ذي بنية مماثلة.'),
        daily_cap_reached: tr('La limite quotidienne de pratique est atteinte.', 'The daily practice limit has been reached.', 'تم بلوغ الحد اليومي للتدريب.'),
        potential_exhausted: tr('Le potentiel de cette session est épuisé. Vos XP précédents sont conservés.', 'This session has no remaining potential. Previously earned XP is preserved.', 'نفد الرصيد المحتمل لهذه الجلسة. تبقى نقاطك السابقة محفوظة.'),
        valid_substantial_program_required: tr('Session enregistrée. Un programme valide et suffisamment développé est nécessaire pour les XP.', 'Session saved. A valid and sufficiently developed program is required for XP.', 'حُفظت الجلسة. يتطلب منح النقاط برنامجاً صالحاً ومطوراً بما يكفي.'),
      };
      setMessage(result.session.rewardedPoints ? tr(`Pratique reconnue : +${result.session.rewardedPoints} XP.`, `Practice recognized: +${result.session.rewardedPoints} XP.`, `تدريب معترف به: +${result.session.rewardedPoints} نقطة.`) : reasons[result.reason] || tr('Session enregistrée.', 'Session saved.', 'حُفظت الجلسة.'));
      await refresh().catch(() => {});
    } catch (err) { setError(err.message); }
    finally { setCompleting(false); }
  };
  const restore = item => { setLanguage(item.language); setSource(item.source || starter(item.language)); setVoluntaryXp(item.language === 'javascript' && !!item.voluntaryXp); setSession(item); setError(''); setMessage(''); setOutput([]); setExecution(null); setEditorReplacement(null); setEditorDocument(previous => previous + 1); };
  const drawGraph = () => {
    setGraphError('');
    try {
      if (!Number.isFinite(yMin) || !Number.isFinite(yMax) || yMin >= yMax || Math.max(Math.abs(yMin), Math.abs(yMax)) > 1e12) throw new Error(tr('Choisissez un intervalle vertical valide.', 'Choose a valid vertical range.', 'اختر نطاقاً رأسياً صالحاً.'));
      setGraph({ points: sampleGraph(expression, min, max), expression, min, max, yMin, yMax });
    } catch (err) { setGraphError(err.message); }
  };
  const geometry = useMemo(() => {
    const sx = x => 50 + (x - graph.min) * 700 / (graph.max - graph.min), sy = y => 370 - (y - graph.yMin) * 330 / (graph.yMax - graph.yMin);
    let path = '', continuous = false, previous;
    for (const point of graph.points) {
      if (point.y === null || point.y < graph.yMin || point.y > graph.yMax) { continuous = false; previous = null; continue; }
      if (previous && Math.abs(previous.y - point.y) > (graph.yMax - graph.yMin) * .6) continuous = false;
      path += `${continuous ? 'L' : 'M'}${sx(point.x).toFixed(2)},${sy(point.y).toFixed(2)} `; continuous = true; previous = point;
    }
    return { path, xAxis: graph.yMin <= 0 && graph.yMax >= 0 ? sy(0) : null, yAxis: graph.min <= 0 && graph.max >= 0 ? sx(0) : null };
  }, [graph]);
  const valid = session?.result?.status === 'valid_syntax';
  const deferredHint = useMemo(() => quotationHint(language, deferredSource), [language, deferredSource]);
  const quoteHint = deferredSource === source ? deferredHint : null;
  const filename = { javascript: 'campus.js', python: 'campus.py', c: 'campus.c', cpp: 'campus.cpp', json: 'campus.json' }[language];
  const consolePlaceholder = executing
    ? ({ loading: tr('Chargement du moteur…', 'Loading runtime…', 'جارٍ تحميل المحرك…'), compiling: tr('Compilation…', 'Compiling…', 'جارٍ ترجمة الشيفرة…'), running: tr('Exécution en cours…', 'Running…', 'جارٍ التشغيل…') })[runPhase]
    : execution
      ? ({ success: tr('Programme terminé sans sortie.', 'Program completed without output.', 'اكتمل البرنامج دون مخرجات.'), stopped: tr('Exécution arrêtée.', 'Execution stopped.', 'توقف التشغيل.'), error: tr('Erreur d’exécution.', 'Execution error.', 'خطأ أثناء التشغيل.'), timeout: tr('Temps limite atteint.', 'Time limit reached.', 'انتهت مهلة التشغيل.') })[execution.status]
      : tr('Les résultats apparaîtront ici.', 'Results appear here.', 'ستظهر النتائج هنا.');
  const outputExample = { javascript: 'console.log("Hello");', python: 'print("Hello")', c: 'printf("Hello\\n");', cpp: 'std::cout << "Hello\\n";' }[language];
  return <div className="labs-page page-enter">
    <PageHeader title={tr('Campus Labs', 'Campus Labs', 'مختبر البرمجة')} />
    <Tabs value={tab} onChange={setTab} items={[{ id: 'code', label: tr('Code', 'Code', 'البرمجة') }, { id: 'graphs', label: tr('Graphiques', 'Graphs', 'الرسوم البيانية') }]} />
    <div className="labs-layout" hidden={tab !== 'code'}>
      <section className="card labs-workspace">
        {sessionsLoading && <p className="muted labs-sessions-loading" role="status">{tr('Chargement de vos sessions privées…', 'Loading your private sessions…', 'جارٍ تحميل جلساتك الخاصة…')}</p>}
        {sessionsError && <div className="labs-alert is-error labs-sessions-error" role="alert"><p>{tr('Sessions privées indisponibles : ', 'Private sessions unavailable: ', 'الجلسات الخاصة غير متوفرة: ')}{sessionsError}</p><Button icon={RefreshCw} disabled={sessionsLoading || busy} onClick={() => setSessionsRevision(value => value + 1)}>{sessionsLoading ? tr('Chargement…', 'Loading…', 'جارٍ التحميل…') : tr('Réessayer le chargement des sessions', 'Retry loading sessions', 'إعادة تحميل الجلسات')}</Button></div>}
        <div className="labs-toolbar">
          <Field label={tr('Langage', 'Language', 'اللغة')}><Select className="input" value={language} disabled={busy} onChange={event => { setLanguage(event.target.value); setSource(starter(event.target.value)); setVoluntaryXp(false); newSession(); setOutput([]); setExecution(null); }}>{Object.entries(LANGUAGE_LABELS).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</Select></Field>
          <Button icon={Plus} disabled={busy} onClick={newSession}>{tr('Nouvelle session', 'New session', 'جلسة جديدة')}</Button>
        </div>
        <div className="labs-code-panels">
          <div className="labs-source-pane">
            <div className="labs-editor-frame">
              <div className="labs-editor-title">
                <span><Code2 size={15} />{filename}</span>
                <div className="labs-run-controls">
                  <span className="labs-shortcut" aria-hidden="true">Ctrl / ⌘ ↵</span>
                  <Button variant="primary" icon={Play} disabled={busy || !source.trim()} onClick={check} aria-keyshortcuts="Control+Enter Meta+Enter">{busy ? executing ? tr('Exécution…', 'Running…', 'جارٍ التشغيل…') : tr('Enregistrement…', 'Saving…', 'جارٍ الحفظ…') : language === 'json' ? tr('Valider et formater', 'Validate and format', 'تحقق ونسّق') : tr('Exécuter', 'Run code', 'تشغيل')}</Button>
                  {executing && <Button icon={Square} onClick={() => controller.current?.abort()}>{tr('Arrêter', 'Stop', 'إيقاف')}</Button>}
                </div>
              </div>
              <LabsEditor key={`${language}:${editorDocument}`} initialValue={source} replacement={editorReplacement} onReplacementApplied={setEditorReplacement} onChange={setSource} language={language} disabled={executing || completing || !!session?.completedAt} label={tr('Votre code', 'Your code', 'شيفرتك')} onRun={runFromEditor} uiLanguage={locale} />
            </div>
            {quoteHint && <div className="labs-source-hint" role="status">
              <p><strong>{tr('Vérifiez les guillemets', 'Check quotation marks', 'تحقّق من علامات الاقتباس')}</strong> · {tr('Ligne', 'Line', 'السطر')} {quoteHint.line}:{quoteHint.column}</p>
              <p>{tr('Utilisez des guillemets droits :', 'Use straight quotation marks:', 'استعمل علامات اقتباس مستقيمة:')} <code dir="ltr">"Hello"</code> ({quoteHint.characters.join(' ')}).</p>
              {quoteHint.correctedSource !== null && <Button disabled={busy || !!session?.completedAt} onClick={() => { if (sourceRef.current !== source) return; setSource(quoteHint.correctedSource); setEditorReplacement({ text: quoteHint.correctedSource }); setExecution(null); setOutput([]); setError(''); setMessage(tr('Guillemets corrigés. Relancez le code.', 'Quotation marks fixed. Run the code again.', 'تم تصحيح علامات الاقتباس. شغّل الشيفرة من جديد.')); }}>{tr('Corriger les guillemets', 'Fix quotation marks', 'تصحيح علامات الاقتباس')}</Button>}
            </div>}
            <details className="labs-input-panel">
              <summary>{tr('Entrées du programme (stdin)', 'Program input (stdin)', 'مدخلات البرنامج (stdin)')}</summary>
              <label className="sr-only" htmlFor="labs-stdin">{tr('Entrées du programme', 'Program input', 'مدخلات البرنامج')}</label>
              <textarea id="labs-stdin" className="input" dir="ltr" value={input} onChange={event => setInput(event.target.value)} maxLength={16000} disabled={busy} placeholder={tr('Une valeur par ligne : input(), scanf(), cin, prompt().', 'One value per line: input(), scanf(), cin, prompt().', 'قيمة في كل سطر: input() أو scanf() أو cin أو prompt().')} />
            </details>
          </div>
          <section className="labs-console" aria-label={tr('Console de sortie', 'Output console', 'وحدة النتائج')}>
            <div className="labs-console-toolbar">
              <h3><TerminalSquare size={16} />{tr('Console', 'Console', 'النتائج')}</h3>
              <div>
                <span className={`labs-console-status ${execution?.status || ''}`} role="status">{executing ? ({ loading: tr('Préparation du moteur', 'Loading runtime', 'تحميل المحرك'), compiling: tr('Compilation', 'Compiling', 'ترجمة الشيفرة'), running: tr('En cours', 'Running', 'قيد التشغيل') })[runPhase] : execution ? ({ success: tr('Terminé', 'Completed', 'اكتمل'), error: tr('Erreur', 'Error', 'خطأ'), timeout: tr('Temps limite', 'Time limit', 'انتهت المهلة'), stopped: tr('Arrêté', 'Stopped', 'أُوقف') })[execution.status] : tr('Prête', 'Ready', 'جاهزة')}</span>
                <button type="button" className="labs-console-clear" disabled={busy || !output.length} onClick={() => { setOutput([]); setExecution(null); }} aria-label={tr('Effacer la console', 'Clear console', 'مسح النتائج')} title={tr('Effacer la console', 'Clear console', 'مسح النتائج')}><Trash2 size={15} /></button>
              </div>
            </div>
            <div className="labs-console-output" role="log" aria-live="off" dir="ltr">
              {output.length ? <pre>{output.map((item, index) => <span key={index} className={item.stream === 'stderr' ? 'is-stderr' : undefined}>{item.text}</span>)}</pre> : <p className="labs-console-placeholder">{consolePlaceholder}{execution?.status === 'success' && outputExample && <code className="labs-output-example">{outputExample}</code>}</p>}
              <span ref={consoleEnd} />
            </div>
            <div className="labs-console-footer"><span>{executing && runPhase === 'loading' && runtimeProgress > 0 ? `${Math.round(runtimeProgress * 100)} %` : execution?.exitCode !== null && execution?.exitCode !== undefined ? `${tr('Code de sortie', 'Exit code', 'رمز الخروج')} ${execution.exitCode}` : tr('Sortie standard et erreurs', 'Standard output and errors', 'النتائج والأخطاء')}</span><span>{execution?.durationMs ? `${(execution.durationMs / 1000).toFixed(2)} s · ` : ''}{tr('Limite : 5 s', 'Limit: 5 s', 'المهلة: 5 ثوانٍ')}</span></div>
          </section>
        </div>
        <div className="labs-actions">
          {!session && <label className="labs-xp-choice"><input type="checkbox" aria-label={tr('Participer volontairement aux XP de pratique JavaScript', 'Voluntarily participate in JavaScript practice XP', 'المشاركة اختيارياً في نقاط تدريب JavaScript')} checked={voluntaryXp} disabled={language !== 'javascript' || busy} onChange={event => setVoluntaryXp(event.target.checked)} /><span>XP JavaScript</span></label>}
          <Button icon={Save} disabled={busy || !session || !!session.completedAt || session.source !== source} onClick={complete}>{tr('Terminer la session', 'Finish session', 'إنهاء الجلسة')}</Button>
          {session?.voluntaryXp && <span className="labs-xp-status">{tr('Potentiel', 'Potential', 'الرصيد')} <strong>{session.potential} / 10 XP</strong></span>}
        </div>
        {error && <div className="labs-alert is-error" role="alert">{error}</div>}
        {message && <div className="labs-alert" role="status">{message}</div>}
        {session?.result?.status && session.source === source && <div className={`labs-result ${valid ? 'is-valid' : ''}`} role="status">
          {valid ? <><CheckCircle2 size={18} /><span>{tr('Syntaxe vérifiée · session enregistrée.', 'Syntax checked · session saved.', 'تم التحقق من الصياغة وحفظ الجلسة.')}</span></> : <><Braces size={18} /><div>{session.result.status === 'validation_unavailable' && <p>{tr('Vérification indisponible. Réessayez.', 'Checking unavailable. Try again.', 'الفحص غير متاح. أعد المحاولة.')}</p>}{(session.result.diagnostics || []).map((item, index) => <p key={index}>{item.line ? `${tr('Ligne', 'Line', 'السطر')} ${item.line}${item.column ? `:${item.column}` : ''} · ` : ''}{item.message}</p>)}</div></>}
        </div>}
        <details className="labs-practice-details">
          <summary>{tr('Règles des XP', 'XP rules', 'قواعد النقاط')}</summary>
          <p className="muted">{tr('Facultatif, pour JavaScript : jusqu’à 10 XP par jour. Une erreur de syntaxe distincte retire 2 points du potentiel de la session, sans toucher aux XP acquis. Au moins 90 secondes, deux révisions et un programme développé ; les programmes similaires ne sont récompensés qu’une fois.', 'Optional for JavaScript: up to 10 XP daily. Each distinct syntax error removes 2 potential session points, preserving earned XP. At least 90 seconds, two revisions and a developed program; similar programs are rewarded once.', 'اختياري لـ JavaScript: حتى 10 نقاط يومياً. يخصم كل خطأ صياغة مختلف نقطتين من رصيد الجلسة دون المساس بالنقاط المكتسبة. يلزم 90 ثانية وتعديلان وبرنامج مطور، ولا تتكرر مكافأة البرامج المتشابهة.')}</p>
        </details>
      </section>
      <details className="card labs-sessions-panel">
        <summary>{tr('Vos sessions privées', 'Your private sessions', 'جلساتك الخاصة')} <span>{sessions.length}</span></summary>
        {sessions.length ? <div className="labs-session-list">{sessions.map(item => <button key={item.id} disabled={busy} onClick={() => restore(item)}><strong>{LANGUAGE_LABELS[item.language] || item.language}</strong><span>{new Date(item.updatedAt).toLocaleDateString(locale === 'ar' ? 'ar-MA' : locale === 'en' ? 'en-GB' : 'fr-FR')} · {item.completedAt ? tr('Terminée', 'Completed', 'منتهية') : tr('En cours', 'In progress', 'قيد العمل')}</span></button>)}</div> : <p className="muted">{sessionsLoading ? tr('Chargement…', 'Loading…', 'جارٍ التحميل…') : sessionsError ? tr('Réessayez le chargement des sessions.', 'Retry loading sessions.', 'أعد تحميل الجلسات.') : tr('Aucune session enregistrée.', 'No saved sessions.', 'لا توجد جلسات محفوظة.')}</p>}
      </details>
    </div>
    {tab === 'graphs' && <section className="card labs-workspace labs-graph-workspace">
      <h2><ChartLine size={19} />{tr('Tracer une fonction', 'Plot a function', 'رسم دالة')}</h2>
      <Field label="f(x)"><input className="input" dir="ltr" value={expression} maxLength={256} onChange={event => setExpression(event.target.value)} placeholder="sin(x) + x^2 / 10" /></Field>
      <p className="muted labs-notice">x · pi · e · + − * / ^ · {MATH_FUNCTIONS.join(', ')}</p>
      <div className="labs-graph-ranges">{[[tr('x minimum', 'Minimum x', 'أدنى x'), min, setMin], [tr('x maximum', 'Maximum x', 'أقصى x'), max, setMax], [tr('y minimum', 'Minimum y', 'أدنى y'), yMin, setYMin], [tr('y maximum', 'Maximum y', 'أقصى y'), yMax, setYMax]].map(([label, value, setValue]) => <Field key={label} label={label}><input className="input" type="number" value={value} onChange={event => setValue(Number(event.target.value))} /></Field>)}</div>
      <Button variant="primary" icon={ChartLine} onClick={drawGraph}>{tr('Tracer', 'Plot', 'رسم')}</Button>
      {graphError && <div className="labs-alert is-error" role="alert">{graphError}</div>}
      {graph.points.some(point => point.y !== null) ? <svg className="labs-graph" viewBox="0 0 800 420" role="img" aria-label={`f(x) = ${graph.expression}`}><title>{`f(x) = ${graph.expression}`}</title><defs><clipPath id={graphId}><rect x="50" y="40" width="700" height="330" /></clipPath></defs>{Array.from({ length: 11 }, (_, index) => <g key={index}><line className="labs-grid-line" x1={50 + index * 70} x2={50 + index * 70} y1="40" y2="370" /><line className="labs-grid-line" x1="50" x2="750" y1={40 + index * 33} y2={40 + index * 33} /></g>)}{geometry.xAxis !== null && <line className="labs-axis" x1="50" x2="750" y1={geometry.xAxis} y2={geometry.xAxis} />}{geometry.yAxis !== null && <line className="labs-axis" x1={geometry.yAxis} x2={geometry.yAxis} y1="40" y2="370" />}<path className="labs-function" d={geometry.path} clipPath={`url(#${graphId})`} /><text x="50" y="399">{graph.min}</text><text x="720" y="399">{graph.max}</text><text x="4" y="45">{graph.yMax}</text><text x="4" y="370">{graph.yMin}</text></svg> : <EmptyState title={tr('Aucune valeur réelle dans cet intervalle.', 'No real values in this range.', 'لا توجد قيم حقيقية في هذا النطاق.')} />}
      <details className="labs-values"><summary>{tr('Consulter quelques valeurs', 'View sampled values', 'عرض بعض القيم')}</summary><table><thead><tr><th>x</th><th>f(x)</th></tr></thead><tbody>{graph.points.filter((_, index) => index % 20 === 0).map(point => <tr key={point.x}><td>{point.x.toFixed(3)}</td><td>{point.y === null ? '—' : point.y.toFixed(4)}</td></tr>)}</tbody></table></details>
    </section>}
  </div>;
}
