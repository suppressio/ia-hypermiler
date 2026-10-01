🌐 [English](ARCHITECTURE.md) | **Italiano**

# ARCHITECTURE.md — Struttura dell'applicazione (Giorno 1, Sessione 2 — Plan Mode)

> Documento di design prodotto in **plan mode**, come da flusso di lavoro in `CLAUDE.md`: descrive cosa viene costruito ed è stato aggiornato man mano che le funzionalità sono state implementate (sezioni marcate *implementato* / *aggiornato*).
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
    id: string,                              // 'five_hour' | 'seven_day' | 'seven_day_opus' | 'ai_credits' | ...
    label: string,
    periodType: 'rolling-hours' | 'rolling-days' | 'billing-cycle',
    periodLength: number | null,             // ore, giorni o mesi secondo periodType (5, 7, 1); null = ignota, niente pacing
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

Estende `store/index.ts` (default in `store/defaults.ts`, normalizzazione del file su disco in `store/normalize.ts`). Tutto ciò che è segreto (session cookie, PAT, token) resta cifrato via `encryptionKey` di `electron-store` e non passa mai dal renderer se non tramite IPC verso il main.

```js
{
  // Registro di N account indipendenti dal provider (issue #4, EVOLUTION.md punto 3):
  // parte comune + parte specifica, unione discriminata su `provider`. Fino a v0.1.2 erano
  // due slot fissi { claude, copilot }: convertiti una volta all'avvio da store/migrate.ts,
  // mantenendo gli id 'claude'/'copilot' (così history.* resta valido senza riscritture).
  // La parte specifica per provider lato main vive in main/providers.ts.
  accounts: Array<{
    // --- comune ---
    id: string,                // 'claude'/'copilot' se migrato, altrimenti '<provider>-<uuid8>'
    provider: 'claude' | 'copilot',
    label: string,             // nome mostrato in tabella e nelle tab del widget ("Claude", "Claude 2"…)
    enabled: boolean,
    accountScope: 'personal' | 'organization',
    subscription: {
      renewalRule: { type: 'dayOfMonth', day: number } | { type: 'rrule', rrule: string },
    },
    workSchedule: {  // per account dalla 0.4.6 (prima era un'impostazione globale, ereditata da ogni account all'aggiornamento)
      enabled: boolean, // se false, ogni giorno vale come giornata piena (pacing non legato a giorni/ore specifici — es. account personale)
      days: {
        mon: 'full' | 'half' | 'off',
        tue: 'full' | 'half' | 'off',
        wed: 'full' | 'half' | 'off',
        thu: 'full' | 'half' | 'off',
        fri: 'full' | 'half' | 'off',
        sat: 'full' | 'half' | 'off',
        sun: 'full' | 'half' | 'off',
      },
      hoursPerDay: number, // un solo numero, non un intervallo inizio/fine (feedback utente, Giorno 2):
                           // l'inizio della giornata è ricavato dai dati (primo aggiornamento del
                           // giorno con consumo in aumento), parte di oggi trascorsa = ore da allora
                           // / hoursPerDay (budget.todayElapsedUnits, almeno 2h).
    },
  } & (
    { // --- provider: 'claude' ---
      authMethod: 'password' | 'google' | 'sso',
      session: {
        sessionKey: string,        // cifrato
        organizationId: string | null, // risolto automaticamente al login (GET /api/organizations)
        capturedAt: string,        // ISO date
        expiresAt: string | null,  // stimata ~30gg, da ri-validare
      },
      planTier: 'free' | 'pro' | 'max_5x' | 'max_20x' | 'team' | 'enterprise',
      partition: string,         // 'persist:account-<id>': cookie claude.ai isolati per account,
                                 // cancellati da Disconnetti/Rimuovi e prima di ogni login (issue #4)
      localInsights: boolean,    // sessioni Claude Code locali attribuite a questo account (max 1)
    } | { // --- provider: 'copilot' ---
      authMethod: 'pat' | 'oauth',  // sceglie quale pannello di connessione mostrare; aggiornato dall'ultima connessione riuscita
      credentials: { token: string, username: string | null },  // token cifrato (PAT o access token OAuth App — vedi main/copilot-oauth.ts)
      oauthApp: { clientId: string | null },  // non è un segreto; il client secret non viene mai persistito
      manualQuota: number, // l'API di billing non espone il totale del piano: valore inserito dall'utente
      planTier: 'free' | 'individual' | 'pro_plus' | 'business' | 'enterprise',
      experimentalWarningAcknowledged: boolean,
    }
  )>,


  ui: {
    language: 'auto' | 'en' | 'it',       // 'auto' segue la lingua del sistema (vedi §4c)
    windowStyle: 'filled' | 'filled-dark' | 'transparent-digital',
    alwaysOnTop: boolean,
    accentColor: string,
    bounds: { x, y, width, height },       // posizione/dimensione persistita
    chartRange: 'week' | 'month',
    notificationThresholdPercent: number,  // default 80, configurabile
  },

  history: {
    // append-only, un record per giorno per finestra di quota; retention configurabile (default 90gg) per non far crescere il file all'infinito
    dailyUsage: Array<{ date: string, accountId: string, windowId: string, used: number }>,
    lastGood: Record<accountId, RawAccountUsage>, // ultimo dato riuscito per account (fallback)
  },

  advisorCache: { generatedAt: string, adviceText: string },

  meta: {
    notifiedToday: Record<string, boolean>, // flag anti-doppia-notifica per account/giorno
    claudeCookiesMigrated?: boolean,         // copia una tantum dei cookie da defaultSession alla partition del Claude migrato
  },
}
```

