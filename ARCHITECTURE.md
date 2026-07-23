# ARCHITECTURE.md — Struttura dell'applicazione (Giorno 1, Sessione 2 — Plan Mode)

> Documento di design prodotto in **plan mode**, come da flusso di lavoro in `CLAUDE.md`: descrive cosa verrà costruito, non contiene ancora implementazione. Da confermare prima di passare al codice.
> Si basa sui vincoli reali emersi in `RESEARCH.md` (v3): Claude espone soprattutto **percentuali di utilizzo** su finestre multiple e concorrenti (5 ore + settimanale), non un pool di token con un unico totale; Copilot espone invece contatori discreti (premium requests / crediti) su un ciclo di fatturazione mensile.

---

## 0. Una decisione di design che precede tutto il resto

Il concept originale in `CLAUDE.md` (`{ used, total, resetDate }`) assume **un solo contatore per servizio**. La ricerca mostra che non basta:

- **Claude**: 2-3 finestre di quota concorrenti e indipendenti — `five_hour` (rolling 5h), `seven_day` (rolling 7gg, tutti i modelli), `seven_day_opus` (rolling 7gg, solo Opus). Ognuna ha una propria `utilization` (%) e un proprio `resets_at`. Non c'è un "totale token mensile" da leggere dall'account: il rinnovo mensile esiste solo come **data di fatturazione dell'abbonamento**, scollegata dalle finestre di utilizzo.
- **Copilot**: un contatore discreto (`premium_requests` + `ai_credit`) legato al ciclo di fatturazione mensile — qui il modello "used/total/resetDate" originale funziona bene così com'è.

**Proposta:** generalizzare l'interfaccia dei service da un singolo contatore a una **lista di "finestre di quota"** (`quotaWindows`) per account, ciascuna con il proprio tipo di periodo (`rolling-hours`, `rolling-days`, `billing-cycle`) e la propria unità di misura (`percentage` per Claude, `count` per Copilot). L'indicatore "Token/gg" richiesto va quindi ridefinito come **"% di quota consumata per giorno lavorativo"** per Claude, e come "richieste premium consumate/giorno lavorativo" per Copilot — normalizzando comunque tutto a una percentuale per il confronto visivo nel widget quando serve mostrare un unico numero aggregato.

Questo va confermato esplicitamente perché cambia l'interfaccia `fetchUsage()` già scritta in `CLAUDE.md`:

```js
// Proposta di interfaccia estesa (sostituisce { used, total, resetDate, dailyHistory })
{
  planTier: string,
  subscriptionRenewsAt: Date | null,        // data di fatturazione, se nota
  quotaWindows: Array<{
    id: string,                              // 'five_hour' | 'seven_day' | 'seven_day_opus' | 'premium_requests' | ...
    label: string,
    periodType: 'rolling-hours' | 'rolling-days' | 'billing-cycle',
    periodLength: number,                    // es. 5, 7, o giorni del ciclo
    unit: 'percentage' | 'count',
    used: number,                            // 0-100 se percentage, valore assoluto se count
    total: number | null,                    // null se il servizio non espone un totale (caso Claude)
    resetsAt: Date,
  }>,
  dailyHistory: Array<{ date: string, perWindow: Record<string, number> }>,
}
```

Se preferisci restare più semplici e trattare solo la finestra più rilevante per servizio (es. solo `seven_day` per Claude, ignorando 5h e Opus), possiamo farlo come opzione di scope ridotto — ma perderesti la vista "sto per sforare la finestra delle 5 ore proprio oggi", che è probabilmente l'informazione più operativa per non restare bloccati a metà giornata.

---

## 1. Impostazioni (settings) — schema dati

Estende `store/index.ts`. Tutto ciò che è segreto (session cookie, PAT, token) resta cifrato via `encryptionKey` di `electron-store` e non passa mai dal renderer se non tramite IPC verso il main.

