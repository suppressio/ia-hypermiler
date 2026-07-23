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
│   ├── claude-auth.ts       ← cattura sessione Claude via BrowserWindow di login
│   └── copilot-oauth.ts     ← login Copilot via GitHub OAuth App (loopback PKCE), alternativa sperimentale al PAT + relativo copilot-oauth.test.ts
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
│   ├── _shape.ts           ← riduzione risposta a "solo struttura" (mai valori reali) + relativo _shape.test.ts, usata dalla diagnostica auto-segnalazione format-drift (vedi sotto)
│   ├── claude.ts           ← fetch utilizzo Claude + relativo claude.test.ts
│   └── copilot.ts          ← fetch utilizzo Copilot + relativo copilot.test.ts
├── diagnostics/
│   └── githubIssue.ts      ← costruisce l'URL di una issue GitHub precompilata quando un service rileva un formato di risposta non riconosciuto (FormatDriftError) + relativo githubIssue.test.ts
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

### Diagnostica: auto-segnalazione "format drift" (Giorno 3, feedback utente)
Quando un service (`services/claude.ts` o `services/copilot.ts`) riceve una risposta il cui
formato non corrisponde più a quello atteso (nessuna finestra di quota riconosciuta, campo
chiave mancante, ecc.), lancia un `FormatDriftError` (`services/_shape.ts`) invece di un
`Error` generico. `main.ts` intercetta questo errore in `fetchAccountOrFallback()` (punto
centrale condiviso da Claude e Copilot) e chiama `maybeReportFormatDrift()`:

- **Mai pubblicazione automatica**: si apre solo una bozza precompilata di issue GitHub nel
  browser di sistema (`shell.openExternal`, via `diagnostics/githubIssue.ts`) — l'utente deve
  sempre rivedere e confermare manualmente l'invio. L'app non ha né usa un token GitHub.
