# EVOLUTION.md — Direzioni future e analisi costi/benefici

> Documento di tracciamento, non di design. A differenza di `ARCHITECTURE.md` (cosa si sta costruendo) e `RESEARCH.md` (vincoli reali delle API), questo file raccoglie una retrospettiva concettuale aperta dall'utente dopo la chiusura dell'MVP: direzioni di evoluzione del progetto **non ancora decise né schedulate**, con una prima valutazione di costi/benefici per orientare le priorità. Va aggiornato quando emergono nuove considerazioni o quando una direzione passa da "valutata" a "decisa" (a quel punto la parte decisa migra in `ARCHITECTURE.md`/`CLAUDE.md` come per ogni altra funzionalità).

---

## Cornice di base (assunzioni confermate dall'utente, 2026-08-31)

Queste assunzioni correggono/restringono lo scope rispetto a una prima lettura più "aperta" delle direzioni sotto — vanno tenute presenti in ogni valutazione successiva:

- **L'utente è e rimane il dev**, proprietario di un suo budget di crediti (acquistato da sé, ottenuto col piano free, o assegnato dalla propria azienda). Non c'è un pubblico multi-utente da servire.
- **Un agente o un CLI esterno che consulta i dati dell'app agisce per conto del dev**, non è un consumer estraneo — è un'estensione dello stesso utente, non un pubblico terzo a cui garantire un contratto stabile nel tempo. Questo abbassa il costo/rischio percepito di un'eventuale API locale (punto 2 sotto), ma non lo azzera: un processo locale non autenticato resta comunque raggiungibile da qualunque altro processo sulla stessa macchina, non solo da strumenti del dev.
- **Va bene che sia una trasformazione grande**, non solo un refactor interno — l'utente la definisce esplicitamente un'**evoluzione**, non un problema da minimizzare.
- **Il debito tecnico ereditato va risolto man mano**, non tutto subito (es. il bug aperto della tab Copilot dopo login, `workSchedule.hoursPerDay` non ancora usato da `budget.ts`) — nessuna urgenza dichiarata su questi, restano nel changelog di `CLAUDE.md`.
- **L'interfaccia è considerata relativamente matura** (skin, drag, tab, icone — lavoro recente giudicato sufficiente per ora). Il gap più sentito non è nella UI in sé ma nel fatto che i contenuti mostrati restano troppo vicini a quello che Anthropic già offre nella propria dashboard.

---

## Le 5 direzioni

1. **Staccarsi dalla vista del provider.** L'obiettivo non è mostrare gli stessi numeri/grafici che Claude o GitHub già espongono nelle loro dashboard, ma decidere autonomamente quali dati aiutano davvero l'efficienza. Le metriche derivate già esistenti (`efficiencyIndex`, gauge istantaneo/sostenibile, rating a stelle, `generateDailyTip`) vanno già in questa direzione; restano invece un calco diretto della UI del provider il grafico "Andamento settimanale" (stesso bar-chart-per-giorno di claude.ai) e le tab per finestra di quota (semplice affiancamento delle due metriche che Anthropic espone).

2. **Separare dati/backend da UI, con un'API interna.** `main.ts` oggi mischia orchestrazione fetch, calcolo snapshot (`computeAccountSnapshot`/`computeWindowSnapshot`) e IPC/broadcast nello stesso file, con il calcolo snapshot scritto contro lo store di Electron (non puro come `budget.ts`). L'obiettivo è che i dati vengano prima dell'interfaccia — la UI è un "favore", non il prodotto. L'app deve poter vivere di solo tray di sistema (il main process già gira headless a finestra chiusa — questa parte esiste già), esponendo gli stessi dati anche fuori dal proprio renderer: un agente che si costruisce il proprio MCP sopra, o un client indipendente scritto da altri (es. un CLI in Go), entrambi però sempre per conto del dev proprietario dei dati.

3. **Genericità multi-provider (OpenAI, z.ai, altri).** Il contratto già imposto da CLAUDE.md (`fetchUsage(credentials): Promise<RawAccountUsage>` con `QuotaWindow` normalizzato) è già una base adatta ad aggiungere provider nuovi a livello di singolo service. Il vero collo di bottiglia è più in alto: `AppSettings.accounts` ha due soli slot nominati (`claude`/`copilot`), non un registro dinamico — così come i pannelli Impostazioni e le tab account nel widget.

4. **Ridefinire "efficienza" da pacing a valore-per-token.** Le metriche `efficiencyIndex`/`efficiencyRating` misurano oggi quanto il ritmo di consumo reale si discosta da un ritmo ideale per non esaurire la quota — non se quel consumo è speso bene. Il segnale per un'analisi di valore-per-token esiste già ma è isolato: `services/claudeLocalSessions.ts` legge dimensione contesto, durata sessione, uso tool/MCP, ma oggi è un pannello informativo scollegato dai numeri di consumo quota (e copre solo Claude, non Copilot). Il salto di valore sarebbe incrociare le due fonti per un consiglio azionabile ("consumi in fretta *perché* X") invece di un solo termometro.