Sezioni del pannello impostazioni (finestra separata `renderer/settings.html`, aperta dal tray o da un'icona ingranaggio nel widget):

1. **Account e sessioni** — *(aggiornato, issue #4)* una **tabella** di account (Nome | Provider | Stato | Attivo | azioni Configura/Connetti/Disconnetti/Rimuovi) con "Aggiungi account"; "Configura" apre sotto la riga il pannello del provider (campi comuni + specifici). Descrizione originale: per Claude e Copilot: stato connessione, metodo (password/SSO/PAT/OAuth device), pulsante "Connetti/Riconnetti" che apre una `BrowserWindow` di login per Claude o il device-flow per Copilot, data di scadenza sessione stimata, toggle "seat aziendale" con avviso automatico se attivo su Copilot ("funzionalità sperimentale, può interrompersi senza preavviso").
2. **Piano e rinnovo** — tipo piano, giorno di rinnovo abbonamento (selettore semplice "giorno del mese"; dietro le quinte salvato come RRULE minimale `FREQ=MONTHLY;BYMONTHDAY=n` così in futuro si possono aggiungere ricorrenze diverse senza cambiare schema).
3. **Calendario di lavoro** — *(per account dalla 0.4.6: ultima sezione del dettaglio di ogni account, compressa con un riassunto di una riga)* 7 selettori giorno con 3 stati (pieno/mezza/riposo), un interruttore "attivo" (spento = ogni giorno conta come giornata piena, es. account personale) e ore/giorno (riservato). Usato per calcolare budget e proiezioni su "giorni lavorativi rimanenti", non su giorni di calendario.
4. **Aspetto** — lingua (Automatica / English / Italiano), stile finestra (le tre skin descritte sotto), always-on-top, colore accento, intervallo grafico (settimana/mese) di default.
5. **Notifiche** — soglia percentuale di allarme (default 80%, come da `CLAUDE.md`, ma ora configurabile), eventualmente per-finestra (es. avviso separato per il limite 5h di Claude).
6. **Avanzate** — placeholder per le evoluzioni future (vedi §5): abilitazione futura server locale, export dati.

---

## 2. Finestra principale — le tre "skin"

Tutte leggono dagli stessi dati (IPC dal main, nessuna duplicazione di logica) e cambiano solo `renderer/style.css` + flag di creazione della `BrowserWindow`.

**Stile "pieno" (classico - light):**
sfondo opaco, layout a blocchi con bordi. *(Aggiornato:)* sempre `frame: false` con la titlebar custom dell'app, che compare in hover — con `frame: true` la titlebar nativa del sistema operativo compariva sopra quella custom (feedback utente).

**Stile "pieno" (dark):** *(aggiunta, feedback utente)*
Stessa struttura opaca/non trasparente della skin classica, con colori invertiti (sfondo scuro, testo chiaro) — vedi i token `--*-filled-dark` in `renderer/style.css`. Nessuna differenza di comportamento rispetto alla skin classica oltre ai colori (stessa titlebar custom, stesso comportamento hover, stesso layout).

**Stile "trasparente/digitale":**
`frame: false`, `transparent: true`, `titleBarStyle` nascosto. Numeri/barre in stile HUD (font monospazio, glow leggero — restando comunque sobri per rispettare "no animazioni" di `CLAUDE.md`: niente pulsazioni, solo contrasto/opacità statici). Pulsanti di sistema (chiudi/riduci) ricreati come controlli custom in overlay, `opacity: 0` di default e `opacity: 1` solo on-hover via CSS, con `-webkit-app-region: drag` sull'area libera per permettere lo spostamento finestra senza barra del titolo nativa.

**Always-on-top:** toggle in impostazioni e nel menu del tray, applicato con `win.setAlwaysOnTop(bool, 'floating')`; persistito e riapplicato all'avvio.

---

## 3. Contenuto informativo del widget

Corpo centrale — numero grande "current usage": la finestra di quota più critica al momento (quella con `utilization` più vicina al reset o più alta in %), con etichetta di quale finestra è (es. "Limite settimanale: 62%").

Sotto, un grafico a barre/linea dei **picchi giornalieri**, selezionabile settimana/mese, con overlay della linea di budget ideale (pacing lineare) per vedere a colpo d'occhio se si è sopra o sotto.

*(Implementato così dopo EVOLUTION.md punto 1 — prima il grafico mostrava la % cumulata per giorno, un calco della dashboard del provider.)* Ogni barra è il **consumo di quel giorno** (`budget.dailyDeltas`: differenza con la base del giorno `dayStartUsed`, o col giorno precedente per i punti più vecchi, reset esclusi), con un trattino per la quota ideale del giorno (0 nei giorni non lavorativi); barre oltre la quota in `--warning`. Non mostrato per finestre `rolling-hours`. Se l'account ha più finestre di quota, sopra al valore corrente c'è una **lista con verdetto** calcolato dall'app (`budget.windowVerdict`: esaurita / a rischio / in linea / nessun pacing), la critica per prima, al posto delle tab che affiancavano solo le metriche del provider.

**Valore per token** *(EVOLUTION.md punto 4, solo account Claude con insight locali)*: "Resa" = token di output delle sessioni Claude Code locali per 1% di quota consumata (`budget.tokenYield`, con trend), e un consiglio causale su contesto ampio (`budget.consumptionCause`) mostrato **solo** se il segnale è netto. Limite dichiarato: l'SDK non espone l'orario dei singoli messaggi, ogni sessione è attribuita al giorno di ultima modifica.

Riquadro metriche:

- **Token (o % quota)/giorno lavorativo corrente** — richiesto. *(Implementato come "Oggi: usato / budget", `budget.todayBudget`:)* budget di oggi = quanto restava a inizio giornata diviso sulle unità lavorative da oggi in poi, fisso per la giornata; il consumo di oggi è misurato dalla base del giorno (`DailyUsagePoint.dayStartUsed`, esatta anche nel giorno di un reset). Oltre `PACE_ALERT_RATIO` (1,5×) parte una notifica di sistema, al massimo una al giorno per account — la sola soglia dell'80% arrivava troppo tardi (caso reale: 10,3% il primo giorno del mese, nessun avviso).
- **Andamento settimanale** — richiesto (il grafico sopra)
- **Indice di efficienza** — richiesto. Proposta di formula: rapporto tra ritmo di consumo ideale e ritmo reale, calcolato sulle **unità lavorative** trascorse (non giorni di calendario):
  `efficiencyIndex = (idealPace) / (actualPace)` dove `idealPace = 100% / unitàLavorativeTotaliNelPeriodo` e `actualPace = utilizationAttuale / unitàLavorativeTrascorse`. Valore intorno a 1 = in linea; >1 = si sta usando meno del previsto (margine per usare di più); <1 = si sta consumando più veloce del sostenibile.
- **Previsionale** — richiesto: proiezione dell'utilizzo a fine periodo, estrapolando il ritmo sulle unità lavorative rimanenti. Il ritmo mescola al 50% la media del periodo con gli ultimi 3 giorni lavorativi completati (`budget.recentPacePerUnit`), così un cambio di abitudini si vede subito; non limitato a 100% (es. "227%" dice di quanto si sforerebbe). Il tempo trascorso conta la parte di oggi già lavorata (`budget.todayElapsedUnits`). Con meno di 2 unità lavorative trascorse previsionale, autonomia e verdetto sono indicati come *stima preliminare*.
- **Giorni alla scadenza** — richiesto: sia giorni di calendario sia giorni **lavorativi** rimanenti (spesso più utile).
- **Giorni di autonomia stimati** *(aggiunta)* — a quanti giorni lavorativi si esaurirà la quota mantenendo il ritmo attuale, utile quando è < giorni alla scadenza (segnale di rischio più diretto del solo indice di efficienza).
- **Picco massimo vs media giornaliera** *(aggiunta; calcolato sui delta giornalieri, `budget.deltaStats`)* — per capire se i problemi sono concentrati in giornate anomale o distribuiti.
- **Streak sotto budget** *(aggiunta)* — giorni lavorativi consecutivi entro il budget ideale, per rinforzo positivo leggero (in linea con "sobria", quindi solo un numero, non badge/gamification vistosa).
- **Vista combinata multi-servizio** *(aggiunta, se entrambi Claude e Copilot attivi)* — un indicatore di "salute generale" che aggrega le percentuali delle finestre più critiche dei due servizi, utile per uno sguardo d'insieme prima di aprire il dettaglio.
- **Tips/consigli del giorno** — richiesto. *(Implementato:)* ricavati dai dati reali da `budget.generateDailyTip` (condizioni esplicite sulle metriche calcolate, mai una frase generica); `agents/advisor.ts` (Claude Sonnet, cache 24h come da `CLAUDE.md`) è ancora uno stub.

---

## 4. Tray (system tray) cross-platform

`Tray` nativo Electron con icona per piattaforma (asset `.ico`/`.png`/`.icns` gestiti da `electron-builder`). Comportamento uniforme proposto:
- Click sinistro → toggle mostra/nascondi finestra principale (su macOS il click sinistro apre di norma il menu: gestiamo quindi mostra/nascondi anche da un voce di menu esplicita, per coerenza su tutte le piattaforme).
- Click destro (o click su macOS) → menu contestuale: Mostra/Nascondi, Impostazioni, Aggiorna ora, Always-on-top (toggle rapido), Esci; più "Aggiornamento disponibile (X)…" quando c'è una nuova versione.
- Tooltip icona: sintesi rapida (es. "Claude 62% · Copilot 40%").

---

## 4b. Aggiornamenti dell'app (issue #5)

- **Cosa fa:** all'avvio (dopo ~10s, solo app pacchettizzata) e ogni 24h, `services/updates.ts` legge l'elenco delle Release GitHub del progetto e confronta la versione più alta (semver con pre-release, bozze escluse) con `app.getVersion()`. Se è più recente: notifica di sistema una sola volta per versione (`updates.notifiedVersion`), voce nel menu tray e card "Aggiornamenti" in Impostazioni con "Scarica X" (apre nel browser il pacchetto per l'OS in uso) e "Controlla ora". Disattivabile (`updates.autoCheck`).
- **Endpoint:** `GET https://api.github.com/repos/suppressio/ia-hypermiler/releases` (API REST ufficiale, anonima, 60 richieste/h per IP: ampio margine). **Non** `/releases/latest`, che esclude le pre-release — e tutte le release del progetto lo sono (`releaseType: "prerelease"`). Nessun dato dell'utente nella richiesta.
- **Scelta del pacchetto:** `.exe` su Windows, `.dmg` della stessa architettura su macOS (la CI produce solo arm64: su un Mac Intel si apre la pagina della release), `.AppImage` se l'app gira come AppImage (`process.env.APPIMAGE`) altrimenti `.deb` su Linux.
- **Perché niente installazione automatica (electron-updater):** scelta dell'utente — nessuna dipendenza nuova, e con pacchetti non firmati l'aggiornamento in-app non funzionerebbe comunque su macOS. L'URL aperto viene sempre dallo store (scritto dal main) e deve iniziare per `https://github.com/suppressio/ia-hypermiler/`, mai da un valore passato dal renderer.

## 4c. Lingua dell'interfaccia (multilingua)

- **Lingue:** inglese (primaria) e italiano. `ui.language`: `'auto'` (italiano se la lingua del sistema è `it*`, altrimenti inglese) oppure una scelta esplicita; applicata subito a widget, Impostazioni e tray, senza riavvio.
- **Nessuna libreria:** dizionari piatti tipizzati + `Intl` per numeri e date. Il renderer non ha bundler, quindi non può importare da `node_modules`; per due lingue un dizionario per processo basta. `en.ts` è il riferimento, `it.ts` è tipizzato sulle stesse chiavi: una chiave mancante o in più non compila.
- **Ogni processo possiede i propri testi** (due progetti TypeScript separati): `renderer/i18n/` per l'interfaccia (compresi consigli del giorno e verdetti), `main/i18n/` per tray, notifiche, finestre di dialogo, finestra di login e pagina di callback OAuth.
- **Dati, non frasi:** `budget.generateDailyTip` restituisce `{ key, params }` e la frase la compone il renderer; le etichette delle finestre di quota si traducono per `id`. I messaggi d'errore tecnici dei service restano in inglese (sono codice); il main li incornicia nella lingua dell'utente nei casi noti (sessione scaduta).
- **Testo nell'HTML:** inglese di default + attributi `data-i18n`, `data-i18n-title`, `data-i18n-aria-label`, `data-i18n-placeholder`.
- **Codice e documenti:** il codice è tutto in inglese; i documenti per umani esistono in inglese (`X.md`) e italiano (`X.it.md`).

## 5. Evoluzioni future (non implementate ora, solo predisposte)

**Integrazione con strumenti grafici esterni (Rainmeter, KDE Plasma, ecc.):**
Per non doppiare la logica, `budget.js` e il calcolo delle metriche restano moduli puri nel main process, richiamabili sia dal canale IPC verso il renderer sia — in futuro — da un piccolo **server HTTP locale in loopback** (`127.0.0.1`, porta configurabile, token di accesso locale generato all'avvio) che espone un endpoint read-only tipo `GET /api/status` con lo stesso JSON usato internamente. Rainmeter può leggerlo con un plugin WebParser/JSON; un Plasmoid KDE con una piccola QML che fa fetch periodico. Nessuna implementazione ora: solo il vincolo architetturale "tieni la logica di calcolo separata dalla UI" già rispettato dalla struttura in `CLAUDE.md`.

**Analisi di utilizzo avanzata (modello usato, numero di agenti, attività parallele):**
Per Claude Code questi dati sono già presenti nei JSONL locali (modello, conteggio token per tipo, id di sessione) — quindi è la fonte più ricca e a costo quasi zero da cui partire per questa funzionalità. Per l'uso via webapp claude.ai e per Copilot i dati disponibili sono più poveri (solo utilizzo aggregato). Predisponiamo lo schema `history.dailyUsage` con un campo opzionale `meta` (ignorato dall'aggregazione v1) per non dover fare migrazioni quando arriverà questa funzione:
```js
{ date, accountId, windowId, used, meta: { model?, sessionId?, parallelAgents?, activityType? } }
```

**Retrospettiva e direzioni future non decise:**
Dopo la chiusura dell'MVP (Giorno 3), l'utente ha aperto una retrospettiva concettuale sulla direzione del progetto (staccarsi dalla vista dei provider, separare dati/backend da UI con un'API interna, genericità multi-provider, ridefinire "efficienza" verso il valore-per-token, costo in risorse di Electron in modalità solo-tray). Spostata in un documento dedicato per non mischiare "cosa si sta costruendo" (questo file) con "direzioni non ancora decise, in valutazione costi/benefici" — vedi **`EVOLUTION.it.md`**.

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
- `store.history.lastGood.<accountId>` — cache dell'ultimo snapshot riuscito per servizio, usata come fallback quando una fetch fallisce (mostrato in UI con timestamp e indicazione "dato non aggiornato").

Le aggiunte successive sono elencate nella struttura dei file di `CLAUDE.md` (registro account e provider, normalizzazione dello store, i18n, controllo aggiornamenti).

---

## Domande aperte confermate prima di scrivere il codice (storico)

1. Generalizzare `fetchUsage()` al modello multi-finestra (§0), o partire da una versione semplificata (una sola finestra "principale" per servizio)? → multi-finestra, adottato.
2. La formula di efficienza del §3 è utile così? → adottata.
3. Confermare le aggiunte proposte (giorni di autonomia stimati, picco vs media, streak, vista combinata)? → implementate le prime tre.
4. Tray: "click sinistro = toggle, click destro = menu" su tutte le piattaforme? → adottato, con mostra/nascondi anche come voce di menu.
