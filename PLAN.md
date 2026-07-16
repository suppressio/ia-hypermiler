# IA Hypermiler — Piano di sviluppo (3 giorni)

> **Stack:** Electron · Node.js · HTML/CSS/SVG vanilla · Anthropic SDK · electron-store · electron-builder
> **Target:** Cross-platform (Windows, macOS, Linux)
> **Ritmo:** ~4-5 ore al giorno

---

## Prima di iniziare — Setup una tantum (30 min, fuori dai 3 giorni)

Crea la struttura del progetto e il file `CLAUDE.md` che guiderà Claude Code per tutta la sessione.

```
ia-hypermiler/
├── CLAUDE.md               ← memoria di progetto per Claude Code
├── main.js                 ← processo principale Electron
├── preload.js              ← bridge sicuro renderer ↔ main
├── renderer/               ← UI (HTML + CSS + JS vanilla)
│   ├── index.html
│   ├── style.css
│   └── app.js
├── agents/                 ← agenti Claude
│   └── advisor.js
├── services/               ← fetch dati token
│   ├── claude.js
│   └── copilot.js
├── store/                  ← persistenza locale (electron-store)
│   └── index.js
└── package.json
```

---

## Giorno 1 — Ricerca API + Scheletro Electron

**Obiettivo:** capire cosa si può realmente leggere dalle API, e avere l'app che si avvia con dati mock.

### Sessione 1 · Ricerca API con agente (1.5 ore)

Questa è la sessione più critica: usi un agente Claude Code con web search e accesso filesystem per rispondere a domande concrete **prima di scrivere una riga di codice**.

**Prompt da dare all'agente:**

> Cerca su GitHub, nei forum ufficiali Anthropic e Microsoft, nella documentazione pubblica e nelle repository open source (termini: `Claude API usage tokens`, `Anthropic usage endpoint`, `Copilot token consumption API`, `GitHub Copilot billing API`, `copilot-usage-action`) come recuperare il consumo token corrente e la quota mensile per un account Claude Pro e un account GitHub Copilot.
>
> Per ciascuno dimmi: endpoint esatto o URL da fare scraping, autenticazione richiesta (API key, OAuth, cookie di sessione), frequenza di aggiornamento dei dati, formato della risposta (JSON, HTML, altro). Se non esiste un endpoint ufficiale, dimmi qual è il workaround più usato dalla community.
>
> Scrivi i risultati in `RESEARCH.md`.

**Scenari probabili da tenere a mente:**

- **Claude:** l'API Anthropic non espone un endpoint pubblico di usage per utenti Pro. Il workaround più diffuso è il parsing della pagina `console.anthropic.com/settings/usage` con sessione autenticata (cookie). Per piani Team/Enterprise esiste `GET /v1/usage` — l'agente cercherà conferme aggiornate.
- **Copilot:** GitHub espone `GET /orgs/{org}/copilot/usage` per organizzazioni, ma non per account personali. Il workaround è la pagina `github.com/settings/billing`. L'agente verificherà cosa è cambiato di recente.

> ⚠️ **Punto di rischio principale:** se entrambe le API non espongono dati utili e il workaround è fragile, meglio saperlo subito e ridurre lo scope a un solo servizio (preferibilmente Claude).

L'agente produce `RESEARCH.md`. Questo documento determina l'architettura del Giorno 2.

---

### Sessione 2 · Scheletro Electron con dati mock (2.5 ore)

Con Claude Code in **plan mode**, costruisci l'app shell alimentata da dati fittizi hardcodati.

**`main.js`**
- Finestra principale 800×600
- `Tray` icon con menu contestuale (show/hide/quit)
- `ipcMain` per i canali dati

**`preload.js`**
- Esponi solo i canali necessari via `contextBridge`
- Mai `nodeIntegration: true`

**`renderer/`**
- UI con i tre blocchi: token oggi, grafico settimanale, proiezione mensile
- Grafico in SVG/Canvas vanilla — zero librerie esterne (Electron è già pesante)

**`store/index.js`**
- `electron-store` per persistere: API key, data rinnovo, quota mensile

**✅ Fine Giorno 1:** app avviabile con `npm start`, tray icon funzionante, UI visibile con mock data.