5. **Costo in risorse di Electron, anche a finestra chiusa.** Anche in modalità solo-tray il processo main e buona parte del runtime Chromium/GPU restano residenti per tenere viva l'icona e il polling — un carico di lavoro concettualmente semplice paga l'overhead di un browser completo. Si aggancia al punto 2: se il core viene estratto come processo Node autonomo, si apre la possibilità che il pezzo sempre-attivo non sia più Electron. Tradeoff da non sottovalutare: tray icon e avvio automatico al login sono oggi forniti gratis e cross-platform da Electron; toglierlo dal pezzo sempre-attivo richiede reimplementarli per piattaforma.

---

## Punti di attenzione emersi dall'analisi "dall'esterno"

- I 5 punti non sono iniziative indipendenti: sono la stessa direzione (da "widget" a "piattaforma dati personale sull'uso AI, con la UI come un client fra tanti") vista da 5 angolazioni.
- L'ironia strutturale del punto 2: l'app ha già tutta una disciplina di diagnostica per quando *l'API di un provider* cambia formato sotto di lei (`FormatDriftError`). Se l'app stessa diventa un'API consultata da altri strumenti del dev, dovrà affrontare lo stesso problema al contrario (stabilità del proprio contratto nel tempo) — non c'è ancora un pensiero su come.
- Tensione non banale tra punto 1/3 (parità tra provider) e punto 4 (l'insight più ricco esiste solo per Claude via file locali): più si investe nell'analisi profonda, più il prodotto diventa asimmetrico a favore di Claude.
- Il punto 5 è oggi un'ipotesi non misurata: nessuno ha ancora verificato quanta RAM/CPU consumi realmente l'app in modalità solo-tray su una macchina reale — prima di investire in una soluzione (costosa: demone indipendente + packaging/autostart per piattaforma), vale la pena quantificare il problema.
- Esiste un'alternativa a basso costo per buona parte del bisogno del punto 2: un comando CLI headless on-demand (es. `--json`/export) invece di un server sempre attivo con autenticazione di rete — vedi riga "2b" nella tabella sotto.

---

## Valutazione costi/benefici

| # | Direzione | Beneficio | Costo | Rischio | Dipendenze |
|---|---|---|---|---|---|
| **1** | Staccarsi dalla vista del provider (grafico/tab propri, non calco di Anthropic) | Alto — differenzia realmente il prodotto dalla dashboard Anthropic; le metriche derivate esistono già, manca la gerarchia visiva giusta | Basso — nessuna infrastruttura nuova, principalmente decidere cosa promuovere e cosa degradare in UI | Basso, reversibile | Nessuna — può partire subito |
| **2a** | Estrarre un core puro (fetch+snapshot) da `main.ts` | Medio diretto, alto come prerequisito — sblocca 2b/2c, testabilità, riuso | Medio — refactor vero, ma coperto da 91+ test esistenti, basso rischio di regressione | Basso | Nessuna |
| **2b** | CLI headless on-demand (`--json`/export) invocato dal dev o da un suo agente | Alto rispetto al costo — copre "l'agente fa il volere del dev" senza rete, porte, demoni | Basso, si appoggia su 2a | Basso — nessuna superficie di rete nuova | 2a |
| **2c** | Server HTTP locale sempre attivo (accesso continuo/da remoto) | Alto ma solo se serve davvero accesso continuo, non on-demand | Alto — autenticazione locale comunque necessaria, gestione lifecycle, nodo irrisolto se vive dentro o fuori Electron | Medio — nuova superficie residente | 2a, e solo se 2b si dimostra insufficiente |
| **3** | Multi-provider genericità (schema/UI) | Basso oggi — nessun secondo provider reale ancora collegato | Medio se fatto ora e a sé; molto più basso se fatto insieme al refactor di 2a | Rischio di over-engineering per un bisogno ipotetico | Conviene farlo durante 2a, non come intervento a parte |
| **4** | Ridefinire efficienza: pacing → valore-per-token | Alto — il più vicino allo scopo dichiarato dell'app | Medio-alto — incrociare due fonti oggi separate, rischio di correlazioni deboli se fatto in fretta | Medio — un cattivo insight mina la fiducia più di nessun insight | Rende di più se fatto dopo il punto 1 |
| **5** | Ridurre il costo Electron in modalità solo-tray | Sconosciuto — nessuno ha ancora misurato quanto pesa davvero oggi | Alto se risolto per davvero (demone indipendente + packaging/autostart per 3 OS) — il punto più caro della lista | Alto: rischio di investire tanto in un problema che potrebbe essere più teorico che reale | Nessuna per la misurazione; 2a se poi si decide di agire |

---

## Sequenza suggerita

1. **Punto 1** — costo basso, beneficio alto, nessuna dipendenza.
2. **2a**, insieme al **punto 3** — toccare lo schema account una volta sola, non due.
3. **2b** — quasi gratis una volta fatto 2a.
4. **Punto 4** — dopo il punto 1, per non ripetere l'errore del pannello scollegato.
5. **Punto 5** — prima misurare il consumo reale in tray, poi eventualmente agire (il più caro di tutti).
6. **2c** — solo se dopo aver usato 2b per un po' emerge un bisogno reale di accesso continuo/da remoto.

---

## Domande aperte / prossimo passo

- Da dove si parte concretamente: punto 1 (costo/beneficio migliore) o prima misurare il punto 5 (unico dato oggettivo mancante)?
- Nessuna decisione presa in questa sessione — nessun codice toccato.
