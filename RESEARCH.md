# RESEARCH.md — Sessione di ricerca API (Giorno 1)

> v3 — corretto il caso d'uso primario: l'utilizzatore dell'app è **il singolo sviluppatore**, non un admin IT. Vuole monitorare il **proprio** credito periodico (mensile/settimanale) di Claude e/o Copilot — che sia un piano personale o un seat pagato dall'azienda — per capire se lo sta usando in modo efficiente prima che si esaurisca. Gli scenari "admin monitora il team" (Admin API Claude, Metrics API Copilot org/enterprise) sono stati esclusi: non rientrano nell'interesse del progetto.

---

## Risposta diretta

| Servizio | Il developer (non-admin) può monitorare da solo il proprio consumo? | Come |
|---|---|---|
| **Claude** | **Sì**, sia con piano personale sia con seat aziendale Team/Enterprise | Endpoint interno `claude.ai/api/organizations/{orgId}/usage` con il proprio cookie di sessione, oppure lettura locale se usa Claude Code |
| **GitHub Copilot** | **Sì con piano personale** · **Solo con workaround non ufficiale se il seat è assegnato dall'azienda** | Piano personale: endpoint ufficiale `premium_request/usage`. Seat aziendale: nessun endpoint pubblico self-service; unica fonte reale è l'endpoint interno non documentato `copilot_internal/user` (stesso usato dall'indicatore quota in VS Code) |

Dettagli e fonti sotto.

---

## 1. Claude — self-tracking del developer (CONFERMATO)

Un membro — **anche senza ruolo admin** — di un piano Team/Enterprise seat-based vede la propria barra di utilizzo andando su claude.ai in **Settings → Usage**: limite delle 5 ore, limite settimanale "tutti i modelli" e limite settimanale Opus, ciascuno con data di reset. Fonti ufficiali: [Team plan FAQ](https://support.claude.com/en/articles/9266767-what-is-the-team-plan), [Come funzionano i limiti di usage/length](https://support.claude.com/en/articles/11647753-how-do-usage-and-length-limits-work).

Dietro quella barra c'è un endpoint interno non documentato:

```
GET https://claude.ai/api/organizations/{organization_id}/usage
```

Raggiungibile con il **solo cookie di sessione (`sessionKey`) del developer stesso** — non serve alcun permesso admin, l'endpoint restituisce i dati personali di chi chiama. Risponde con `five_hour`, `seven_day`, `seven_day_sonnet`, `seven_day_opus`, ciascuno con `utilization` e data di reset. Confermato dal codice di due tool di terze parti che lo implementano: [linuxlewis/claude-usage (SPEC.md)](https://github.com/linuxlewis/claude-usage/blob/main/SPEC.md) e [steipete/CodexBar](https://github.com/steipete/CodexBar/blob/main/docs/claude.md).

**Claude Code (CLI) con seat aziendale:** i log locali in `~/.claude/projects/**/*.jsonl` vengono scritti normalmente indipendentemente dal tipo di licenza. Dalla versione 2.1.92 Claude Code espone anche i dati di rate-limit direttamente nella **statusline** ed esiste un comando **`/usage`** che mostra il consumo corrente — nessun bisogno di scraping. Fonti: [Claude Code — statusline docs](https://code.claude.com/docs/en/statusline), [tracking costi Claude Code](https://avinashsangle.com/blog/claude-code-cost-tracking), [cc-friend/ccost](https://github.com/cc-friend/ccost).

**SSO:** non risulta che cambi il meccanismo. Dopo un login SSO (SAML/OIDC via WorkOS, [guida ufficiale](https://support.claude.com/en/articles/13132885-set-up-single-sign-on-sso)) l'utente atterra comunque in una normale sessione browser su claude.ai, quindi il cookie `sessionKey` viene emesso allo stesso modo (TTL ~30 giorni). Ipotesi ragionevole ma non confermata al 100% da documentazione — alcune policy enterprise via MDM potrebbero imporre sessioni più corte; da verificare sul campo al primo test con un account reale.

**In pratica per l'app:** basta far fare all'utente un login "vero" in una finestra browser embedded (Electron `BrowserWindow`, sia con password/Google sia con SSO), catturare il cookie `sessionKey`, e interrogare l'endpoint interno periodicamente. In alternativa/complemento, se il developer usa Claude Code, si può leggere `/usage` o i JSONL locali senza rete.

**Addendum (Giorno 3 — verificato con un account reale): claude.ai è dietro Cloudflare.** Il solo cookie `sessionKey` non basta per superare il bot management di Cloudflare da una richiesta HTTP "nuda" (senza motore browser): senza anche il cookie `cf_clearance` (ottenuto dalla stessa sessione browser reale usata per il login) e uno User-Agent plausibile, l'endpoint risponde `403` con la pagina interstitial "Just a moment..." invece del JSON atteso. Fix implementato: `main/claude-auth.ts` ricostruisce l'header Cookie completo leggendo a runtime tutti i cookie della sessione Electron per il dominio claude.ai (non solo `sessionKey`), e `services/claude.ts` invia anche uno User-Agent da browser desktop. Limite noto non ancora risolto: se `cf_clearance` scade e Cloudflare richiede una nuova verifica JS interattiva, serve rifare il login (che riapre una vera `BrowserWindow` e quindi supera di nuovo la verifica) — non c'è ancora un meccanismo di refresh automatico in background.

**Addendum 2 (Giorno 3 — verificato con un account reale): i nomi dei campi della risposta usage non sono stabili.** Dopo aver superato Cloudflare, la risposta reale ricevuta da un account collegato NON conteneva più `five_hour`/`seven_day`/`seven_day_opus` valorizzati (tutti presenti ma `null`, insieme ad altri nomi storici come `seven_day_sonnet`/`seven_day_oauth_apps`/`seven_day_cowork`/`seven_day_omelette`, anch'essi `null`), bensì chiavi con nomi arbitrari non documentati — osservati in pratica: `cinder_cove`, `omelette_promotional`, `tangelo`, `iguana_necktie`, `nimbus_quill`. Esempio reale (valori reali della risposta, NON quelli mostrati in una eventuale segnalazione automatica — vedi sotto):

```json
{
  "five_hour": null, "seven_day": null, "seven_day_opus": null,
  "omelette_promotional": { "utilization": 0, "resets_at": null, "limit_dollars": null, "used_dollars": null, "remaining_dollars": null },
  "cinder_cove": { "utilization": 39.52, "resets_at": "2026-09-13T14:38:47Z", "limit_dollars": 1000, "used_dollars": 395.17, "remaining_dollars": 604.83 }
}
```

Ipotesi più probabile: offuscamento intenzionale lato Anthropic dei nomi dei campi (nomi-codice non semantici, es. nomi di frutta/luoghi), forse per scoraggiare lo scraping da parte di tool di terze parti come quelli citati sopra — non una semplice rinomina occasionale, dato che nessuno dei nomi storici documentati è sopravvissuto. Non è da escludere che i nomi ruotino ulteriormente in futuro.

**Fix implementato in `services/claude.ts` (`buildQuotaWindows`):** non si legge più per nome di campo fisso, ma per **forma del valore** — qualunque chiave il cui valore abbia un `utilization` numerico viene trattata come una finestra di quota valida, a prescindere dal nome. Se la finestra espone anche `limit_dollars`/`used_dollars` numerici (come `cinder_cove` sopra — verosimilmente un credito extra a consumo in dollari), viene modellata come `unit: 'count'` con gli importi reali invece che come semplice percentuale, sfruttando il modello multi-finestra già esistente (vedi ARCHITECTURE.md §0). Le finestre a 0% senza data di reset e senza importi (come `omelette_promotional` sopra) vengono scartate perché indistinguibili da un campo non applicabile al piano dell'account. Il vantaggio di questo approccio è che sopravvive a un'ulteriore rotazione dei nomi, finché la forma del JSON (un `utilization` numerico per finestra) resta la stessa — se anche quella dovesse cambiare, scatta comunque la diagnostica auto-segnalazione format-drift (vedi CLAUDE.md).

---

## 2. GitHub Copilot — self-tracking del developer

### 2.1 Piano personale (Free/Individual/Pro+) — CONFERMATO, via ufficiale

Endpoint ufficiale e documentato, chiamabile dal developer con un proprio fine-grained PAT (permesso "Plan", read) o classic PAT:

- `GET /users/{username}/settings/billing/premium_request/usage`
- `GET /users/{username}/settings/billing/ai_credit/usage`

Fonte: [REST API — Billing usage](https://docs.github.com/en/rest/billing/usage). Pienamente self-service e automatizzabile.

### 2.2 Seat assegnato dall'azienda (Business/Enterprise) — NESSUN endpoint pubblico self-service (CONFERMATO)

Questo è il punto critico, verificato con fonti multiple:

- Gli stessi endpoint utente (`premium_request/usage`, `ai_credit/usage`) **restituiscono solo il consumo fatturato al piano personale** — se la licenza è gestita/fatturata dall'organizzazione, l'utilizzo del developer **non compare**. Fonti: [REST API — Billing usage](https://docs.github.com/en/rest/billing/usage), [Copilot user management](https://docs.github.com/en/rest/copilot/copilot-user-management).
- L'endpoint org (`/orgs/{org}/copilot/...`) con filtro `?user=` risponde **403 "cannot filter usage by user"** per org enterprise-owned.
- L'endpoint enterprise richiede un classic PAT con scope **`admin:enterprise`** — riservato ad admin.
- Conferme aggiuntive dalla community: [navikt/copilot issue #111](https://github.com/navikt/copilot/issues/111), [GitHub Community Discussion #184208](https://github.com/orgs/community/discussions/184208).

**Unica fonte reale del dato**, in questo scenario: l'indicatore di quota mostrato dall'estensione Copilot Chat in VS Code. Quell'indicatore legge da un endpoint **interno non documentato**:

```
GET https://api.github.com/copilot_internal/user
```

che restituisce `quota_snapshots` con `premium_interactions`, `chat`, `completions`, `quota_reset_date`, `copilot_plan` — esattamente i dati di cui ha bisogno l'app (consumo, quota, data di rinnovo), e funziona anche per seat assegnati da un'organizzazione perché è ciò che alimenta l'IDE stesso. Fonte: [GitHub Community Discussion #178117](https://github.com/orgs/community/discussions/178117). È tecnicamente replicabile con il token Copilot del developer, ma è **non documentato, senza versioning, e il suo uso fuori dai client ufficiali è in una zona grigia rispetto ai Termini di Servizio Copilot** — va trattato come workaround best-effort, non come integrazione stabile.

**Ipotesi confutata (2026-07-23) — il tipo di token non fa differenza.** Analizzando un vecchio prototipo dell'utente (`copilot_hypermiler`, mai eseguito con successo — nessun dato salvato nel checkout analizzato), era emerso che chiama lo stesso `copilot_internal/user` ma con un **token OAuth App di GitHub** (Authorization Code + PKCE, `github.com/login/oauth/authorize` + `/access_token`, scope `read:user`) invece di un Personal Access Token, con l'ipotesi che l'endpoint rispondesse con `quota_snapshots` completo solo a quel tipo di token. Implementato in `main/copilot-oauth.ts` e testato con un vero seat aziendale: **stessa identica risposta** ottenuta col PAT (nessun `quota_snapshots`, solo flag di feature/plan/org). Confermato non solo dal messaggio d'errore ma dalla firma di struttura (`shapeSignature()` in `services/_shape.ts`, calcolata su nomi di campo + tipo): la diagnostica auto-segnalazione ha correttamente **non riaperto** una seconda bozza di issue perché la firma coincideva esattamente con quella già segnalata per il PAT — prova che i due token ricevono una risposta strutturalmente identica. L'ipotesi è quindi chiusa: il tipo di credenziale (PAT classic/fine-grained, OAuth App) non influisce sulla risposta di `copilot_internal/user`; l'endpoint non espone più dati di quota per seat aziendale, punto e basta, a prescindere da come ci si autentica.

### 2.3 Progetti community verificati — confermano la stessa limitazione

- **[Fail-Safe/CopilotPremiumUsageMonitor](https://github.com/Fail-Safe/CopilotPremiumUsageMonitor)**: la modalità "Personal spend" usa l'endpoint Enhanced Billing personale con PAT "Plan" (read-only) → su un seat org-managed restituisce vuoto/404, stessa limitazione del §2.2. La modalità "Org" richiede `read:org` e dà solo metriche aggregate (utenti attivi, suggerimenti), non le premium request per singolo utente.
- Gli altri tracker noti (copilot-usage-tracker, m-marqx Copilot Premium Request Tracker) usano gli stessi endpoint di billing e condividono la stessa limitazione.

Nessun progetto community risolve in modo "pulito" il caso seat-aziendale; chi ci riesce (indicatori IDE) lo fa tramite l'endpoint interno del §2.2.

**Addendum (ricerca 2026-07-23): perché `quota_snapshots` è sparito — GitHub ha cambiato modello di fatturazione, non solo formato.** Il 1° giugno 2026 GitHub è passato dalle "premium requests" (il modello su cui era costruito `quota_snapshots`) a un nuovo sistema **"AI Credits"** basato sul consumo di token ([GitHub Blog](https://github.blog/news-insights/company-news/github-copilot-is-moving-to-usage-based-billing/)). Non è quindi un drift qualsiasi: il modello di quota sottostante è stato ritirato a livello di prodotto. Il pannello "Credits" mostrato da VS Code (come nello screenshot dell'utente) è il nuovo "Copilot spend meter" introdotto in VS Code 1.125 (17-22 giugno 2026). **Punto decisivo, verificato**: anche Microsoft non espone questo dato via API — esiste una issue aperta e non risolta su `microsoft/vscode` che chiede esattamente "Expose credit usage... programmatically" ([microsoft/vscode#319571](https://github.com/microsoft/vscode/issues/319571)). L'unica API ufficiale con consumo AI Credits per singolo utente (`ai_credits_used`, aggiunto il 19/06/2026 alla Copilot Usage Metrics API) richiede permessi di **amministratore di organizzazione/enterprise** ([GitHub Changelog](https://github.blog/changelog/2026-06-19-ai-credits-consumed-per-user-now-in-the-copilot-usage-metrics-api/)) — esclusa dallo scope di questo progetto (vedi nota v3 in cima al file: "scenari 'admin monitora il team'... esclusi"). Anche tracker di terze parti aggiornati (es. `steipete/CodexBar`) hanno questo come lavoro esplicitamente aperto/non risolto. **Conclusione**: per un seat aziendale non esiste, ad oggi, nessuna via self-service nota — né nostra né altrui — per un developer non-admin. Il percorso *personale* (§2.1, `premium_request/usage`/`ai_credit/usage`) resta invece valido: la limitazione riguarda solo i seat gestiti da organizzazione/enterprise.

**Addendum (2026-07-23 — verificato con un account reale, seat aziendale): `copilot_internal/user` non restituisce più `quota_snapshots`.** Prima connessione reale di un account Copilot con seat aziendale (`accountScope: organization`): la risposta ricevuta non conteneva alcun campo di quota (né `quota_snapshots`, né `premium_interactions`/`chat`/`completions`, né una data di reset), solo flag di feature (`chat_enabled`, `cli_enabled`, `copilot_app_enabled`, ecc.), `copilot_plan`, `login`, `organization_list`/`organization_login_list` ed `endpoints` interni. Struttura completa (nessun valore reale) riportata dalla diagnostica auto-segnalazione — vedi CLAUDE.md, sezione "Diagnostica: auto-segnalazione format drift". Questo conferma sul campo il rischio già segnalato in §2.2 ("può rompersi senza preavviso"): l'endpoint non è più una fonte di quota utilizzabile, almeno per questo account/momento. Nessun fix tentato in `services/copilot.ts`: non c'è nulla da estrarre nella nuova risposta (zero campi riconducibili a percentuale/consumo), quindi non si può scrivere un parser senza inventare un formato non documentato (vietato da CLAUDE.md). Il comportamento dell'app è quello previsto: `FormatDriftError` → nessun crash, `emptyAccountSnapshot` con `lastError` mostrato nel widget invece di un dato inventato. Se in futuro GitHub esporrà un endpoint ufficiale per il consumo per-seat, va integrato lì; allo stato attuale monitorare un seat aziendale resta senza soluzione self-service affidabile (vedi anche §3).

---

## 3. Implicazioni per l'app

Per l'MVP orientato al singolo developer, l'architettura più solida è:

1. **Claude:** login browser embedded (funziona sia per piano personale sia per seat aziendale, con o senza SSO) → cattura `sessionKey` → polling di `claude.ai/api/organizations/{orgId}/usage`. Se il developer usa anche/solo Claude Code, integrare la lettura di `/usage` o dei JSONL locali come fonte aggiuntiva (o alternativa, a rischio zero).
2. **Copilot:**
   - Se il developer ha un piano **personale**: PAT fine-grained ufficiale su `premium_request/usage` — via solida, headless, a basso rischio.
   - Se il developer ha un **seat aziendale**: nessuna via ufficiale. Opzioni da presentare come tali all'utente: (a) leggere manualmente l'indicatore di quota in VS Code (nessuna integrazione, solo istruzione a schermo), oppure (b) chiamare l'endpoint interno `copilot_internal/user` con il token Copilot del developer, etichettato chiaramente in UI come funzionalità **sperimentale/best-effort**, con avviso che può rompersi senza preavviso.

Per il modello di configurazione, resta valida la necessità di chiedere all'utente, per ciascun account collegato: metodo di login (classico o SSO — determina solo il flusso della finestra browser di cattura sessione, non la disponibilità del dato), se il piano è personale o assegnato dall'azienda (determina quale endpoint Copilot usare, e se serve avvisare l'utente che il dato Copilot sarà "best-effort"), tipologia di piano (per calcolare/validare la quota totale), e — dove l'API non fornisce reset date affidabile — la data di rinnovo inserita manualmente.

---

## 4. Raccomandazione architetturale

1. **Claude** (personale o aziendale, con o senza SSO): via primaria via endpoint interno + sessionKey, via secondaria/complementare Claude Code locale. Buona affidabilità, basso attrito per l'utente (login una tantum in finestra embedded).
2. **Copilot personale:** via ufficiale, priorità alta, implementare come primo servizio "solido".
3. **Copilot con seat aziendale:** funzionalità sperimentale via endpoint interno non documentato — implementare ma segnalare chiaramente il rischio in UI (può cambiare/rompersi senza preavviso, non è supportata da GitHub).

Fuori scope, per scelta esplicita: qualunque funzionalità di monitoraggio a livello di team/organizzazione (Admin API Claude, Metrics/Billing API Copilot org/enterprise) — l'app resta uno strumento per il singolo developer sul proprio consumo, non un pannello IT/admin.

---

## Fonti

**Claude / Anthropic**
- [Team plan FAQ](https://support.claude.com/en/articles/9266767-what-is-the-team-plan)
- [Come funzionano i limiti di usage/length](https://support.claude.com/en/articles/11647753-how-do-usage-and-length-limits-work)
- [linuxlewis/claude-usage — SPEC.md](https://github.com/linuxlewis/claude-usage/blob/main/SPEC.md)
- [steipete/CodexBar — claude.md](https://github.com/steipete/CodexBar/blob/main/docs/claude.md)
- [Claude Code — statusline docs](https://code.claude.com/docs/en/statusline)
- [Tracking dei costi in Claude Code](https://avinashsangle.com/blog/claude-code-cost-tracking)
- [cc-friend/ccost](https://github.com/cc-friend/ccost)
- [Set up SSO](https://support.claude.com/en/articles/13132885-set-up-single-sign-on-sso)
- Repo community aggiuntivi (piano personale, da v2): [lugia19/Claude-Usage-Extension](https://github.com/lugia19/Claude-Usage-Extension), [ryoppippi/ccusage](https://github.com/ryoppippi/ccusage), [phuryn/claude-usage](https://github.com/phuryn/claude-usage)

**GitHub Copilot**
- [REST API — Billing usage](https://docs.github.com/en/rest/billing/usage)
- [Copilot user management](https://docs.github.com/en/rest/copilot/copilot-user-management)
- [GitHub Community Discussion #184208](https://github.com/orgs/community/discussions/184208)
- [navikt/copilot issue #111](https://github.com/navikt/copilot/issues/111)
- [GitHub Community Discussion #178117 — copilot_internal/user](https://github.com/orgs/community/discussions/178117)
- [Fail-Safe/CopilotPremiumUsageMonitor](https://github.com/Fail-Safe/CopilotPremiumUsageMonitor)
