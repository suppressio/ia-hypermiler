# CLAUDE.md — IA Hypermiler

Questo file è la memoria di progetto per Claude Code. Leggilo integralmente prima di qualsiasi intervento sul codice.

---

## Cos'è questo progetto

**IA Hypermiler** è un'app desktop Electron che monitora il consumo di token AI (Claude e GitHub Copilot) e calcola un budget giornaliero ottimale per arrivare a fine mese senza esaurire la quota. Mostra un widget sempre visibile con andamento settimanale, proiezione mensile e consigli d'uso generati da Claude.

---

## Stack e dipendenze

| Ruolo | Tecnologia |
|---|---|
| Shell desktop | Electron (versione LTS corrente) |
| UI | HTML + CSS + SVG/Canvas vanilla — zero framework, zero bundler |
| Persistenza | electron-store (con encryptionKey per i segreti) |
| Agente consigli | Anthropic SDK per Node.js (`@anthropic-ai/sdk`) |
| Build | electron-builder |
| Runtime | Node.js LTS |

**Non aggiungere dipendenze senza chiedere.** Ogni nuova libreria va motivata e discussa prima dell'installazione.

---

## Struttura del progetto

```
ia-hypermiler/
├── CLAUDE.md               ← questo file
├── RESEARCH.md             ← output della sessione di ricerca API (Giorno 1)
├── ARCHITECTURE.md         ← design app: settings, finestre, widget, tray (Giorno 1, Sessione 2)
├── main.js                 ← processo principale Electron (lifecycle, IPC, refresh, mock data Giorno 1)
├── preload.js              ← contextBridge renderer ↔ main
├── main/
│   ├── windows.js          ← creazione finestra principale (skin filled/transparent-digital) e impostazioni
│   └── tray.js              ← system tray cross-platform
├── renderer/
│   ├── index.html          ← widget principale
│   ├── style.css           ← due skin (filled / transparent-digital)
│   ├── app.js
│   ├── settings.html        ← finestra impostazioni
│   ├── settings.css
│   └── settings.js
├── agents/
│   └── advisor.js          ← agente Claude per i consigli d'uso
├── services/
│   ├── claude.js           ← fetch utilizzo token Claude
│   └── copilot.js          ← fetch utilizzo token Copilot
├── store/
│   └── index.js            ← wrapper electron-store, schema completo in ARCHITECTURE.md §1
├── budget.js               ← logica multi-finestra: pacing, efficienza, previsionale, autonomia (ARCHITECTURE.md §0/§3)
└── package.json
```

---

## Regole architetturali — NON derogare

### Sicurezza Electron
- `nodeIntegration` deve essere sempre `false`
- `contextIsolation` deve essere sempre `true`
- Il renderer non ha mai accesso diretto a Node.js: tutto passa per `preload.js` via `contextBridge`
- Le API key e i cookie di sessione vivono solo nel main process e in `electron-store` con cifratura — mai nel renderer, mai in localStorage

