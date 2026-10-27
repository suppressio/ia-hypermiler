🌐 [English](SPIKE-CODEX-APP-SERVER.md) | **Italiano**

# Spike #142 — Quote di Codex da `codex app-server` (`account/rateLimits/read`)

> Parte di #139. Stato: **completato su Linux, si procede come fonte Codex per il core Go.** Ricerca del binario su Windows e macOS, e login fatto solo dall'estensione IDE, non ancora provati.

## Setup

2026-10-27, Linux (Debian testing, ARM64), `codex-cli 0.163.0` installato con npm (`/usr/bin/codex` → `@openai/codex/bin/codex.js`), login ChatGPT Plus fatto con la CLI. Prototipo: `scripts/spikes/codex-rate-limits.js` (Node, nessuna dipendenza). Le forme sotto vengono dallo schema che genera il binario stesso: `codex app-server generate-json-schema --out <dir>` (stessa fonte di `codex-rs/app-server-protocol` in openai/codex), poi confrontate con risposte reali. L'app non ha bisogno dell'output di `generate-ts`.

## Protocollo

- `codex app-server` parla JSON-RPC 2.0 **con un oggetto JSON per riga su stdio** (trasporto predefinito `stdio://`; esistono anche `unix://` e `ws://`, non servono). Il membro `"jsonrpc":"2.0"` si può omettere: viene accettato lo stesso.
- Handshake, in quest'ordine:
  1. richiesta `{"id":1,"method":"initialize","params":{"clientInfo":{"name":"…","title":null,"version":"…"}}}` → risultato con le info del server;
  2. notifica `{"method":"initialized"}`.
- Richieste che contano:
  - `account/read` `{"refreshToken":false}` → `{account: {type:"chatgpt", email, planType} | {type:"apiKey"} | null, requiresOpenaiAuth, workspaceRouting}`. Serve a distinguere "non connesso" da "connesso con una API key" (una API key non ha quota di abbonamento).
  - `account/rateLimits/read`, `params: null` (o `{excludeResetCreditDetails: true}` per il polling in background) → `GetAccountRateLimitsResponse`.
- `GetAccountRateLimitsResponse` (solo `rateLimits` è obbligatorio):
  - `rateLimits`: il singolo bucket storico. `rateLimitsByLimitId`: lo stesso, indicizzato per `limit_id` misurato (qui `codex`), con eventuali altri bucket su altri piani/modelli.
  - bucket (`RateLimitSnapshot`): `limitId`, `limitName`, `planType`, `primary`, `secondary` (finestre o `null`), `credits` (`hasCredits`, `unlimited`, `balance` come **stringa**), `individualLimit` / `spendControlReached` (spend control dei workspace business), `rateLimitReachedType`, `normalModelSlug`.
  - finestra (`RateLimitWindow`): `usedPercent` (intero, consumato 0-100, obbligatorio), `windowDurationMins` (intero o null), `resetsAt` (Unix in **secondi**, intero o null). Visto su Plus: primary 300 min / secondary 10080 min, cioè le stesse finestre di 5 h e settimanale di oggi. Come oggi, una finestra si riconosce dalla durata, mai dal nome del campo (un piano solo settimanale può metterla in `primary`).
  - inoltre: `ordinaryUsageAllowed`, `accountId`, `rateLimitResetCredits` (`availableCount`, righe di dettaglio opzionali), `rateLimitUpsell`.
- Errori: non connesso → errore JSON-RPC `-32600 "codex account authentication required to read rate limits"` (verificato con `CODEX_HOME` vuoto). Binario non trovato → `ENOENT` dallo spawn.

## Risultati