```js
{
  accounts: {
    claude: {
      enabled: boolean,
      accountScope: 'personal' | 'organization',   // determina solo messaggi/aspettative in UI, non il meccanismo di accesso (vedi RESEARCH.md)
      authMethod: 'password' | 'google' | 'sso',
      session: {
        sessionKey: string,        // cifrato
        organizationId: string | null, // risolto automaticamente al login (GET /api/organizations)
        capturedAt: string,        // ISO date
        expiresAt: string | null,  // stimata ~30gg, da ri-validare
      },
      planTier: 'free' | 'pro' | 'max_5x' | 'max_20x' | 'team' | 'enterprise',
      subscription: {
        renewalRule: { type: 'dayOfMonth', day: number } | { type: 'rrule', rrule: string },
      },
    },
    copilot: {
      enabled: boolean,
      accountScope: 'personal' | 'organization',   // qui SÌ cambia il meccanismo: personale = API ufficiale, org-managed = endpoint interno best-effort
      authMethod: 'pat' | 'oauth',  // sceglie quale pannello di connessione mostrare in Impostazioni; funzionale (a differenza dell'omonimo campo Claude sopra), aggiornato automaticamente dall'ultima connessione riuscita
      credentials: { token: string, username: string | null },  // token cifrato (PAT o, in via sperimentale, un access token OAuth App — vedi main/copilot-oauth.ts)
      oauthApp: { clientId: string | null },  // client ID di una GitHub OAuth App registrata dall'utente; non è un segreto, il client secret non viene mai persistito
      manualQuota: number, // l'API di billing non espone il totale del piano: valore inserito dall'utente
      planTier: 'free' | 'individual' | 'pro_plus' | 'business' | 'enterprise',
      subscription: {
        renewalRule: { type: 'dayOfMonth', day: number } | { type: 'rrule', rrule: string },
      },
      experimentalWarningAcknowledged: boolean, // per il caso seat aziendale via endpoint interno
    },
  },

  workSchedule: {
    days: {
      mon: 'full' | 'half' | 'off',
      tue: 'full' | 'half' | 'off',
      wed: 'full' | 'half' | 'off',
      thu: 'full' | 'half' | 'off',
      fri: 'full' | 'half' | 'off',
      sat: 'full' | 'half' | 'off',
      sun: 'full' | 'half' | 'off',
    },
    hoursPerDay: number, // semplificato da intervallo inizio/fine su feedback utente (Giorno 2):
                         // budget.ts lavora a granularità giorno/mezza-giornata e non usa ancora
                         // orari puntuali; riservato per un futuro pacing infra-giornaliero (es.
                         // finestra Claude delle 5 ore).
  },

  ui: {
    windowStyle: 'filled' | 'transparent-digital',
    alwaysOnTop: boolean,
    accentColor: string,
    bounds: { x, y, width, height },       // posizione/dimensione persistita
    chartRange: 'week' | 'month',
    notificationThresholdPercent: number,  // default 80, configurabile
  },

  history: {
    // append-only, un record per giorno per finestra di quota; retention configurabile (default 90gg) per non far crescere il file all'infinito
    dailyUsage: Array<{ date: string, accountId: 'claude' | 'copilot', windowId: string, used: number }>,
  },

  advisorCache: { generatedAt: string, adviceText: string },

  meta: { notifiedToday: Record<string, boolean> }, // flag anti-doppia-notifica per servizio/finestra
}
```