### Cross-platform
- Non usare path separatori hard-coded (`\` o `/`): usa sempre `path.join()` o `path.resolve()`
- Non usare `shell.exec()` o comandi OS-specifici
- Testa mentalmente ogni path su Windows, macOS e Linux prima di scrivere codice

### Interfaccia dei service
Ogni service (`services/claude.js`, `services/copilot.js`) deve esportare esattamente questa funzione:

```js
/**
 * @param {object} credentials - credenziali recuperate da electron-store
 * @returns {Promise<{
 *   used: number,        // token usati nel periodo corrente
 *   total: number,       // quota mensile totale
 *   resetDate: Date,     // data del prossimo rinnovo
 *   dailyHistory: Array<{ date: string, used: number }>  // ultimi 7 giorni
 * }>}
 */
export async function fetchUsage(credentials) { ... }
```

Se un service non riesce a recuperare i dati, deve **lanciare un errore esplicito** con messaggio leggibile — mai ritornare `null` o `undefined` silenziosamente.

### Gestione errori
- Ogni chiamata di rete ha un timeout esplicito (max 10 secondi)
- Se le API non rispondono, la UI mostra l'ultimo dato noto con il timestamp dell'ultimo aggiornamento riuscito
- Mai schermata bianca o crash silenzioso

### Agente advisor
- Il system prompt di `advisor.js` deve chiedere consigli **specifici e pratici**, non generici
- Il contesto passato all'agente include: consumo degli ultimi 7 giorni, budget giornaliero corrente, servizi usati
- Il risultato viene cachato su `electron-store` e rigenerato al massimo una volta ogni 24 ore
- Il campo `model` è sempre `claude-sonnet-4-6`, `max_tokens: 1000`

---

## Logica di business core

### Calcolo budget giornaliero

```js
// budget.js
import { differenceInDays } from 'date-fns'; // unica eccezione alle zero-dipendenze UI

export function dailyBudget({ used, total, resetDate }) {
  const daysLeft = differenceInDays(new Date(resetDate), new Date());
  if (daysLeft <= 0) return total - used; // giorno di rinnovo
  const remaining = total - used;
  return Math.floor(remaining / daysLeft);
}

export function projectedMonthlyUsage(dailyHistory, resetDate) {
  // Media degli ultimi 7 giorni * giorni rimanenti + usati finora
  const avgDaily = dailyHistory.reduce((s, d) => s + d.used, 0) / dailyHistory.length;
  const daysLeft = differenceInDays(new Date(resetDate), new Date());
  const used = dailyHistory[dailyHistory.length - 1]?.cumulativeUsed ?? 0;
  return Math.round(used + avgDaily * daysLeft);
}
```

### Soglia notifica
- Notifica di sistema quando il consumo del giorno supera l'**80%** del budget giornaliero calcolato
- Notifica una sola volta per giorno (salva flag su `electron-store`)

### Auto-refresh
- Il main process esegue `fetchUsage()` ogni **30 minuti** via `setInterval`
- L'aggiornamento avviene anche con la finestra chiusa (solo tray)
- Dopo ogni fetch riuscita, i dati vengono scritti su `electron-store` e inviati al renderer via `ipcMain.emit`

---

## Cosa NON fare

- Non inventare endpoint API non documentati in `RESEARCH.md`
- Non aggiungere animazioni o effetti alla UI — sobria e leggibile è la priorità
- Non esporre segreti o credenziali in nessun file tracciato da git (aggiungi `.env` e `store/` a `.gitignore`)
- Non usare `any` come tipo se stai scrivendo TypeScript (ma il progetto parte in JS puro)
- Non fare refactor architetturali non richiesti: se vedi un problema strutturale, segnalalo prima di correggere

---

## Flusso di lavoro con Claude Code

1. **Nuova funzionalità:** usa sempre `plan mode` prima di scrivere codice — descrivi cosa farai e aspetta conferma
2. **Bug fix:** descrivi il bug, la causa probabile e la correzione proposta prima di applicarla
3. **Subagent review (Giorno 3):** prima del build, esegui una review completa di `agents/`, `services/` e `main.js` cercando: chiamate senza timeout, segreti nel renderer, path non cross-platform, memory leak nei setInterval

---

## Stato avanzamento

Aggiorna questa sezione manualmente a fine di ogni sessione.

| Giorno | Sessione | Stato | Note |
|---|---|---|---|
| 1 | Ricerca API | ✅ fatto (v3) | Vedi `RESEARCH.md`. Caso d'uso corretto: utilizzatore = singolo developer (non admin) che monitora il proprio credito. Claude: sì, via endpoint interno + sessionKey (funziona anche con seat aziendale/SSO) o Claude Code locale. Copilot: sì con piano personale (API ufficiale); con seat aziendale solo workaround non ufficiale (`copilot_internal/user`), da segnalare come best-effort in UI. Schema `credentials` da rivedere in plan mode prima di toccare `services/` |
| 1 | Design architettura | ✅ fatto | Vedi `ARCHITECTURE.md`. Modello multi-finestra di quota (percentuale per Claude, count per Copilot), schema settings completo, due skin finestra, tray, indicatori widget, hook estensibilità futuri |
| 1 | Scheletro Electron | ✅ fatto (con dati mock) | App funzionante con finestra widget (skin filled/transparent-digital), finestra impostazioni, tray cross-platform, IPC, refresh 30 min, notifica soglia 80%. Dati Claude/Copilot ancora MOCK in `main.js` — sostituzione con `services/` reali in Giorno 2. Verificato: sintassi di tutti i file JS + logica `budget.js` testata a mano (date-fns non installabile in sandbox, verificata con stub equivalente) |
| 2 | Services layer | ⬜ da fare | Dipende da `RESEARCH.md`; deve produrre l'oggetto `quotaWindows` atteso da `budget.js` (vedi `ARCHITECTURE.md` §0) |
| 2 | Budget + Agente | 🟨 budget fatto | `budget.js` implementato (multi-finestra, efficienza, previsionale, autonomia). `agents/advisor.js` resta stub: da collegare ad Anthropic SDK reale |
| 3 | Notifiche + robustezza | ⬜ da fare | |
| 3 | Review + Build | ⬜ da fare | |