---

## Giorno 2 — Integrazione dati reali + Agente consigli

**Obiettivo:** sostituire i mock con dati reali e integrare l'agente che genera i consigli.

### Sessione 1 · Services layer (2 ore)

Basandoti su `RESEARCH.md`, implementa i due service con interfaccia uniforme:

```js
// Interfaccia attesa da entrambi i service
export async function fetchUsage(credentials) {
  // Ritorna: { used, total, resetDate, dailyHistory: [...] }
}
```

**Autenticazione:**
- Se API key → salva in `electron-store` con `encryptionKey`, non esporre mai nel renderer
- Se cookie di sessione → usa `electron-session` o una `BrowserWindow` nascosta per il login OAuth; non chiedere mai all'utente di incollare cookie a mano

Testa ogni service da terminale con `node services/claude.js` prima di collegarlo a Electron.

---

### Sessione 2 · Logica budget + Agente advisor (2 ore)

**Logica di calcolo (`budget.js`):**

```js
function dailyBudget({ used, total, resetDate }) {
  const daysLeft = differenceInDays(resetDate, today());
  const remaining = total - used;
  return Math.floor(remaining / daysLeft); // token/giorno
}
```

**Agente consigli (`agents/advisor.js`):**
- Chiamata all'API Anthropic con il consumo degli ultimi 7 giorni come contesto
- System prompt che richiede consigli pratici e specifici (non generici)
- Risultato cachato su `electron-store`, aggiornato una volta al giorno
- Visualizzato in un pannello "Consigli del giorno" nella UI

**✅ Fine Giorno 2:** dati reali nella UI, calcolo budget corretto, consigli generati dall'agente.

---

## Giorno 3 — Rifinitura, notifiche, build

**Obiettivo:** app robusta, notifiche utili, pacchetto distribuibile.

### Sessione 1 · Notifiche e robustezza (2 ore)

- **Notifica di sistema** (`Notification` API di Electron) quando il consumo giornaliero supera l'80% del budget
- **Gestione errori:** se le API non rispondono, mostra l'ultimo dato noto con timestamp — mai schermata bianca
- **Auto-refresh** ogni 30 minuti in background via `setInterval` nel main process (senza finestra aperta)
- **Onboarding:** al primo avvio, finestra di configurazione per API key e data di rinnovo

---

### Sessione 2 · Subagent review + Build (2 ore)

**Subagent di code review** prima del build:

> Leggi tutti i file in `agents/`, `services/` e `main.js`. Segnala: chiamate API senza timeout, segreti esposti nel renderer, path non cross-platform, memory leak nei setInterval. Scrivi le correzioni direttamente.

**Build cross-platform con `electron-builder`:**

```json
"build": {
  "appId": "com.tuonome.ia-hypermiler",
  "mac":   { "target": "dmg" },
  "win":   { "target": "nsis" },
  "linux": { "target": "AppImage" }
}
```

> 💡 Su GitHub Actions puoi fare il build multi-piattaforma in parallelo — è la strada più rapida per avere `.dmg`, `.exe` e `.AppImage` dallo stesso commit senza tre macchine fisiche.

**✅ Fine Giorno 3:** app buildabile, notifiche funzionanti, codice revisionato dall'agente.

---

## Stack di riferimento

| Componente | Scelta | Motivo |
|---|---|---|
| Shell | Electron | già noto, cross-platform |
| UI | HTML/CSS/SVG vanilla | zero bundle, avvio rapido |
| Persistenza | electron-store | semplice, cifrabile |
| Agente consigli | Anthropic SDK (Node) | già usato nel corso |
| Build | electron-builder + GH Actions | multi-piattaforma senza VM |
| Claude Code | plan mode + subagent review | come da corso |

---

## Cosa resta fuori (da valutare dopo)

- Autenticazione OAuth nativa per Copilot (se il workaround cookie non è abbastanza stabile)
- Supporto account multipli (più API key / più servizi)
- Auto-update dell'app (`electron-updater`)
- Grafico storico oltre 7 giorni
- Integrazione nativa tray icon avanzata (animazioni, badge contatore)
