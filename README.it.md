🌐 [English](README.md) | **Italiano**

# IA Hypermiler

App desktop Electron (Windows / macOS / Linux) che monitora il consumo di token AI — Claude e GitHub Copilot — e calcola un budget giornaliero ottimale per non esaurire la quota periodica prima del rinnovo. Pensata per il singolo sviluppatore che vuole tenere sotto controllo il proprio utilizzo, non per un admin che monitora un team.

Mostra un widget sempre visibile con l'utilizzo corrente, il consumo giornaliero rispetto al budget ideale, un indice di efficienza con rating a stelle, una proiezione a fine periodo e consigli ricavati dai tuoi dati reali. L'interfaccia è disponibile in **italiano e inglese** (automatica dalla lingua del sistema, oppure scelta nelle Impostazioni).

> Progetto personale in sviluppo attivo, costruito in pair programming con Claude. Le pre-release (`v0.x-beta`) sono pubblicate su GitHub; vedi "Stato del progetto" più sotto per cosa funziona oggi.

---

## Funzionalità

- **Più account, di qualunque provider** — per esempio due account Claude e uno Copilot, ognuno con la propria sessione isolata; "Disconnetti" cancella davvero la sessione salvata.
- **Un ritmo per ogni account** — ogni account ha il suo calendario di lavoro: per esempio un account personale senza vincoli e uno di lavoro calcolato sui giorni lavorativi (intera, mezza o riposo per ogni giorno della settimana).
- **Una vista propria, non il calco della dashboard del provider** — consumo giorno per giorno rispetto alla quota ideale, lista delle finestre di quota con un verdetto (in linea / a rischio / esaurita), gauge del consumo istantaneo, rating di efficienza.
- **Valore per token** (Claude, opt-in) — legge le sessioni Claude Code locali (solo conteggi di token e nomi dei tool, mai il contenuto dei messaggi) per mostrare quanti token produci per ogni 1% di quota e, quando il segnale è netto, perché stai consumando più in fretta.
- **Controllo aggiornamenti** — all'avvio e ogni 24 ore; il pacchetto giusto per il tuo sistema si apre nel browser.
- **Segnalazione dei cambi di formato** — se un provider cambia il formato delle risposte, si apre una bozza di issue GitHub precompilata (solo struttura, mai valori reali) da rivedere tu.

## Requisiti

- Node.js 22 LTS o superiore
- npm

## Installazione

```bash
git clone https://github.com/suppressio/ia-hypermiler.git
cd ia-hypermiler
npm install
```

