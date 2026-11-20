// Hochwasser-Alarm Cochem – läuft automatisch über GitHub Actions (alle 15 Min.)
// Rechnet wie die Pegelseite und schickt bei Statuswechsel eine Push-Nachricht über ntfy.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

// ===================== EINSTELLUNGEN (gleich wie index.html) =====================
const HAUS_KRITISCH_CM = 930;
const WARNUNG_CM       = 750;
const TRIER_ORANGE_CM  = 520;
const TRIER_ANSTIEG_CM_H = 10;
const TRIER_ZU_COCHEM_CM = 60;
const TRIER_SCHAETZUNG_AB_CM = 700;
const ERNEUT_MELDEN_CM = 25;   // bei GEFAHR/ACHTUNG: erneut melden, wenn Erwartung um 25 cm steigt
const NTFY_TOPIC = process.env.NTFY_TOPIC;   // geheim: kommt aus GitHub-Secret NTFY_TOPIC
const SEITE = 'https://steckerinho.github.io/pegel/';
// ================================================================================

const API = 'https://www.pegelonline.wsv.de/webservices/rest-api/v2/stations/';
const COCHEM = '768df4e9-ed5a-4141-901b-e25ac404d559';
const TRIER  = '3bec53ca-444e-4014-a7b0-07b3591e954b';
const STATUS_DATEI = 'alarm-status.json';
const m = cm => (cm / 100).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' m';
const vz = x => (x > 0 ? '+' : '') + x.toLocaleString('de-DE', { maximumFractionDigits: 1 });

async function holen(uuid) {
  const r = await fetch(API + uuid + '/W/measurements.json?start=PT6H');
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const werte = await r.json();
  if (!werte.length) throw new Error('leer');
  const letzter = werte[werte.length - 1], jetzt = new Date(letzter.timestamp);
  let v3 = null;
  for (const w of werte) { if (new Date(w.timestamp) <= jetzt - 3 * 3600e3) v3 = w; else break; }
  const tendenz = v3 ? (letzter.value - v3.value) / (((jetzt - new Date(v3.timestamp)) / 3600e3) || 1) : 0;
  return { pegel: letzter.value, tendenz, jetzt };
}

// Titel als UTF-8 sicher übertragen (ntfy versteht RFC 2047)
const kopf = t => '=?UTF-8?B?' + Buffer.from(t, 'utf8').toString('base64') + '?=';
async function push(titel, text, prio, tags) {
  const r = await fetch('https://ntfy.sh/' + NTFY_TOPIC, {
    method: 'POST', body: text,
    headers: { Title: kopf(titel), Priority: String(prio), Tags: tags, Click: SEITE },
  });
  console.log('Push gesendet:', titel, '->', r.status);
}

if (!NTFY_TOPIC) { console.log('Secret NTFY_TOPIC fehlt!'); process.exit(1); }

const alt = existsSync(STATUS_DATEI) ? JSON.parse(readFileSync(STATUS_DATEI, 'utf8')) : { stufe: 0 };

if (process.env.TEST === 'true') {
  await push('Pegel-Alarm Test', 'Wenn du das liest, funktioniert dein Hochwasser-Alarm. 👍', 3, 'white_check_mark');
  process.exit(0);
}

let c, t = null;
try { c = await holen(COCHEM); } catch (e) { console.log('Cochem nicht erreichbar:', e.message); process.exit(0); }
try { t = await holen(TRIER); } catch (e) { console.log('Trier nicht erreichbar:', e.message); }

// Gleiche Einschätzung wie oben auf der Seite
const gruende = [];
let max = c.pegel + Math.max(0, c.tendenz) * 24;
gruende.push(`Cochem: ${m(c.pegel)} (${vz(c.tendenz)} cm/h)`);
if (t) {
  gruende.push(`Trier: ${m(t.pegel)} (${vz(t.tendenz)} cm/h)`);
  if (t.pegel >= TRIER_SCHAETZUNG_AB_CM) max = Math.max(max, t.pegel - TRIER_ZU_COCHEM_CM);
}
const trierAuffaellig = t && (t.pegel >= TRIER_ORANGE_CM || t.tendenz >= TRIER_ANSTIEG_CM_H);
let stufe = 0;                                   // 0 grün, 1 orange, 2 rot
if (max >= HAUS_KRITISCH_CM) stufe = 2;
else if (max >= WARNUNG_CM || trierAuffaellig || c.pegel >= WARNUNG_CM) stufe = 1;

const reserve = HAUS_KRITISCH_CM - max;
const text = gruende.join('\n') + `\nErwartet in 24 h: ca. ${m(max)} · Reserve bis Haus: ${reserve > 0 ? m(reserve) : 'keine!'}`;
console.log('Stufe', stufe, '|', text.replace(/\n/g, ' | '));

let letzteMeldung = alt.letzte_meldung_cm ?? 0;
if (stufe > alt.stufe) {
  if (stufe === 2) await push('🔴 GEFAHR – Hochwasser am Haus möglich', text + '\n\nIn den nächsten 24 Stunden kann Wasser ans Haus kommen!', 5, 'rotating_light');
  else await push('🟠 ACHTUNG – Hochwasserlage beobachten', text, 4, 'warning');
  letzteMeldung = max;
} else if (stufe >= 1 && stufe === alt.stufe && max >= letzteMeldung + ERNEUT_MELDEN_CM) {
  await push((stufe === 2 ? '🔴' : '🟠') + ' Mosel steigt weiter – erwartet ' + m(max), text, stufe === 2 ? 5 : 4, 'warning');
  letzteMeldung = max;
} else if (stufe < alt.stufe) {
  await push(stufe === 0 ? '🟢 Entwarnung Pegel Cochem' : '🟠 Lage entspannt sich etwas', text, 3, 'white_check_mark');
  letzteMeldung = max;
}

const neu = { stufe, letzte_meldung_cm: Math.round(letzteMeldung), pegel_cochem_cm: c.pegel,
              pegel_trier_cm: t ? t.pegel : null, erwartet_cm: Math.round(max), geprueft: new Date().toISOString(),
              aktiv_seit: alt.aktiv_seit ?? new Date().toISOString() };
// Datei nur schreiben, wenn sich etwas Wichtiges ändert oder alle ~20 Tage (hält den Zeitplan bei GitHub aktiv)
const zuletzt = alt.geschrieben ? new Date(alt.geschrieben) : new Date(0);
if (stufe !== alt.stufe || neu.letzte_meldung_cm !== alt.letzte_meldung_cm || Date.now() - zuletzt > 20 * 864e5) {
  neu.geschrieben = new Date().toISOString();
  writeFileSync(STATUS_DATEI, JSON.stringify(neu, null, 2) + '\n');
  console.log('Status gespeichert.');
}
