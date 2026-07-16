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

### 2.3 Progetti community verificati — confermano la stessa limitazione

- **[Fail-Safe/CopilotPremiumUsageMonitor](https://github.com/Fail-Safe/CopilotPremiumUsageMonitor)**: la modalità "Personal spend" usa l'endpoint Enhanced Billing personale con PAT "Plan" (read-only) → su un seat org-managed restituisce vuoto/404, stessa limitazione del §2.2. La modalità "Org" richiede `read:org` e dà solo metriche aggregate (utenti attivi, suggerimenti), non le premium request per singolo utente.
- Gli altri tracker noti (copilot-usage-tracker, m-marqx Copilot Premium Request Tracker) usano gli stessi endpoint di billing e condividono la stessa limitazione.

Nessun progetto community risolve in modo "pulito" il caso seat-aziendale; chi ci riesce (indicatori IDE) lo fa tramite l'endpoint interno del §2.2.

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