- **Mai valori reali nella segnalazione**: il corpo della issue contiene solo la "shape" della
  risposta (nomi di campo + `typeof`, prodotta da `extractShape()` in `services/_shape.ts`),
  mai percentuali di utilizzo, importi o date reali. Regola nata da un caso reale (vedi "Stato
  avanzamento" sotto) in cui una risposta di debug ha esposto `used_dollars`/`limit_dollars` di
  un account reale in chat.
- **Deduplicata per firma struttura** (`shapeSignature()`): la stessa forma non riapre una
  seconda bozza ad ogni refresh (ogni 30 minuti). Le firme già segnalate vivono in
  `store.diagnostics.reportedSignatures`.
- **Disattivabile** dall'utente: checkbox "Diagnostica" in Impostazioni
  (`diagnostics.autoReportFormatDrift`, default `true`).
- Copre **entrambi i servizi da subito** (Claude e Copilot), perché il punto di intercettazione
  è condiviso (`fetchAccountOrFallback`), non duplicato per account.

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
| 3 | Diagnostica: auto-segnalazione format-drift (feedback utente) | ✅ fatto | A valle del bug reale sotto ("nessuna finestra di quota riconosciuta"), l'utente ha chiesto che sia l'app stessa — non un intervento manuale in chat — a segnalare quando un endpoint cambia formato. Decisioni vincolanti raccolte via domanda esplicita: (1) bozza precompilata da aprire e confermare a mano, mai pubblicazione automatica via API; (2) corpo della segnalazione solo struttura (nomi/tipi di campo), mai valori reali; (3) copre Claude e Copilot da subito. Implementato: `services/_shape.ts` (`extractShape`/`shapeSignature`/`FormatDriftError`), `diagnostics/githubIssue.ts` (`buildFormatDriftIssueUrl`, URL precompilato senza bisogno di token GitHub), `main.ts` (`maybeReportFormatDrift`, agganciato centralmente in `fetchAccountOrFallback` così copre anche un drift che emerge dopo settimane di refresh riusciti, non solo al primo collegamento), nuovo campo `diagnostics` in `AppSettings`/store con default `autoReportFormatDrift: true`, checkbox dedicata in `renderer/settings.html`. `services/claude.ts` e `services/copilot.ts` (3 punti) aggiornati per lanciare `FormatDriftError` invece di `Error` generico dove rilevano un formato non riconosciuto. Verificato: 55/55 test unitari (budget + services + nuovi `_shape.test.ts`/`githubIssue.test.ts`, inclusi test espliciti che confermano che nessun valore reale sopravvive a `extractShape`/nel corpo della issue), più smoke test di avvio di `main.ts` (IPC, finestra, tray). Non ancora committato |
| 3 | Notifiche + robustezza | ✅ fatto (MVP) | Notifica soglia 80% e fallback su ultimo dato noto già presenti dal Giorno 1/2. In questa sessione, a valle della subagent review sotto: (1) i segreti (`sessionKey`/PAT) non attraversano più il confine IPC verso il renderer — `main.ts` (`redactSecretsForRenderer`) li sostituisce con un segnaposto in `settings:get`/`settings:set`, preservando però il valore reale nello store (`preserveRealSecretsOnWrite`, altrimenti il segnaposto rimandato indietro dal renderer al primo salvataggio successivo avrebbe cancellato la sessione reale — bug scoperto e corretto nella stessa sessione); (2) dopo "Connetti"/"Salva token" il form ora si ripopola (`populateForm()`), altrimenti la checkbox "Account collegato/abilitato" restava disallineata dallo stato "Connesso" appena mostrato; (3) un cambio di piano/quota/calendario di lavoro in Impostazioni ora chiama subito `requestUsageRefresh()` invece di aspettare il refresh automatico (fino a 30 min) — era la causa principale del "flusso non lineare" segnalato dall'utente; (4) rimosso un doppio refresh ridondante all'apertura del widget (sia `main.ts` su `did-finish-load` sia `renderer/app.ts` su `DOMContentLoaded` lo innescavano). Verificato: 55/55 test unitari invariati + due nuovi smoke test IPC dedicati (redazione segreti, non sovrascrittura al salvataggio). Backlog volutamente non affrontato ora (richiede più design): nessuna azione di "disconnetti"/logout per cancellare un sessionKey/PAT salvato, `settings:set` non valida lo schema della patch, nessun indicatore di caricamento nel widget durante un refresh in corso |
| 3 | Primo test con account Claude reale (feedback utente) | ✅ confermato con account reale | Collegato un account Claude reale (Enterprise/SSO): il widget mostrava "Nessun account collegato" nonostante la connessione riuscita. Causa 1 (UI): `main.ts`/`renderer/app.ts` non distinguevano "non collegato" da "collegato ma prima sincronizzazione fallita" — corretto con `emptyAccountSnapshot()` e un messaggio esplicito nel widget che mostra anche `lastError`. Causa 2 (rete): claude.ai è dietro Cloudflare — il solo cookie `sessionKey` non basta, serve anche `cf_clearance` (+ uno User-Agent plausibile), altrimenti risponde 403 con la pagina "Just a moment..." invece del JSON. Fix: `main/claude-auth.ts` (`buildClaudeCookieHeader()`) legge a runtime tutti i cookie della sessione Electron per claude.ai. Causa 3 (parsing, bloccava ancora i dati dopo aver superato Cloudflare): i nomi dei campi della risposta usage sono risultati offuscati/rinominati lato Anthropic (`cinder_cove`, `omelette_promotional`, ecc. al posto di `five_hour`/`seven_day`/`seven_day_opus`, tutti null) — vedi RESEARCH.md addendum 2. Fix: `services/claude.ts` (`buildQuotaWindows`) riconosce ora le finestre per **forma** del valore (`utilization` numerico), non per nome campo; le finestre con `limit_dollars`/`used_dollars` numerici vengono modellate come `unit: 'count'` con importi reali; le finestre a 0%/non applicabili vengono scartate senza generare un falso format-drift. Verificato: 55/55 test unitari (inclusi 5 nuovi casi su `buildQuotaWindows`, uno con il payload reale ricevuto) + smoke test IPC/finestre. **Riconfermato dall'utente sul widget reale**: mostra correttamente percentuale, etichetta e data di rinnovo (screenshot rivisto in chat) |
| 3 | Subagent review (`agents/`, `services/`, `main.ts`) | ✅ fatto | Eseguita la review prescritta da CLAUDE.md/PLAN.md prima della chiusura del Giorno 3. Checklist base (timeout espliciti, path cross-platform, `setInterval`/`setTimeout` senza leak) risultata pulita. Trovati e corretti 4 problemi reali di UX/sicurezza (vedi riga "Notifiche + robustezza" sopra): segreti esposti al renderer via `settings:get`/`settings:set`, form disallineato dopo il collegamento account, cambi di impostazioni non propagati al widget prima del prossimo refresh automatico, doppio refresh ridondante all'apertura finestra. Problemi più invasivi segnalati ma non affrontati ora (richiedono discussione di design): nessun flusso di disconnessione/logout, nessuna validazione di schema su `settings:set`, nessun indicatore di caricamento durante un refresh in corso |
| 3 | Build (CI) | 🟨 CI definita | Workflow `.github/workflows/build.yml` creato: build parallela mac/win/linux via electron-builder (Linux produce sia `.AppImage` che `.deb`), trigger solo su tag `v*` o manuale, artifact-only (no release automatica), nessuna firma codice. Risolto anche un conflitto latente: l'output di `electron-builder` (`directories.output`) è stato spostato in `release/` perché di default coincide con `dist/`, la cartella già usata da `tsc` per il codice compilato. Sintassi YAML validata in locale; **non ancora verificata con una run reale** (nessun accesso di rete a GitHub da questo ambiente) — da provare pushando un tag |
| 3 | **Chiusura Giorno 3 — MVP** | ✅ **MVP raggiunto** | Tutte le sessioni previste da PLAN.md per il Giorno 3 sono state completate a livello MVP: notifiche, robustezza, diagnostica auto-segnalazione format-drift, fix del parsing Claude su un bug reale, subagent review con correzioni applicate. Restano rifiniture note e volutamente rimandate (vedi righe sopra) più il collaudo reale della CI su GitHub Actions (richiede un push di tag `v*` dall'utente, non eseguibile da questo ambiente) — nessuna di queste blocca l'uso quotidiano dell'app come MVP personale |
| — | Rifiniture UX widget (feedback utente post-MVP) | ✅ fatto | Tre problemi segnalati dall'utente dopo aver provato l'app reale: (1) nella skin "pieno" restava visibile la barra menu di default di Electron (File/Modifica/Vista/...) — rimossa con `Menu.setApplicationMenu(null)` globale in `main.ts` + `win.setMenuBarVisibility(false)` per-finestra in `main/windows.ts` (difesa doppia); (2)/(3) il widget non permetteva di selezionare il testo né di trascinare la finestra se non dalla sottile titlebar — risolto in `renderer/style.css` rendendo l'intero `body` un'area di trascinamento (`-webkit-app-region: drag`), con esclusione esplicita (`no-drag` + `user-select: text`) su pulsanti, tab e su tutti i valori/etichette testuali, che restano così sia cliccabili sia selezionabili. Verificato: 55/55 test unitari invariati + smoke test IPC/finestre rieseguito con gli stub `Menu`/`setMenuBarVisibility` estesi |
| — | Rifiniture UX widget, round 2 (screenshot utente: "problemi non risolti") | ✅ fatto | Lo screenshot ha mostrato che restavano due problemi reali dopo il round precedente: (1) la titlebar **nativa** del sistema operativo (icona + titolo + minimizza/ripristina/chiudi) era ancora visibile sopra quella custom nella skin "pieno" — la rimozione del menu File/Modifica/Vista non bastava, perché `frame: true` mostra comunque la cornice nativa del sistema operativo. Fix: `main/windows.ts` ora crea sempre la finestra con `frame: false` in entrambe le skin (non più `frame: !isTransparent`), affidandosi solo alla titlebar custom di `renderer/index.html` — coerente con l'intento originale di ARCHITECTURE.md §2 ma corretto alla luce del comportamento reale osservato. (2) Trascinare la finestra iniziando da un valore selezionabile e proseguendo sullo sfondo faceva "sconfinare" la selezione di testo su tutto il contenuto della finestra (visibile nello screenshot: quasi tutto il testo appariva evidenziato in blu) — causa: il body (area "drag" di default) non aveva `user-select: none`, quindi un gesto di selezione iniziato in un'isola "no-drag" si estendeva liberamente attraverso le zone di trascinamento. Fix: aggiunto `user-select: none` sul body, mantenendo `user-select: text` solo sulle isole esplicitamente escluse dal trascinamento (valori, etichette, pulsanti). Nota di trasparenza: trascinare "da qualunque punto" e selezionare "qualunque testo" con lo stesso gesto del mouse sono in tensione strutturale — il compromesso adottato è che lo sfondo/i margini restano sempre trascinabili, mentre i singoli valori/etichette restano selezionabili solo se il gesto di selezione comincia e resta al loro interno. Verificato: 55/55 test unitari invariati + smoke test IPC/finestre con `frame: false` |
| — | Rifiniture UX widget, round 3 (feedback utente: selezione ancora non ok + 4 richieste) | ✅ fatto | L'utente ha confermato che la selezione non era ancora risolta e ha chiesto di **abbandonare** il trascinamento da tutta la finestra: (1) **Trascinamento solo dalla titlebar** — rimosso `-webkit-app-region: drag`/`user-select: none` dal `body` in `renderer/style.css`, tornando al solo `.titlebar`/`.titlebar-drag` (striscia bianca in alto in skin "pieno"): elimina alla radice lo sconfinamento della selezione, perché nel contenuto (`#app`) non c'è più alcuna area "drag" con cui possa entrare in conflitto. Per la skin "trasparente/digitale", dove quella striscia è invisibile (nessuno sfondo), aggiunto un piccolo indicatore che appare in hover (stesso trattamento "opacity 0→1" già usato per i pulsanti), così il punto per trascinare resta scopribile anche lì. (2) **Grafico "Andamento settimanale" mostrava un rettangolo grigio pieno** — causa: con un solo giorno di storico (account appena collegato) l'unica barra occupava tutta larghezza/altezza del riquadro. Fix: `renderer/app.ts` (`buildChartSeries`) ora genera sempre 7 (o 30, in vista mensile) slot fissi per data di calendario, riempiendo con 0 i giorni senza dati registrati (mostrati più tenui, opacità 0.15 contro 0.75 dei giorni reali) — così un solo giorno di dati appare come una singola barra tra spazi vuoti, non come un blocco pieno. (3) **Colore accento in Impostazioni non aveva alcun effetto** — la variabile CSS `--accent` letta da `style.css` non veniva mai aggiornata dal valore scelto. Fix: nuovo canale IPC `settings:update` (broadcast da `main.ts` verso il widget ad ogni `settings:set`, con relativa aggiunta a `preload.ts`/`types/index.ts`/`renderer/types.ts`) + `renderer/app.ts` (`applyAccentColor`) applicato sia all'avvio sia dal vivo quando le Impostazioni cambiano mentre il widget è aperto. (4) **Salvataggio automatico ad ogni campo, discordante col pulsante "Salva impostazioni" già presente** — richiesta esplicita di due pulsanti Salva/Annulla per confermare o scartare le modifiche di una sessione in Impostazioni. Fix in `renderer/settings.ts`: il listener `change` sui campi ora aggiorna solo lo stato locale in bozza (nessuna chiamata a `setSettings`/effetti collaterali); il pulsante "Salva impostazioni" applica tutto in un colpo solo (persistenza + `setWindowStyle`/`setAlwaysOnTop` solo se effettivamente cambiati rispetto all'ultimo salvataggio, per non ricreare la finestra ad ogni Salva + refresh usage se sono cambiati account/calendario); nuovo pulsante "Annulla" (`renderer/settings.html`) ricarica le impostazioni realmente persistite e ripopola il form, scartando le modifiche in sospeso. Verificato: 55/55 test unitari invariati + smoke test IPC/finestre (incluso il nuovo broadcast `settings:update`) |
| — | Primo test con account Copilot reale (seat aziendale) | 🟨 endpoint org-managed non più utilizzabile (confermato) | Prima connessione reale di un account Copilot con `accountScope: organization`: la diagnostica auto-segnalazione ha correttamente rilevato che `copilot_internal/user` non restituisce più `quota_snapshots` (solo flag di feature, `copilot_plan`, `login`, liste organizzazione, `endpoints` — nessun campo di quota/consumo/reset). Dettagli completi in `RESEARCH.md` §2.3 (Addendum 2026-07-23). Confermato che non è un bug dell'app: l'endpoint è non documentato e già segnalato in ARCHITECTURE.md/RESEARCH.md come "può rompersi senza preavviso" — si è rotto. Nessun fix di parsing possibile: la risposta reale non contiene più alcun dato di quota da estrarre. Comportamento dell'app verificato corretto: `FormatDriftError` → bozza di issue precompilata (nessun valore reale) → widget mostra `lastError` invece di un dato inventato, nessun crash. Resta aperto (non risolvibile lato app): monitorare un seat aziendale Copilot non ha più alcuna via self-service nota, nemmeno best-effort |
| — | Copilot: login via GitHub OAuth App (loopback PKCE), alternativa sperimentale al PAT | ✅ implementato — ipotesi testata e **confutata** | A valle del test con seat aziendale sopra, analizzato un vecchio prototipo dell'utente (`copilot_hypermiler`, repo privata scaricata in locale, mai eseguita con successo — nessun dato salvato nel checkout). Unica differenza reale rispetto a quello che facevamo già: usa lo stesso `copilot_internal/user` ma con un token OAuth App di GitHub (Authorization Code + PKCE) invece di un PAT. Ipotesi: l'endpoint potrebbe restituire `quota_snapshots` completo solo a quel tipo di token (come l'estensione Copilot Chat di VS Code). Implementato `main/copilot-oauth.ts` (loopback HTTP locale su `127.0.0.1:8123`, browser di sistema via `shell.openExternal` invece di una `BrowserWindow`, client secret mai persistito), nuovo handler IPC `auth:connectCopilotOAuth` in `main.ts` (riusa `copilotService.resolveUsername`, nessuna modifica a `services/copilot.ts`: un token OAuth si usa esattamente come un PAT), nuovo campo non segreto `accounts.copilot.oauthApp.clientId`. **Testato dall'utente con un vero seat aziendale**: il login OAuth riesce (username risolto, widget mostra "Connesso come d-delbrocco_TSGC24"), ma il refresh usage fallisce con lo stesso identico errore del PAT ("risposta senza quota_snapshots"). Confermato non solo dal messaggio ma dalla firma di struttura: la diagnostica auto-segnalazione non ha riaperto una bozza di issue perché `shapeSignature()` coincideva esattamente con quella già segnalata per il PAT (vedi RESEARCH.md §2.2, addendum) — prova che la risposta è strutturalmente identica a prescindere dal tipo di credenziale. **Ipotesi chiusa come confutata**: il tipo di token (PAT o OAuth App) non fa differenza, l'endpoint non espone più dati di quota per seat aziendale in nessun caso. Verificato: 58/58 test unitari (55 esistenti + 3 nuovi su PKCE/URL di autorizzazione in `main/copilot-oauth.test.ts`) |
| — | Copilot: dropdown PAT/OAuth mutuamente esclusiva + "Disconnetti" (Claude e Copilot) | ✅ fatto | A valle del login OAuth sopra, uno screenshot dell'utente ha mostrato che i pannelli PAT e OAuth erano sempre entrambi visibili in Impostazioni, come due connessioni indipendenti — mentre condividono lo stesso slot `accounts.copilot.credentials`. Reintrodotto `accounts.copilot.authMethod` ('pat' \| 'oauth', 2 valori) — stavolta **funzionale** (a differenza della versione rimossa in precedenza, mai letta da nessuna logica): sceglie quale pannello mostrare (`renderer/settings.ts`, `updateCopilotAuthMethodVisibility`) e viene aggiornato in automatico dal metodo davvero usato per l'ultima connessione riuscita (`main.ts`, handler `auth:connectCopilot`/`auth:connectCopilotOAuth`). Aggiunto anche il pulsante "Disconnetti" mancante, per Copilot **e** per Claude (backlog annotato da tempo): nuovi handler IPC `auth:disconnectClaude`/`auth:disconnectCopilot` che azzerano rispettivamente `accounts.claude.session`/`accounts.copilot.credentials` e `enabled`, riusando `refreshAndBroadcast()` già esistente — nessuna modifica a `isClaudeConnected`/`isCopilotConnected` (già derivano lo stato da `enabled`+credenziali) né a `redactSecretsForRenderer`/`preserveRealSecretsOnWrite`. `oauthApp.clientId` non viene cancellato al disconnect (non è un segreto, comodo per riconnettersi). Verificato: 58/58 test unitari invariati (nessuna logica testata è cambiata) — verifica manuale della UI non eseguita in questo ambiente sandbox |
| — | Ricerca: perché il seat aziendale Copilot è irrisolvibile (self-service) | ✅ chiuso | L'utente ha chiesto se qualcun altro fosse riuscito a recuperare la percentuale di consumo per un seat aziendale. Ricerca web: il 1° giugno 2026 GitHub ha sostituito l'intero modello "premium requests" con un nuovo sistema **AI Credits** — è per questo che `copilot_internal/user` ha smesso di restituire `quota_snapshots` (modello ritirato, non un bug isolato). Il pannello "Credits" di VS Code è il nuovo "Copilot spend meter" (VS Code 1.125, giugno 2026), ma **anche Microsoft non lo espone via API**: issue aperta e non risolta su `microsoft/vscode` (#319571) che chiede esattamente questo. L'unica API ufficiale con dati per singolo utente (`ai_credits_used`, Copilot Usage Metrics API) richiede permessi da admin org/enterprise — fuori scope per un developer non-admin (coerente con RESEARCH.md v3, "scenari admin esclusi"). Anche tracker di terze parti aggiornati (`steipete/CodexBar`) hanno questo esplicitamente come lavoro aperto/non risolto. Dettagli e fonti in `RESEARCH.md` §2.3 (addendum). **Conclusione**: per un seat aziendale non esiste ad oggi nessuna via self-service, né nostra né di terzi — non è una lacuna della nostra implementazione. Il percorso personale (§2.1) resta invece valido e non toccato da questo cambiamento |
| — | Impostazioni Copilot: rimosso menu "Metodo di autenticazione" + tooltip PAT (feedback utente) | ✅ fatto | L'utente ha notato che cambiare le 3 opzioni del menu (fine-grained PAT / classic PAT / OAuth Device Flow) non aveva alcun effetto. Causa: `authMethod` non è mai stato letto da `services/copilot.ts` (`fetchUsage` decide il percorso solo da `accountScope`), e non esiste alcun flusso OAuth Device nel codebase — l'unico meccanismo reale, per tutte e 3 le opzioni, è incollare un token nel campo "Personal Access Token". Da `RESEARCH.md` risulta inoltre che l'endpoint ufficiale funziona sia con PAT fine-grained sia classic, quindi il campo era doppiamente ridondante. Rimosso il `<select>` da `renderer/settings.html` e il campo `authMethod` da `CopilotAccountSettings` (`types/index.ts`), dai default (`store/index.ts`) e dallo schema documentato (`ARCHITECTURE.md` §1) — il campo `authMethod` di Claude non è stato toccato (fuori scope). Al suo posto, aggiunta un'icona ⓘ accanto a "Personal Access Token" con tooltip CSS-only (`:hover`/`:focus`, nessuna libreria) che spiega come generare un token fine-grained (permesso "Plan: Read-only") o classic. Verificato: nessun altro file referenziava `authMethod` per Copilot (ricerca globale), nessun test unitario lo copriva — 55/55 test invariati. Verifica visiva in `npm start` non ancora eseguita in questa sessione (l'ambiente di sviluppo assistito non lancia l'app Electron). |
