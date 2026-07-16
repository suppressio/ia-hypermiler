# IA Hypermiler

App desktop Electron (Windows / macOS / Linux) che monitora il consumo di token AI — Claude e GitHub Copilot — e calcola un budget giornaliero ottimale per non esaurire la quota periodica prima del rinnovo. Pensata per il singolo sviluppatore che vuole tenere sotto controllo il proprio utilizzo, non per un admin che monitora un team.

Mostra un widget sempre visibile con l'utilizzo corrente, l'andamento settimanale/mensile, un indice di efficienza, una proiezione a fine periodo e consigli d'uso generati da Claude.

> Progetto personale in sviluppo attivo, costruito in pair-programming con Claude. Non è pronto per un uso in produzione: vedi "Stato del progetto" più sotto per cosa funziona oggi e cosa manca ancora.

---

## Requisiti

- Node.js 20 LTS o superiore (consigliato 22 LTS)
- npm

## Installazione

```bash
git clone https://github.com/suppressio/ia-hypermiler.git
cd ia-hypermiler
npm install
```

## Avvio in sviluppo

```bash
npm start
```

Compila TypeScript (main process + renderer) e avvia Electron. Al primo avvio l'app parte senza account collegati: apri le Impostazioni (icona ingranaggio nel widget, o dal tray) per collegare Claude e/o GitHub Copilot.

## Build

```bash
npm run build
```

Compila `tsconfig.json` (main process: `main.ts`, `preload.ts`, `services/`, `store/`, `budget.ts`, `agents/`) e `tsconfig.renderer.json` (renderer, ES module nativo — nessun bundler), poi copia gli asset statici (`html`/`css`) del renderer in `dist/renderer/` tramite `scripts/copy-assets.js`. Output sempre in `dist/` (gitignored).

## Test

```bash
npm test
```

Compila il progetto ed esegue i test con il runner nativo di Node (`node:test`, nessuna libreria di test esterna):

- **Test unitari** (`budget.test.ts`, `services/claude.test.ts`, `services/copilot.test.ts`): logica pura e parsing/gestione errori con `fetch` mockato. Girano sempre, non toccano la rete.
- **Test di integrazione** (`tests/integration/`): chiamano le vere API di Claude e GitHub Copilot. Si **auto-skippano** se mancano le credenziali.

Per attivare i test di integrazione in locale, **mai incollando credenziali in chat o in commit**:

```bash
cp .env.test.example .env.test
# compila .env.test con le tue credenziali (vedi commenti nel file)
npm test
```

`.env.test` è già in `.gitignore` e viene caricato automaticamente da Node (`--env-file-if-exists`), senza dipendenze aggiuntive.

## Packaging

```bash
npm run package
```

Build + `electron-builder`: produce l'installer per la piattaforma corrente (`.dmg` su macOS, `.exe`/NSIS su Windows, `.AppImage` su Linux).

---

## Struttura del progetto

```
ia-hypermiler/
├── main.ts, preload.ts        ← processo principale Electron + bridge sicuro verso il renderer
├── main/                      ← finestre (skin filled/transparent-digital), tray, login Claude
├── renderer/                  ← widget e finestra impostazioni (HTML/CSS/TS vanilla)
├── services/                  ← fetch usage da Claude e Copilot (+ relativi test)
├── store/                     ← persistenza locale (electron-store, cifrata)
├── budget.ts                  ← calcolo budget/efficienza/previsionale (+ budget.test.ts)
├── agents/                    ← agente Claude per i consigli d'uso (in arrivo)
├── types/                     ← tipi condivisi TypeScript
├── tests/integration/         ← test contro le vere API, gated da credenziali locali
└── CLAUDE.md, ARCHITECTURE.md, RESEARCH.md   ← documentazione di progetto (vedi sotto)
```

Per i dettagli — ricerca sulle API disponibili, decisioni architetturali, regole di sviluppo — vedi:

- [`RESEARCH.md`](./RESEARCH.md) — cosa si può leggere realmente dalle API di Claude e Copilot, e con quali limiti
- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — modello dati, finestre, indicatori, hook di estensibilità futura
- [`CLAUDE.md`](./CLAUDE.md) — memoria di progetto: stack, regole architetturali, stato avanzamento dettagliato

---

## Sicurezza e credenziali

- `nodeIntegration: false` e `contextIsolation: true` sempre attivi: il renderer non ha mai accesso diretto a Node.js.
- La sessione Claude si ottiene con un vero login in una finestra embedded (classico o SSO): l'app non chiede mai di incollare un cookie a mano.
- Il token GitHub Copilot è un Personal Access Token fine-grained (permesso "Plan", sola lettura), fornito dall'utente e salvato cifrato in locale.
- Nessuna credenziale viene mai esposta nel renderer o loggata; `store/` e `.env.test` sono esclusi da git.

## Stato del progetto

Sviluppo per sessioni, tracciato in dettaglio nella tabella "Stato avanzamento" di [`CLAUDE.md`](./CLAUDE.md). In sintesi:

- ✅ Ricerca API, architettura, scheletro Electron con le due skin, tray, impostazioni complete
- ✅ Migrazione a TypeScript (`strict: true`, zero `any`)
- ✅ `services/claude.ts` e `services/copilot.ts` con dati reali: endpoint interno + sessione per Claude, API ufficiale per Copilot personale, endpoint best-effort per seat Copilot aziendali (segnalato in UI come sperimentale)
- ✅ Fallback su ultimo dato noto con timestamp se una fetch fallisce; storico giornaliero costruito localmente (né Claude né Copilot lo espongono via API)
- ✅ Test unitari su logica di budget e service (mock, no rete) + test di integrazione predisposti
- 🟨 Agente consigli (`agents/advisor.ts`) ancora uno stub: da collegare all'SDK Anthropic reale
- ⬜ Rifinitura notifiche/robustezza e build cross-platform finale (in arrivo)

Limite noto: i test di integrazione e l'avvio reale dell'app non sono ancora stati verificati contro account Claude/Copilot veri — vanno provati in locale (`npm test` con `.env.test` compilato, `npm start` con un account collegato dalle Impostazioni).

## Licenza

Privato / non ancora licenziato (`UNLICENSED` in `package.json`). Il codice è visibile pubblicamente ma non ne è concesso il riuso senza permesso esplicito dell'autore.