| Domanda | Risposta |
|---|---|
| Funziona con il login che l'utente ha già? | Sì. L'app-server legge lo stesso `CODEX_HOME` (`~/.codex`) della CLI e rinnova il token da solo. Non apriamo mai `auth.json` e non salviamo nulla (nemmeno il prototipo lo legge). |
| Login fatto solo dall'estensione IDE? | **Non provato** (qui non c'è l'estensione). Per costruzione l'estensione usa lo stesso app-server sullo stesso `CODEX_HOME`, quindi il login è condiviso; se l'estensione tiene un proprio binario `codex` nella sua cartella, non è nel `PATH`, quindi la ricerca deve guardare anche lì. Da verificare su una macchina con la sola estensione. Se Codex è configurato per tenere le credenziali nel portachiavi del sistema invece che in `auth.json` (a memoria, non verificato qui), l'app-server le leggerebbe da solo: un altro motivo per non leggere `auth.json`. |
| Ricerca del binario | Cerca `codex` nel `PATH` (shim `codex.cmd` su Windows se installato con npm; spawn con `shell: true` lì, oppure risolvere il `.cmd`/`.exe`). Alternative da provare, nessuna ancora provata: impostazione utente con percorso esplicito; prefisso globale di npm; Homebrew (`/opt/homebrew/bin`, `/usr/local/bin`); il binario incluso nell'estensione IDE (posizione a memoria, es. `~/.vscode/extensions/openai.chatgpt-*/bin/<piattaforma>/codex`: da controllare). Windows/macOS: non provati. |
| Manda un prompt / consuma quota? | No. Si chiamano solo metodi di account, nessun thread né turn. Gli stessi 5% / 2% sono tornati invariati su più letture (più processi, fino a 5 letture su uno). La chiamata legge l'endpoint di utilizzo del backend. |
| Effetti collaterali | Avvia l'app-server completo: tocca `~/.codex` (file sqlite di stato/log/coda/memorie, `models_cache.json`, `skills/`, `installation_id`), nessun file di sessione (`~/.codex/sessions` non è stato creato). `--analytics-default-enabled` è spento di default per l'app-server: non passarlo. |
| Costo per sonda (one-shot) | ~2,5-4,8 s di orologio, ~1,1-1,7 s di CPU user+sys (albero di processi `codex`, misurato con `time` della shell). Di questi, `initialize` ~0,3-1,5 s e la lettura ~0,4-0,7 s. A un refresh di 30 min è ~0,1% di un core. |
| Costo tenendolo vivo | Dopo l'handshake ogni lettura costa ~0,4-0,6 s di orologio e poca CPU, ma l'app-server residente è un processo Rust con lo stato sqlite aperto. Con cadenza 5-30 min **il one-shot è più semplice e sicuro** (nessuno zombie, nessuna gestione di token scaduti, regge gli aggiornamenti della CLI); da rivedere solo se il ritmo adattivo di 5 min rende pesante l'avvio. |
| Offline / errore del backend | Non simulato. Atteso un errore JSON-RPC: tenere gli ultimi valori e segnarli come non aggiornati, come per gli altri provider. |
| Stabilità del formato | Comando sperimentale (`[experimental]` in `--help`), ma il protocollo è versionato e genera il proprio schema. Tenere una risposta grezza come fixture per ogni versione di Codex e lanciare `FormatDriftError` se nessuna finestra viene riconosciuta. |

## Cosa perdiamo rispetto al fetch con cookie di chatgpt.com (#82-#90)

Oggi `services/codex.ts` legge direttamente `wham/usage`. `rateLimits/read` è una proiezione tipizzata dello stesso endpoint, quindi finestre da 5 h e settimanale, orari di reset, piano e flag dei crediti ci sono tutti. Non passano (o non li abbiamo ancora visti nella proiezione):

- `code_review_rate_limit`, `additional_rate_limits` e `model_usage` per modello (`available_at`, `credits_would_enable`): arriva solo ciò che l'app-server mappa nei bucket di `rateLimitsByLimitId`; se compaiono bucket extra su Pro/Team **non è verificato**.
- `credits.approx_local_messages` / `approx_cloud_messages` e `overage_limit_reached`.
- `reset_after_seconds` (non serve: `resetsAt` è assoluto).
- Email / user id dalla risposta di utilizzo (`account/read` dà email e piano).
- Finestre con durata non multipla intera di ore o giorni: `windowDurationMins` è in minuti, quindi la logica attuale di etichette ore/giorni va adattata (minuti ↔ secondi).

Cosa guadagniamo: nessun cookie ChatGPT, nessuna finestra di login Electron né partizione, nessuna fragilità Cloudflare/User-Agent, nessuna gestione del bearer, e lo stesso login di cui l'utente già si fida (copre anche SSO e workspace Team/Enterprise che la via cookie web non ha mai verificato: `workspaceRouting` lo gestisce il binario). Cosa perdiamo in pratica: serve la CLI di Codex o l'estensione, installata e connessa; una sonda è un avvio di processo (~1,5 s di CPU) invece di due chiamate HTTP.

## Decisione

- **Fonte primaria di Codex per il core Go: `codex app-server` one-shot su stdio**, `initialize` → `initialized` → `account/read` → `account/rateLimits/read`, processo terminato dopo la lettura, timeout 10 s, righe di stdout lette come JSON, `stderr` svuotato e mai loggato.
- **Regole ferree:** eseguire solo il binario `codex` non modificato con il login dell'utente; mai leggere né copiare `auth.json`; mai passare `--analytics-default-enabled`; non chiamare `account/login/*`, `account/logout` né `account/rateLimitResetCredit/consume`; non connesso → stato "accedi con Codex", non un errore.
- **Nessun ripiego con cookie nel core Go.** La via cookie di chatgpt.com (#82) resta solo nell'app Electron attuale, finché il core Go non la sostituisce.
- **Prima del rilascio:** (#158) provare Windows e macOS (ricerca, shim `.cmd`, nessuna finestra console che lampeggia, terminare l'intero albero di processi: con `shell: true`, `child.kill()` nel prototipo termina solo la shell), un login solo-estensione, un account Pro/Team (bucket extra, `individualLimit`) e il caso offline.

## Prototipo

`scripts/spikes/codex-rate-limits.js` — usa e getta, Node, fuori da build, lint e test. Di default stampa un riepilogo (saldo crediti oscurato); `--raw` stampa la risposta completa con i valori; `--repeat N` fa N letture su un processo; `--bin PATH` sceglie il binario; `CODEX_HOME=<cartella vuota>` mostra l'errore di non connesso.
