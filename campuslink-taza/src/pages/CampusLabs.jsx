import React, { useEffect, useId, useMemo, useState } from 'react';
import { Braces, ChartLine, CheckCircle2, Play, Plus, Save } from 'lucide-react';
import { api } from '../api';
import { useApp } from '../context';
import { Button, EmptyState, Field, PageHeader, Tabs } from '../components/ui';
import { Select } from '../components/Select';
import { sampleGraph, MATH_FUNCTIONS } from '../../shared/math';
import './labs.css';

const LANGUAGE_LABELS = { javascript: 'JavaScript', json: 'JSON', python: 'Python', c: 'C', cpp: 'C++' };
const STARTERS = {
  javascript: 'function moyenne(valeurs) {\n  let total = 0;\n  for (const valeur of valeurs) {\n    total += valeur;\n  }\n  return valeurs.length ? total / valeurs.length : 0;\n}\n',
  json: '{\n  "module": "Mon cours",\n  "chapitres": [1, 2, 3]\n}',
  python: 'def moyenne(valeurs):\n    total = 0\n    for valeur in valeurs:\n        total += valeur\n    return total / len(valeurs) if valeurs else 0\n\nprint(moyenne([12, 14, 16]))\n',
  c: '#include <stdio.h>\n\ndouble moyenne(const double valeurs[], int nombre) {\n    double total = 0;\n    for (int i = 0; i < nombre; i++) {\n        total += valeurs[i];\n    }\n    return nombre > 0 ? total / nombre : 0;\n}\n\nint main(void) {\n    double valeurs[] = {12, 14, 16};\n    printf("%g\\n", moyenne(valeurs, 3));\n    return 0;\n}\n',
  cpp: '#include <iostream>\n#include <vector>\n\ndouble moyenne(const std::vector<double>& valeurs) {\n    double total = 0;\n    for (double valeur : valeurs) {\n        total += valeur;\n    }\n    return valeurs.empty() ? 0 : total / valeurs.size();\n}\n\nint main() {\n    std::cout << moyenne({12, 14, 16}) << "\\n";\n    return 0;\n}\n',
};
const starter = language => STARTERS[language] || '';
export default function CampusLabs() {
  const { tr, language: locale, refresh } = useApp();
  const [tab, setTab] = useState('code'), [language, setLanguage] = useState('javascript');
  const [source, setSource] = useState(starter('javascript')), [voluntaryXp, setVoluntaryXp] = useState(false);
  const [session, setSession] = useState(null), [sessions, setSessions] = useState([]), [policy, setPolicy] = useState(null), [languages, setLanguages] = useState(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('');
  const [expression, setExpression] = useState('sin(x)'), [min, setMin] = useState(-10), [max, setMax] = useState(10);
  const [yMin, setYMin] = useState(-2), [yMax, setYMax] = useState(2), [graph, setGraph] = useState(() => ({ points: sampleGraph('sin(x)'), min: -10, max: 10, yMin: -2, yMax: 2, expression: 'sin(x)' }));
  const [graphError, setGraphError] = useState('');
  const graphId = useId().replace(/:/g, '');
  useEffect(() => {
    let active = true;
    api('/labs').then(data => { if (active) { setSessions(data.sessions || []); setPolicy(data.policy); setLanguages((data.languages || []).filter(item => Object.hasOwn(LANGUAGE_LABELS, item))); } }).catch(err => { if (active) setError(err.message); });
    return () => { active = false; };
  }, []);
  const updateSession = next => {
    setSession(next);
    setSessions(previous => [next, ...previous.filter(item => item.id !== next.id)].slice(0, 20));
  };
  const newSession = () => { setSession(null); setMessage(''); setError(''); };
  const check = async () => {
    if (busy || !languages?.includes(language)) return;
    setBusy(true); setError(''); setMessage('');
    try {
      let current = session;
      if (!current) { current = (await api('/labs', { method: 'POST', body: { language, voluntaryXp: language === 'javascript' && voluntaryXp } })).session; updateSession(current); }
      const response = await api(`/labs/${current.id}/check`, { method: 'POST', body: { source } });
      updateSession(response.session);
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };
  const complete = async () => {
    if (!session || busy) return;
    setBusy(true); setError('');
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
    finally { setBusy(false); }
  };
  const restore = item => { setLanguage(item.language); setSource(item.source || starter(item.language)); setVoluntaryXp(item.language === 'javascript' && !!item.voluntaryXp); setSession(item); setError(''); setMessage(''); };
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
  const canCheck = !!policy && !!languages?.includes(language);
  const unavailable = languages && Object.keys(LANGUAGE_LABELS).filter(item => !languages.includes(item));
  return <div className="labs-page page-enter">
    <PageHeader eyebrow="CampusLink" title="Campus Labs" description={tr('Pratique du code et graphiques pour vos études.', 'Code practice and graphs for your studies.', 'تدريب على البرمجة ورسوم بيانية لدراستك.')} />
    <Tabs value={tab} onChange={setTab} items={[{ id: 'code', label: tr('Code', 'Code', 'البرمجة') }, { id: 'graphs', label: tr('Graphiques', 'Graphs', 'الرسوم البيانية') }]} />
    {tab === 'code' ? <div className="labs-layout">
      <section className="card labs-workspace">
        <div className="labs-toolbar"><Field label={tr('Langage', 'Language', 'اللغة')}><Select className="input" value={language} disabled={busy || !languages} onChange={event => { setLanguage(event.target.value); setSource(starter(event.target.value)); setVoluntaryXp(false); newSession(); }}>{Object.entries(LANGUAGE_LABELS).map(([id, label]) => <option key={id} value={id} disabled={!languages?.includes(id)}>{label}</option>)}</Select></Field><Button icon={Plus} disabled={busy} onClick={newSession}>{tr('Nouvelle session', 'New session', 'جلسة جديدة')}</Button></div>
        <p className="muted labs-notice">{tr('Vérification syntaxique uniquement. La validité du programme ne garantit pas la justesse d’une solution. Aucun code n’est exécuté.', 'Syntax checking only. A valid program does not guarantee a correct solution. No code is executed.', 'فحص الصياغة فقط. صلاحية البرنامج لا تضمن صحة الحل. لا تُنفَّذ أي شيفرة.')}</p>
        <Field label={tr('Votre code', 'Your code', 'شيفرتك')}><textarea className="input labs-code-editor" spellCheck={false} autoCapitalize="off" dir="ltr" value={source} onChange={event => setSource(event.target.value)} maxLength={16000} disabled={busy || !!session?.completedAt} /></Field>
        {!session && <label className="labs-xp-choice"><input type="checkbox" checked={voluntaryXp} disabled={language !== 'javascript' || busy} onChange={event => setVoluntaryXp(event.target.checked)} /><span>{tr('Participer volontairement aux XP de pratique JavaScript', 'Voluntarily participate in JavaScript practice XP', 'المشاركة اختيارياً في نقاط تدريب JavaScript')}</span></label>}
        <div className="labs-actions"><Button variant="primary" icon={Play} disabled={busy || !!session?.completedAt || !source.trim() || !canCheck} onClick={check}>{busy ? tr('Vérification…', 'Checking…', 'جارٍ الفحص…') : tr('Vérifier la syntaxe', 'Check syntax', 'فحص الصياغة')}</Button><Button icon={Save} disabled={busy || !session || !!session.completedAt || session.source !== source} onClick={complete}>{tr('Terminer la session', 'Finish session', 'إنهاء الجلسة')}</Button></div>
        {languages && !canCheck && <p className="labs-notice muted" role="status">{tr('La vérification de ce langage est indisponible sur ce serveur.', 'Checking this language is unavailable on this server.', 'فحص هذه اللغة غير متاح على هذا الخادم.')}</p>}
        {error && <div className="labs-alert is-error" role="alert">{error}</div>}
        {message && <div className="labs-alert" role="status">{message}</div>}
        {session?.result?.status && session.source === source && <div className={`labs-result ${valid ? 'is-valid' : ''}`} role="status">
          {valid ? <><CheckCircle2 size={18} /><span>{tr('Syntaxe valide. Le code n’a pas été exécuté.', 'Valid syntax. The code was not executed.', 'الصياغة صحيحة. لم تُنفَّذ الشيفرة.')}</span></> : <><Braces size={18} /><div>{session.result.status === 'validation_unavailable' && <p>{tr('Vérification indisponible. Réessayez dans quelques instants.', 'Checking is unavailable. Try again shortly.', 'الفحص غير متاح. أعد المحاولة بعد قليل.')}</p>}{(session.result.diagnostics || []).map((item, index) => <p key={index}>{item.line ? `${tr('Ligne', 'Line', 'السطر')} ${item.line}${item.column ? `:${item.column}` : ''} · ` : ''}{item.message}</p>)}</div></>}
        </div>}
        {session?.voluntaryXp && <p className="labs-xp-status">{tr('Potentiel de cette session', 'This session’s potential', 'رصيد هذه الجلسة المحتمل')} <strong>{session.potential} / 10 XP</strong></p>}
      </section>
      <aside className="labs-sidebar">
        <section className="card"><h2>{tr('Pratique équitable', 'Fair practice', 'تدريب عادل')}</h2><p className="muted">{tr('10 XP de potentiel. Chaque erreur de syntaxe distincte retire 2 XP de ce potentiel, sans réduire les XP déjà acquis. Maximum 10 XP de code par jour.', '10 potential XP. Each distinct syntax error removes 2 potential XP, preserving previously earned XP. Up to 10 code XP per day.', '10 نقاط محتملة. تخصم كل مشكلة صياغة مختلفة نقطتين من الرصيد المحتمل دون المساس بالنقاط السابقة. حتى 10 نقاط برمجة يومياً.')}</p><p className="muted">{tr('Au moins 90 secondes, deux révisions différentes et un programme développé. Les programmes de structure similaire sont dédupliqués. La programmation reste facultative pour toutes les facultés.', 'At least 90 seconds, two distinct revisions and a developed program. Similar program structures are deduplicated. Programming remains optional for every faculty.', '90 ثانية على الأقل وتعديلان مختلفان وبرنامج مطور. لا تتكرر مكافأة البنية البرمجية المتشابهة. البرمجة اختيارية لجميع الكليات.')}</p></section>
        <section className="card"><h2>{tr('Langages disponibles', 'Available languages', 'اللغات المتاحة')}</h2><p className="muted">{languages ? languages.map(item => LANGUAGE_LABELS[item]).join(' · ') || tr('Aucune vérification disponible.', 'No checks are available.', 'لا توجد لغات متاحة للفحص.') : tr('Chargement des langages…', 'Loading languages…', 'جارٍ تحميل اللغات…')}</p>{!!unavailable?.length && <p className="muted">{tr('Indisponibles sur ce serveur', 'Unavailable on this server', 'غير متاحة على هذا الخادم')} : {unavailable.map(item => LANGUAGE_LABELS[item]).join(' · ')}</p>}<p className="muted">{tr('Les vérifications n’exécutent pas le programme. Les XP de pratique sont réservés aux sessions JavaScript volontaires.', 'Checks do not run the program. Practice XP is limited to voluntary JavaScript sessions.', 'لا ينفذ الفحص البرنامج. نقاط التدريب متاحة لجلسات JavaScript الاختيارية فقط.')}</p></section>
        <section className="card"><h2>{tr('Vos sessions privées', 'Your private sessions', 'جلساتك الخاصة')}</h2>{sessions.length ? <div className="labs-session-list">{sessions.map(item => <button key={item.id} disabled={busy} onClick={() => restore(item)}><strong>{LANGUAGE_LABELS[item.language] || item.language}</strong><span>{new Date(item.updatedAt).toLocaleDateString(locale === 'ar' ? 'ar-MA' : locale === 'en' ? 'en-GB' : 'fr-FR')} · {item.completedAt ? tr('Terminée', 'Completed', 'منتهية') : tr('En cours', 'In progress', 'قيد العمل')}</span></button>)}</div> : <p className="muted">{tr('Votre première vérification démarrera une session.', 'Your first check starts a session.', 'يبدأ الفحص الأول جلسة جديدة.')}</p>}</section>
      </aside>
    </div> : <section className="card labs-workspace labs-graph-workspace">
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
