# CLAUDE.md — IA Hypermiler

Questo file è la memoria di progetto per Claude Code. Leggilo integralmente prima di qualsiasi intervento sul codice.

---

## Cos'è questo progetto

**IA Hypermiler** è un'app desktop Electron che monitora il consumo di token AI (Claude e GitHub Copilot) e calcola un budget giornaliero ottimale per arrivare a fine mese senza esaurire la quota. Mostra un widget sempre visibile con andamento settimanale, proiezione mensile e consigli d'uso generati da Claude.

---

## Stack e dipendenze

| Ruolo | Tecnologia |
|---|---|
| Linguaggio | TypeScript (dal Giorno 2) — `strict: true`, niente `any` |
| Shell desktop | Electron (versione LTS corrente) |
| UI | HTML + CSS + SVG/Canvas vanilla — zero framework, zero bundler. Il renderer compila in ES module native (`<script type="module">`), niente bundler nemmeno lì |
| Persistenza | electron-store (con encryptionKey per i segreti) |
| Agente consigli | Anthropic SDK per Node.js (`@anthropic-ai/sdk`) |
| Compilazione | `tsc` (due config: `tsconfig.json` per main/preload/services/store/budget/agents, `tsconfig.renderer.json` per il renderer) + `scripts/copy-assets.js` per copiare html/css in `dist/renderer/` |
| Test | `node:test` + `node:assert` (nessuna libreria di test esterna) |
| Build/pacchettizzazione | electron-builder |
| Runtime | Node.js LTS |

**Non aggiungere dipendenze senza chiedere.** Ogni nuova libreria va motivata e discussa prima dell'installazione. (TypeScript e `@types/node` sono già stati concordati per la migrazione del Giorno 2.)

---

## Struttura del progetto

```
ia-hypermiler/
├── CLAUDE.md               ← questo file
├── RESEARCH.md             ← output della sessione di ricerca API (Giorno 1)
├── ARCHITECTURE.md         ← design app: settings, finestre, widget, tray (Giorno 1, Sessione 2)
├── tsconfig.json           ← config TS per main/preload/services/store/budget/agents/tests (CommonJS)
├── tsconfig.renderer.json  ← config TS per renderer/*.ts (ES module nativo, browser)
├── types/
│   └── index.ts            ← tipi condivisi (QuotaWindow, AppSettings, AccountSnapshot, HypermilerBridge, ...)
├── scripts/
│   └── copy-assets.js      ← copia html/css del renderer in dist/renderer/ dopo la compilazione (script di build, non TS)
├── main.ts                 ← processo principale Electron (lifecycle, IPC, refresh)
├── preload.ts              ← contextBridge renderer ↔ main
├── main/
│   ├── windows.ts          ← creazione finestra principale (skin filled/transparent-digital) e impostazioni
│   ├── tray.ts              ← system tray cross-platform
│   └── claude-auth.ts       ← cattura sessione Claude via BrowserWindow di login
├── renderer/
│   ├── index.html          ← widget principale
│   ├── style.css           ← due skin (filled / transparent-digital)
│   ├── app.ts
│   ├── settings.html        ← finestra impostazioni
│   ├── settings.css
│   ├── settings.ts
│   └── types.ts             ← copia locale ridotta dei tipi condivisi (il tsconfig del renderer è isolato, vedi commento nel file)
├── agents/
│   └── advisor.ts          ← agente Claude per i consigli d'uso
├── services/
│   ├── _http.ts            ← helper fetch condiviso (timeout 10s, errori espliciti)
│   ├── claude.ts           ← fetch utilizzo Claude + relativo claude.test.ts
│   └── copilot.ts          ← fetch utilizzo Copilot + relativo copilot.test.ts
├── store/
│   └── index.ts            ← wrapper electron-store, schema completo in ARCHITECTURE.md §1
├── budget.ts               ← logica multi-finestra: pacing, efficienza, previsionale, autonomia (ARCHITECTURE.md §0/§3) + budget.test.ts
├── tests/
│   └── integration/        ← test contro le vere API, attivi solo con credenziali fornite in locale (vedi .env.test.example)
├── .env.test.example       ← template variabili d'ambiente per i test di integrazione (mai committare .env.test)
├── dist/                   ← output compilato da tsc + asset copiati (gitignored, generato da `npm run build`)
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
Ogni service (`services/claude.ts`, `services/copilot.ts`) deve esportare esattamente questa funzione (tipi completi in `types/index.ts`, motivazione del modello multi-finestra in ARCHITECTURE.md §0):

```ts
export async function fetchUsage(credentials: ClaudeCredentials | CopilotCredentials): Promise<RawAccountUsage> { ... }

