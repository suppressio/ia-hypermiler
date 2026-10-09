🌐 [English](DEVELOPMENT.md) | **Italiano**

# Sviluppo

Come compilare IA Hypermiler dai sorgenti, testarlo e creare i pacchetti. Per cosa fa l'app e come leggerla, vedi il [README](README.it.md).

## Requisiti

- Node.js 22 LTS o superiore
- npm

## Avvio dai sorgenti

```bash
git clone https://github.com/suppressio/ia-hypermiler.git
cd ia-hypermiler
npm install
npm start
```

`npm start` compila TypeScript (main process + renderer) e avvia Electron. Al primo avvio non ci sono account: apri le Impostazioni e aggiungine uno.

## Build, lint e test

```bash
npm run build      # TypeScript (main + renderer) + asset statici in dist/
npm run lint       # ESLint con regole basate sui tipi (deve restare a zero segnalazioni)
npm run typecheck  # tsc --noEmit su ogni progetto TypeScript
npm test           # build + test unitari (runner integrato node:test)
npm run coverage   # test con la coverage integrata di Node
```

- I **test unitari** girano sempre e non toccano mai la rete (`fetch` e l'SDK sono simulati). I dati di test sono solo sintetici.
- I **test di integrazione** (`tests/integration/`) chiamano le vere API di Claude e GitHub e **si saltano da soli** se mancano le credenziali. Per attivarli in locale, **senza mai incollare credenziali in chat o nei commit**:

```bash
cp .env.test.example .env.test
# compila .env.test con le tue credenziali (vedi i commenti nel file)
npm test
```

`.env.test` è già in `.gitignore` e viene caricato automaticamente da Node (`--env-file-if-exists`), senza dipendenze aggiuntive.

## Packaging

```bash
npm run package       # installer per la piattaforma corrente in release/
npm run package:test  # build di prova locale: lint + test, poi pacchetti .deb e Windows in release/test/
```

- `npm run package`: build + `electron-builder` → `.dmg` su macOS, `.exe`/NSIS su Windows, `.AppImage` e `.deb` su Linux, in `release/`.
- `npm run package:test`: versione `<versione>.dev.<timestamp>`, mai pubblicata. L'`.exe` NSIS per Windows richiede Wine (o Windows); senza, uno `.zip` pronto da avviare. È il modo consigliato per provare una modifica su una macchina reale.

### Build multipiattaforma (GitHub Actions)

`.github/workflows/build.yml` builda in parallelo su macOS, Windows e Linux dallo stesso commit:

- un tag `v*` pushato (es. `v0.4.0-beta`) → lint, test, pacchetti allegati alla Release GitHub del tag;
- un avvio manuale (`gh workflow run build.yml`, o la tab Actions) → build di prova: pacchetti solo come artifact del run (14 giorni), nessuna release, nessuna notifica di aggiornamento.

I pacchetti non sono firmati: macOS Gatekeeper e Windows SmartScreen mostrano un avviso all'installazione.

---

## Struttura del progetto

```
ia-hypermiler/
├── main.ts, preload.ts        ← processo principale Electron + bridge sicuro verso il renderer
├── main/                      ← finestre, tray, login Claude, OAuth, logica per provider, ritmo dei refresh, i18n del main
├── renderer/                  ← widget e finestra Impostazioni (HTML/CSS/TS vanilla) + i18n dell'interfaccia
├── services/                  ← fetch dell'utilizzo Claude/Copilot, sessioni locali, controllo aggiornamenti (+ test)
├── diagnostics/               ← segnalazione dei cambi di formato e file di report diagnostico
├── store/                     ← persistenza locale (electron-store cifrato), default, normalizzazione, migrazione
├── budget.ts                  ← calcolo budget/efficienza/previsionale/grafico (+ budget.test.ts)
├── agents/                    ← agente Claude per i consigli d'uso (stub)
├── types/                     ← tipi TypeScript condivisi
├── tests/                     ← helper dei test + test di integrazione attivati da credenziali locali
├── docs/screenshots/          ← screenshot del README (dati sintetici)
└── *.md / *.it.md             ← documentazione, inglese + italiano
```

Approfondimenti:

- [`ARCHITECTURE.it.md`](./ARCHITECTURE.it.md) — modello dati, finestre, indicatori, estensibilità
- [`RESEARCH.it.md`](./RESEARCH.it.md) — cosa si può leggere davvero dalle API di Claude e Copilot, e con quali limiti
- [`EVOLUTION.it.md`](./EVOLUTION.it.md) — retrospettiva e direzioni future con analisi costi/benefici
- [`PLAN.it.md`](./PLAN.it.md) — il piano originale giorno per giorno
- [`CLAUDE.md`](./CLAUDE.md) — memoria di progetto per Claude Code (in inglese): stack, regole, milestone

## Regole di sicurezza

- `nodeIntegration: false` e `contextIsolation: true` sempre attivi: il renderer non ha mai accesso diretto a Node.js; ogni valore che arriva da lui via IPC viene validato.
- I segreti (sessione Claude, token Copilot) vivono solo nel main process e nello store cifrato: vengono oscurati prima di arrivare al renderer e non finiscono mai nei log.
- Gli URL aperti nel browser sono costruiti nel main process da prefissi fissi, mai presi dal renderer.

## Stato del progetto

- ✅ Dati reali da Claude (endpoint interno + sessione) e Copilot (piani personali e licenze aziendali su un tenant `.ghe.com`; una licenza su github.com gestita da un'enterprise non espone dati, vedi `RESEARCH.it.md`)
- ✅ Più account, interfaccia italiano/inglese, controllo aggiornamenti, diagnostica dei cambi di formato, report diagnostico
- ✅ Visualizzazioni proprie: consumo giornaliero vs budget mobile, verdetti per finestra, gauge istantaneo, rating, valore per token
- ✅ TypeScript severo (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, …), ESLint con controllo dei tipi a zero segnalazioni, test unitari su tutti i moduli puri
- ✅ CI multipiattaforma che pubblica le pre-release; build di prova locali
- 🟨 Agente consigli (`agents/advisor.ts`) ancora uno stub
- ⬜ Prossimi passi: contratto IPC condiviso, poi estrazione da `main.ts` di un nucleo testabile per lavorare test-first