Oppure scarica un pacchetto già pronto (`.exe`, `.dmg`, `.AppImage`, `.deb`) dalle [Release](https://github.com/suppressio/ia-hypermiler/releases).

## Avvio in sviluppo

```bash
npm start
```

Compila TypeScript (main process + renderer) e avvia Electron. Al primo avvio non ci sono account: apri le Impostazioni (icona ingranaggio nel widget, o dal tray) e aggiungi un account Claude e/o GitHub Copilot.

## Build, lint e test

```bash
npm run build      # TypeScript (main + renderer) + asset statici in dist/
npm run lint       # ESLint con regole basate sui tipi (deve restare a zero segnalazioni)
npm run typecheck  # tsc --noEmit su ogni progetto TypeScript
npm test           # build + test unitari (runner integrato node:test)
npm run coverage   # test con la coverage integrata di Node
```

- I **test unitari** girano sempre e non toccano mai la rete (`fetch` e l'SDK sono simulati).
- I **test di integrazione** (`tests/integration/`) chiamano le vere API di Claude e GitHub e **si saltano da soli** se mancano le credenziali. Per attivarli in locale — **senza mai incollare credenziali in chat o nei commit**:

```bash
cp .env.test.example .env.test
# compila .env.test con le tue credenziali (vedi i commenti nel file)
npm test
```

`.env.test` è già in `.gitignore` e viene caricato automaticamente da Node (`--env-file-if-exists`), senza dipendenze aggiuntive.

## Packaging

```bash
npm run package
```

Build + `electron-builder`: produce l'installer per la piattaforma corrente (`.dmg` su macOS, `.exe`/NSIS su Windows, `.AppImage` e `.deb` su Linux) in `release/`.

### Build multipiattaforma (GitHub Actions)

`.github/workflows/build.yml` builda in parallelo su macOS/Windows/Linux dallo stesso commit. Parte pushando un tag `v*` (es. `v0.4.0-beta`) o manualmente dalla tab Actions: lint, test, poi i pacchetti vengono allegati alla Release GitHub del tag. I pacchetti non sono firmati: macOS Gatekeeper e Windows SmartScreen mostrano un avviso all'installazione.

---

## Struttura del progetto

```
ia-hypermiler/
├── main.ts, preload.ts        ← processo principale Electron + bridge sicuro verso il renderer
├── main/                      ← finestre, tray, login Claude, OAuth, logica per provider, i18n del main
├── renderer/                  ← widget e finestra Impostazioni (HTML/CSS/TS vanilla) + i18n dell'interfaccia
├── services/                  ← fetch dell'utilizzo Claude/Copilot, sessioni locali, controllo aggiornamenti (+ test)
├── diagnostics/               ← segnalazione dei cambi di formato via bozza di issue GitHub
├── store/                     ← persistenza locale (electron-store cifrato), default, normalizzazione, migrazione
├── budget.ts                  ← calcolo budget/efficienza/previsionale (+ budget.test.ts)
├── agents/                    ← agente Claude per i consigli d'uso (stub)
├── types/                     ← tipi TypeScript condivisi
├── tests/                     ← helper dei test + test di integrazione attivati da credenziali locali
└── *.md / *.it.md             ← documentazione di progetto, inglese + italiano
```

Approfondimenti:

- [`ARCHITECTURE.it.md`](./ARCHITECTURE.it.md) — modello dati, finestre, indicatori, estensibilità
- [`RESEARCH.it.md`](./RESEARCH.it.md) — cosa si può leggere davvero dalle API di Claude e Copilot, e con quali limiti
- [`EVOLUTION.it.md`](./EVOLUTION.it.md) — retrospettiva e direzioni future con analisi costi/benefici
- [`PLAN.it.md`](./PLAN.it.md) — il piano originale giorno per giorno
- [`CLAUDE.md`](./CLAUDE.md) — memoria di progetto per Claude Code (in inglese): stack, regole, milestone

---

## Sicurezza e credenziali

- `nodeIntegration: false` e `contextIsolation: true` sempre attivi: il renderer non ha mai accesso diretto a Node.js; ogni valore che arriva da lui via IPC viene validato.
- La sessione Claude si ottiene con un vero login in una finestra embedded (classico o SSO), in una partition dedicata all'account: l'app non chiede mai di incollare un cookie.
- Il token GitHub Copilot è un Personal Access Token (fine-grained, "Plan" in sola lettura) o un token di OAuth App, salvato cifrato in locale.
- Nessuna credenziale viene mai esposta al renderer o registrata nei log; `.env.test` è escluso da git.

## Stato del progetto

- ✅ Dati reali da Claude (endpoint interno + sessione) e Copilot (API ufficiale per i piani personali; per i seat aziendali non esiste una fonte dati self-service, vedi `RESEARCH.it.md`)
- ✅ Più account, interfaccia multilingua (IT/EN), controllo aggiornamenti, diagnostica dei cambi di formato
- ✅ Visualizzazioni proprie: consumo giornaliero vs budget, verdetti per finestra, gauge istantaneo, rating, valore per token
- ✅ TypeScript severo (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, …), ESLint con controllo dei tipi a zero segnalazioni, test unitari su tutti i moduli puri
- ✅ CI multipiattaforma che pubblica le pre-release
- 🟨 Agente consigli (`agents/advisor.ts`) ancora uno stub
- ⬜ Prossimi passi: contratto IPC condiviso, poi estrazione da `main.ts` di un nucleo testabile per lavorare test-first

## Licenza

[MIT](./LICENSE) © 2026 Daniele 'suppressio'. Il testo legale della licenza è in inglese.