// RawAccountUsage = { planTier, subscriptionRenewsAt, quotaWindows: QuotaWindow[] }
// QuotaWindow    = { id, label, periodType, periodLength, unit: 'percentage'|'count', used, total, resetsAt }
```

Se un service non riesce a recuperare i dati, deve **lanciare un errore esplicito** con messaggio leggibile — mai ritornare `null` o `undefined` silenziosamente. Niente `dailyHistory` restituito dal service: né Claude né Copilot lo espongono via API, lo storico giornaliero è costruito localmente da `main.ts` in `store.history.dailyUsage` ad ogni refresh riuscito.

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

Implementazione reale in `budget.ts` (non duplicare qui: questa sezione va aggiornata solo se cambia il modello, per evitare che diverga dal codice). Riepilogo dell'API pubblica, tutta a funzioni pure e testata in `budget.test.ts`:

- `workingUnitsBetween(start, end, workSchedule)` — unità lavorative (1/0.5/0 al giorno) tra due date
- `normalizedUtilization(window)` — percentuale 0-100 normalizzata, o `null` se non calcolabile
- `pickCriticalWindow(quotaWindows)` — la finestra con utilizzo più alto
- `efficiencyIndex(ctx)`, `projectedUsage(ctx)`, `estimatedAutonomyWorkingDays(ctx)` — pacing su unità lavorative, non giorni di calendario
- `daysUntilReset` / `workingDaysUntilReset` — giorni di calendario vs lavorativi al reset
- `resolveRenewalDate(renewalRule, referenceDate)` — supporta solo `{ type: 'dayOfMonth', day }`; `{ type: 'rrule' }` lancia esplicitamente "non supportato" finché non serve davvero

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
- Non usare `any` come tipo — il progetto è in TypeScript dal Giorno 2, `strict: true`. Se un tipo è davvero dinamico usa `unknown` con narrowing esplicito (vedi `renderer/settings.ts` per un esempio con `PlainRecord`/`isPlainRecord`)
- Non incollare credenziali reali (sessionKey, PAT/token) in chat, commit, issue o log — nemmeno per test. Vedi "Test di integrazione" sotto
- Non fare refactor architetturali non richiesti: se vedi un problema strutturale, segnalalo prima di correggere

---

## Flusso di lavoro con Claude Code

1. **Nuova funzionalità:** usa sempre `plan mode` prima di scrivere codice — descrivi cosa farai e aspetta conferma
2. **Bug fix:** descrivi il bug, la causa probabile e la correzione proposta prima di applicarla
3. **Subagent review (Giorno 3):** prima del build, esegui una review completa di `agents/`, `services/` e `main.ts` cercando: chiamate senza timeout, segreti nel renderer, path non cross-platform, memory leak nei setInterval

---

## Build e test

- `npm run build` — compila `tsconfig.json` (main/preload/services/store/budget/agents/tests) e `tsconfig.renderer.json` (renderer, ES module nativo), poi copia html/css in `dist/renderer/` via `scripts/copy-assets.js`. Output sempre in `dist/`, mai committato.
- `npm start` — build + `electron .`
- `npm test` — build + `node --test dist`. I test unitari (`budget.test.ts`, `services/*.test.ts`) girano sempre, mockano `fetch` e non toccano la rete.
- `npm run package` — build + `electron-builder` (installer `.dmg`/`.exe`/`.AppImage`, output in `release/` — **non** `dist/`, per non entrare in conflitto con l'output di `tsc`, che usa quella cartella per il codice compilato)

### CI — build multipiattaforma (GitHub Actions)

`.github/workflows/build.yml` builda in parallelo su `macos-latest`/`windows-latest`/`ubuntu-latest` (matrix), producendo `.dmg`/`.exe`/`.AppImage`/`.deb` dallo stesso commit senza tre macchine fisiche (vedi PLAN.md, Giorno 3 Sessione 2).

- **Trigger:** solo su push di un tag `v*` (es. `v0.1.0`), oppure manualmente da `workflow_dispatch`. Niente build automatica su ogni push/PR — il progetto non è ancora in un ritmo di release regolare.
- **Ogni job:** `npm ci` → `npm test` (build + test unitari, fallisce la CI se i test non passano) → `npx electron-builder --<mac|win|linux> --publish=never`.
- **Output:** solo artifact scaricabili dalla run di Actions (retention 14 giorni) — **nessuna pubblicazione automatica** di GitHub Release. Da attivare esplicitamente in futuro se serve una distribuzione pubblica.
- **Firma codice:** nessuna (`CSC_IDENTITY_AUTO_DISCOVERY: false` per evitare che electron-builder cerchi un'identità inesistente su macOS). I pacchetti risultano non firmati: macOS Gatekeeper e Windows SmartScreen mostreranno un avviso all'installazione finché non verranno aggiunti certificati reali — non ancora necessario per un progetto in sviluppo/uso personale.
- **Non ancora verificato con una run reale**: la sintassi YAML e la struttura del workflow sono state validate in locale (parsing YAML + assert sui campi chiave), ma nessuna run è mai stata eseguita su GitHub Actions vero (questo ambiente non ha accesso di rete a github.com). Va verificato pushando un tag `v*` e controllando la tab Actions della repo.

### Test di integrazione (credenziali reali)
`tests/integration/claude.integration.test.ts` e `tests/integration/copilot.integration.test.ts` chiamano le vere API di Claude/Copilot, ma **si auto-skippano** se le credenziali non sono presenti. Per attivarli **in locale**:

1. Copia `.env.test.example` in `.env.test` (già in `.gitignore`, non va mai committato).
2. Compila le variabili (`HYPERMILER_TEST_CLAUDE_SESSION_KEY`, `HYPERMILER_TEST_COPILOT_TOKEN`, ecc. — vedi i commenti nel file).
3. `npm test` carica automaticamente `.env.test` (via `--env-file-if-exists`, nessuna dipendenza aggiuntiva) e i test di integrazione si attivano da soli.

**Non fornire mai queste credenziali in chat con Claude Code**: non servirebbero comunque, perché l'ambiente di sviluppo assistito non ha accesso di rete a claude.ai/api.github.com — i test di integrazione vanno eseguiti da te, in locale, con `npm test`.

---

## Stato avanzamento

Aggiorna questa sezione manualmente a fine di ogni sessione.

| Giorno | Sessione | Stato | Note |
|---|---|---|---|
| 1 | Ricerca API | ✅ fatto (v3) | Vedi `RESEARCH.md`. Caso d'uso corretto: utilizzatore = singolo developer (non admin) che monitora il proprio credito. Claude: sì, via endpoint interno + sessionKey (funziona anche con seat aziendale/SSO) o Claude Code locale. Copilot: sì con piano personale (API ufficiale); con seat aziendale solo workaround non ufficiale (`copilot_internal/user`), da segnalare come best-effort in UI. Schema `credentials` da rivedere in plan mode prima di toccare `services/` |
| 1 | Design architettura | ✅ fatto | Vedi `ARCHITECTURE.md`. Modello multi-finestra di quota (percentuale per Claude, count per Copilot), schema settings completo, due skin finestra, tray, indicatori widget, hook estensibilità futuri |
| 1 | Scheletro Electron | ✅ fatto (con dati mock) | App funzionante con finestra widget (skin filled/transparent-digital), finestra impostazioni, tray cross-platform, IPC, refresh 30 min, notifica soglia 80%. Dati Claude/Copilot ancora MOCK in `main.js` — sostituzione con `services/` reali in Giorno 2. Verificato: sintassi di tutti i file JS + logica `budget.js` testata a mano (date-fns non installabile in sandbox, verificata con stub equivalente) |
| 2 | Services layer | ✅ fatto | `services/claude.js` (endpoint interno + sessionKey, con `listOrganizations`) e `services/copilot.js` (piano personale via API ufficiale; seat aziendale via `copilot_internal/user` best-effort) implementati, con `services/_http.js` condiviso (timeout 10s, errori espliciti). `main/claude-auth.js` cattura la sessione via `BrowserWindow` di login (no cookie incollati a mano). `main.js` usa dati reali con fallback su ultimo dato noto (`store.history.lastGood`) e timestamp se una fetch fallisce. Storico giornaliero costruito localmente in `store.history.dailyUsage` (né Claude né Copilot lo espongono via API). Non testato end-to-end con credenziali reali (nessun accesso di rete a claude.ai/github.com in sandbox) — solo sintassi e logica verificate |
| 2 | Budget + Agente | 🟨 budget fatto | `budget.js` implementato (multi-finestra, efficienza, previsionale, autonomia). `agents/advisor.js` resta stub: da collegare ad Anthropic SDK reale |
| — | Rifinitura impostazioni (feedback utente) | ✅ fatto | Aggiunto pulsante "Salva impostazioni" esplicito oltre al salvataggio automatico per campo. Semplificato "orario di lavoro" da intervallo inizio/fine a un singolo campo `hoursPerDay` (non ancora usato da `budget.ts`, che lavora a granularità giorno/mezza giornata — riservato per un futuro pacing infra-giornaliero, es. finestra Claude delle 5 ore) |
| — | Migrazione TypeScript (feedback utente) | ✅ fatto | Tutti i file sorgente convertiti da `.js` a `.ts` con tipi condivisi in `types/index.ts` (copia locale ridotta in `renderer/types.ts` per tenere isolato il tsconfig del renderer). Due config (`tsconfig.json` main/CommonJS, `tsconfig.renderer.json` browser/ES module nativo) + `scripts/copy-assets.js`. `package.json` aggiornato (`main`: `dist/main.js`, script `build`/`start`/`test`/`package`). Nessun `any` nel codebase. `tsc` non installabile in sandbox (registro npm bloccato): verificato eseguendo davvero il codice con il TS runtime nativo di Node 22 (erasure dei tipi, no type-check) — 34 test unitari passati, più uno smoke test end-to-end di `main.ts` (stub di `electron`/`electron-store`: finestra creata, tray creato, tutti gli handler IPC registrati e funzionanti) e parsing pulito di `preload.ts`/`agents/advisor.ts`/`renderer/*.ts`. Resta comunque da far girare `tsc` reale in locale (`npm install`) per il type-check completo, che qui non è verificabile |
| — | Test (feedback utente) | ✅ fatto (unitari, eseguiti davvero) / 🟨 integrazione predisposta | `budget.test.ts` (17 casi, logica pura) e `services/claude.test.ts` + `services/copilot.test.ts` (17 casi, fetch mockato, no rete) — 34/34 passati con `node --test`. `tests/integration/*.test.ts` predisposti e auto-skippati finché l'utente non fornisce credenziali reali in locale via `.env.test` (mai in chat: vedi sezione "Build e test" sopra) |
| 3 | Notifiche + robustezza | ⬜ da fare | |
| 3 | Review + Build | 🟨 CI definita | Workflow `.github/workflows/build.yml` creato: build parallela mac/win/linux via electron-builder (Linux produce sia `.AppImage` che `.deb`), trigger solo su tag `v*` o manuale, artifact-only (no release automatica), nessuna firma codice. Risolto anche un conflitto latente: l'output di `electron-builder` (`directories.output`) è stato spostato in `release/` perché di default coincide con `dist/`, la cartella già usata da `tsc` per il codice compilato. Sintassi YAML validata in locale; **non ancora verificata con una run reale** (nessun accesso di rete a GitHub da questo ambiente) — da provare pushando un tag. Restano da fare: subagent review di `agents/`/`services/`/`main.ts` e le rifiniture di robustezza/notifiche del Giorno 3 Sessione 1 |