Sezioni del pannello impostazioni (finestra separata `renderer/settings.html`, aperta dal tray o da un'icona ingranaggio nel widget):

1. **Account e sessioni** — per Claude e Copilot: stato connessione, metodo (password/SSO/PAT/OAuth device), pulsante "Connetti/Riconnetti" che apre una `BrowserWindow` di login per Claude o il device-flow per Copilot, data di scadenza sessione stimata, toggle "seat aziendale" con avviso automatico se attivo su Copilot ("funzionalità sperimentale, può interrompersi senza preavviso").
2. **Piano e rinnovo** — tipo piano, giorno di rinnovo abbonamento (selettore semplice "giorno del mese"; dietro le quinte salvato come RRULE minimale `FREQ=MONTHLY;BYMONTHDAY=n` così in futuro si possono aggiungere ricorrenze diverse senza cambiare schema).
3. **Calendario di lavoro** — 7 toggle giorno con 3 stati (pieno/mezza/riposo) + switch opzionale per ore lavorative (inizio/fine). Usato per calcolare budget e proiezioni su "giorni/ore lavorative rimanenti", non su giorni di calendario.
4. **Aspetto** — stile finestra (le due skin descritte sotto), always-on-top, colore accento, intervallo grafico (settimana/mese) di default.
5. **Notifiche** — soglia percentuale di allarme (default 80%, come da `CLAUDE.md`, ma ora configurabile), eventualmente per-finestra (es. avviso separato per il limite 5h di Claude).
6. **Avanzate** — placeholder per le evoluzioni future (vedi §5): abilitazione futura server locale, export dati.

---

## 2. Finestra principale — le due "skin"

Entrambe leggono dagli stessi dati (IPC dal main, nessuna duplicazione di logica) e cambiano solo `renderer/style.css` + flag di creazione della `BrowserWindow`.

**Stile "pieno" (classico):**
`frame: true`, `transparent: false`, controlli di sistema nativi sempre visibili, sfondo opaco, layout a blocchi con bordi.

**Stile "trasparente/digitale":**
`frame: false`, `transparent: true`, `titleBarStyle` nascosto. Numeri/barre in stile HUD (font monospazio, glow leggero — restando comunque sobri per rispettare "no animazioni" di `CLAUDE.md`: niente pulsazioni, solo contrasto/opacità statici). Pulsanti di sistema (chiudi/riduci) ricreati come controlli custom in overlay, `opacity: 0` di default e `opacity: 1` solo on-hover via CSS, con `-webkit-app-region: drag` sull'area libera per permettere lo spostamento finestra senza barra del titolo nativa.

**Always-on-top:** toggle in impostazioni e nel menu del tray, applicato con `win.setAlwaysOnTop(bool, 'floating')`; persistito e riapplicato all'avvio.

---

## 3. Contenuto informativo del widget

Corpo centrale — numero grande "current usage": la finestra di quota più critica al momento (quella con `utilization` più vicina al reset o più alta in %), con etichetta di quale finestra è (es. "Limite settimanale: 62%").

Sotto, un grafico a barre/linea dei **picchi giornalieri**, selezionabile settimana/mese, con overlay della linea di budget ideale (pacing lineare) per vedere a colpo d'occhio se si è sopra o sotto.

Riquadro metriche:

- **Token (o % quota)/giorno lavorativo corrente** — richiesto
- **Andamento settimanale** — richiesto (il grafico sopra)
- **Indice di efficienza** — richiesto. Proposta di formula: rapporto tra ritmo di consumo ideale e ritmo reale, calcolato sulle **unità lavorative** trascorse (non giorni di calendario):
  `efficiencyIndex = (idealPace) / (actualPace)` dove `idealPace = 100% / unitàLavorativeTotaliNelPeriodo` e `actualPace = utilizationAttuale / unitàLavorativeTrascorse`. Valore intorno a 1 = in linea; >1 = si sta usando meno del previsto (margine per usare di più); <1 = si sta consumando più veloce del sostenibile.
- **Previsionale** — richiesto: proiezione dell'utilizzo a fine periodo, estrapolando il ritmo medio reale sulle unità lavorative rimanenti.
- **Giorni alla scadenza** — richiesto: sia giorni di calendario sia giorni **lavorativi** rimanenti (spesso più utile).
- **Giorni di autonomia stimati** *(aggiunta)* — a quanti giorni lavorativi si esaurirà la quota mantenendo il ritmo attuale, utile quando è < giorni alla scadenza (segnale di rischio più diretto del solo indice di efficienza).
- **Picco massimo vs media giornaliera** *(aggiunta)* — per capire se i problemi sono concentrati in giornate anomale o distribuiti.
- **Streak sotto budget** *(aggiunta)* — giorni lavorativi consecutivi entro il budget ideale, per rinforzo positivo leggero (in linea con "sobria", quindi solo un numero, non badge/gamification vistosa).
- **Vista combinata multi-servizio** *(aggiunta, se entrambi Claude e Copilot attivi)* — un indicatore di "salute generale" che aggrega le percentuali delle finestre più critiche dei due servizi, utile per uno sguardo d'insieme prima di aprire il dettaglio.
- **Tips/consigli del giorno** — richiesto: pannello alimentato da `agents/advisor.ts` (Claude Sonnet, cache 24h come da `CLAUDE.md`), che ora riceverà come contesto anche calendario di lavoro ed efficienza calcolata, non solo `dailyHistory` grezzo.

---

## 4. Tray (system tray) cross-platform

`Tray` nativo Electron con icona per piattaforma (asset `.ico`/`.png`/`.icns` gestiti da `electron-builder`). Comportamento uniforme proposto:
- Click sinistro → toggle mostra/nascondi finestra principale (su macOS il click sinistro apre di norma il menu: gestiamo quindi mostra/nascondi anche da un voce di menu esplicita, per coerenza su tutte le piattaforme).
- Click destro (o click su macOS) → menu contestuale: Mostra/Nascondi, Impostazioni, Aggiorna ora, Always-on-top (toggle rapido), Esci.
- Tooltip icona: sintesi rapida (es. "Claude 62% · Copilot 40%").

---

## 5. Evoluzioni future (non implementate ora, solo predisposte)

**Integrazione con strumenti grafici esterni (Rainmeter, KDE Plasma, ecc.):**
Per non doppiare la logica, `budget.js` e il calcolo delle metriche restano moduli puri nel main process, richiamabili sia dal canale IPC verso il renderer sia — in futuro — da un piccolo **server HTTP locale in loopback** (`127.0.0.1`, porta configurabile, token di accesso locale generato all'avvio) che espone un endpoint read-only tipo `GET /api/status` con lo stesso JSON usato internamente. Rainmeter può leggerlo con un plugin WebParser/JSON; un Plasmoid KDE con una piccola QML che fa fetch periodico. Nessuna implementazione ora: solo il vincolo architetturale "tieni la logica di calcolo separata dalla UI" già rispettato dalla struttura in `CLAUDE.md`.

**Analisi di utilizzo avanzata (modello usato, numero di agenti, attività parallele):**
Per Claude Code questi dati sono già presenti nei JSONL locali (modello, conteggio token per tipo, id di sessione) — quindi è la fonte più ricca e a costo quasi zero da cui partire per questa funzionalità. Per l'uso via webapp claude.ai e per Copilot i dati disponibili sono più poveri (solo utilizzo aggregato). Predisponiamo lo schema `history.dailyUsage` con un campo opzionale `meta` (ignorato dall'aggregazione v1) per non dover fare migrazioni quando arriverà questa funzione:
```js
{ date, accountId, windowId, used, meta: { model?, sessionId?, parallelAgents?, activityType? } }
```

---

## 6. Impatto sulla struttura file (rispetto allo scheletro in `CLAUDE.md`)

Aggiunte proposte in Sessione 2 (confermate e implementate):
- `renderer/settings.html` + `renderer/settings.ts` + `renderer/settings.css` — finestra impostazioni separata.
- `main/windows.ts` — creazione/gestione delle due `BrowserWindow` (skin pieno/trasparente) e della finestra impostazioni, per non appesantire `main.ts`.
- `main/tray.ts` — logica tray isolata.
- `budget.ts` — esteso per multi-finestra, efficienza, previsionale, autonomia stimata (resta comunque un modulo puro, testabile con `budget.test.ts` come richiesto in `PLAN.md`).

Aggiunte ulteriori in Giorno 2, Sessione 1 (services layer reale):
- `main/claude-auth.ts` — cattura della sessione Claude via `BrowserWindow` di login embedded (classico o SSO), mai chiesto in chiaro all'utente.
- `services/_http.ts` — helper HTTP condiviso tra i due service (timeout esplicito, errori leggibili, mai `null` silenzioso — regola CLAUDE.md).
- Migrazione a TypeScript (feedback utente, dopo Giorno 2 Sessione 1): tutti i file convertiti a `.ts`, tipi condivisi in `types/index.ts`, test con `node:test` (`budget.test.ts`, `services/*.test.ts`, `tests/integration/*`). Dettagli in CLAUDE.md §"Build e test".
- `store.history.lastGood.{claude,copilot}` — cache dell'ultimo snapshot riuscito per servizio, usata come fallback quando una fetch fallisce (mostrato in UI con timestamp e indicazione "dato non aggiornato").

Nessun'altra modifica architetturale non richiesta: services, store, agents restano dove previsto, solo con interfacce estese come discusso al §0.

---

## Domande aperte per confermare prima di procedere al codice

1. Va bene generalizzare l'interfaccia `fetchUsage()` al modello multi-finestra (§0), o preferisci partire da una versione semplificata (una sola finestra "principale" per servizio) e aggiungere le altre dopo?
2. La formula di efficienza proposta al §3 ti sembra utile così, o hai in mente un calcolo diverso?
3. Confermi le aggiunte proposte (giorni di autonomia stimati, picco vs media, streak, vista combinata) o preferisci restare stretti alla lista che hai indicato?
4. Per il tray: va bene il comportamento "click sinistro = toggle, click destro = menu" su tutte le piattaforme, o preferisci un menu sempre disponibile anche al click sinistro?
