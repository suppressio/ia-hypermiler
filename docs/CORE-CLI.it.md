🌐 [English](CORE-CLI.md) | **Italiano**

# CLI del core Go

> Implementato in #26: contratto JSON v1 indipendente dal trasporto e output per terminale del livello 1 di #139. I provider reali arrivano separatamente.

## Comandi e ambito

```text
hypermiler usage <provider> [--json] [--timeout <duration>] [--secret-stdin] [provider flags]
hypermiler version [--json]
hypermiler help
```

La CLI recupera i dati su richiesta e termina. Non ci sono server, porte, daemon, store condiviso o snapshot del pacing. #31 servirà gli stessi documenti via HTTP; #177 aggiunge il client TypeScript. Il registry è attualmente vuoto: `hypermiler usage codex` fallisce con exit 2, `Unknown provider: codex`. I flag degli account saranno aggiunti da #148 (Codex) e #149 (Copilot); nessuno è ancora registrato. I test registrano un provider sintetico chiamato `fake`.

Mettere il provider prima dei suoi flag. Argomenti posizionali inattesi e flag sconosciuti sono errori di utilizzo.

| Flag comune | Comportamento |
|---|---|
| `--json` | Scrive su stdout un documento JSON compatto seguito da un solo newline; stderr contiene solo log. È un flag booleano standard (`--json=false` vuol dire testo, vale l'ultima occorrenza); per un'invocazione che fallisce prima o durante il parsing dei flag è riconosciuto ovunque negli argomenti, così anche l'errore di uso è un documento JSON. |
| `--timeout <duration>` | Deadline di Fetch, default `25s`; deve essere maggiore di zero e al massimo `2m`. Usa le durate Go, ad esempio `50ms`, `10s`. I provider devono rispettare la deadline del context. |
| `--secret-stdin` | Legge stdin solo se il provider accetta secret. Massimo 64 KiB incluso il newline finale; rimuove un solo CRLF o LF finale, conservando gli altri spazi. Input vuoto, errori di lettura e input troppo grande sono errori di utilizzo. |

I secret sono accettati solo su stdin, mai come flag: argv è visibile nell'elenco dei processi. I parametri dell'account vanno nei flag del provider, le credenziali no. Senza `--secret-stdin`, stdin non viene letto e Fetch riceve un secret vuoto. La CLI oscura il secret fornito nei messaggi di errore del provider e nelle motivazioni stale; i provider devono escludere le credenziali da tutti i campi di utilizzo restituiti, dalle etichette degli endpoint diagnostici e dai messaggi.

## Output testuale

L'output predefinito è per persone e agenti nel terminale, **non è un contratto stabile**. Una riga per finestra, ad esempio:

```text
Codex · 5h 21% · resets 22:10
Copilot · Monthly credits 250/1000 (25%) · resets 2026-11-30 22:10
```

Le finestre rolling usano `<n>h` o `<n>d`; quelle billing usano la propria etichetta. Le finestre percentuali contengono già percentuali; quelle count mostrano `used/total (percentuale%)`, oppure solo `used` se total è null. Le percentuali si arrotondano all'intero più vicino. Un totale zero mostra `used/0` senza percentuale indefinita. I reset entro le prossime 24 ore usano `HH:mm` locale; a esattamente 24 ore, dopo, o nel passato usano `YYYY-MM-DD HH:mm`. Senza reset la parte corrispondente è omessa. I valori stale aggiungono ` · stale` a ogni riga. Zero finestre producono `<Display> · no quota windows` (con suffisso anche quando stale). Gli errori testuali dei provider vanno su stderr in una riga `<provider>: <message>`; gli errori di utilizzo stampano anche l'help.

## Contratto JSON v1

Tutte le date sono stringhe UTC RFC 3339 con `Z`, alla precisione del secondo. Tutte le chiavi di `RawAccountUsage` e `QuotaWindow` sono sempre presenti: i campi nullable sconosciuti sono `null`, mai omessi. `quotaWindows` è sempre un array, incluso `[]`. Nomi dei campi JSON, valori enum e codici di errore sono indipendenti dalla lingua; i client non devono interpretare etichette o messaggi leggibili.

### Campi dell'envelope

| Campo | Tipo / presenza | Significato |
|---|---|---|
| `schemaVersion` | intero, sempre `1` | Versione del contratto, indipendente dalla versione del binario. |
| `provider` | stringa, solo successo/errore provider | ID del provider registrato; omesso negli errori di utilizzo. |
| `fetchedAt` | stringa ISO, solo successo | Orologio della CLI subito dopo il ritorno di Fetch, inclusi i risultati stale; non è il timestamp originale di freschezza dei valori in cache. |
| `stale` | booleano, solo successo | Il provider ha restituito gli ultimi valori noti invece di dati freschi. |
| `staleReason` | `{code, message}`, solo quando stale | Motivo del fallback, con i codici di errore dei provider. Qui non ci sono endpoint o shape. |
| `usage` | `RawAccountUsage`, solo successo | Dati del provider, senza pacing o cronologia. |
| `error` | oggetto, solo errori | `code` stabile e `message` leggibile; format drift ha anche `endpoint` e `shape`. |
| `name`, `version`, `os`, `arch` | stringhe, solo documento version | Identità del binario, versione di build (default `dev`), OS e architettura Go. |

### Campi usage e quota

| Oggetto / campo | Tipo | Significato |
|---|---|---|
| usage.`planTier` | stringa o null | Nome del piano del provider. |
| usage.`subscriptionRenewsAt` | stringa ISO o null | Rinnovo dell'abbonamento del provider. |
| usage.`quotaWindows` | array di finestre quota | Limiti riportati, eventualmente vuoto. |
| window.`id` | stringa | Identificatore della finestra. |
| window.`label` | stringa | Etichetta da mostrare. |
| window.`periodType` | `rolling-hours`, `rolling-days`, `billing-cycle` | Modello di reset. |
| window.`periodLength` | numero o null | Ore, giorni o mesi per i cicli billing; null se sconosciuto. |
| window.`unit` | `percentage` o `count` | Come leggere used/total. |
| window.`used` | numero | Già percentuale per le finestre percentage; consumo assoluto per quelle count. |
| window.`total` | numero o null | Quota totale quando nota. |
| window.`resetsAt` | stringa ISO o null | Data di reset della finestra. |

### Esempi completi dei documenti

Sono le fixture normative su singola riga in `gocore/contract/v1/`; quella directory non richiede README né package Go. Il provider `fake` e tutti i valori sono sintetici.

#### Successo con finestre percentuali

```json
{"schemaVersion":1,"provider":"fake","fetchedAt":"2026-10-31T21:10:00Z","stale":false,"usage":{"planTier":"plus","subscriptionRenewsAt":null,"quotaWindows":[{"id":"five-hour","label":"5 hours","periodType":"rolling-hours","periodLength":5,"unit":"percentage","used":21,"total":100,"resetsAt":"2026-10-31T22:10:00Z"},{"id":"weekly","label":"7 days","periodType":"rolling-days","periodLength":7,"unit":"percentage","used":42,"total":100,"resetsAt":"2026-11-07T21:10:00Z"}]}}
```

#### Successo con una finestra count

```json
{"schemaVersion":1,"provider":"fake","fetchedAt":"2026-10-31T21:10:00Z","stale":false,"usage":{"planTier":null,"subscriptionRenewsAt":"2026-11-30T21:10:00Z","quotaWindows":[{"id":"credits","label":"Monthly credits","periodType":"billing-cycle","periodLength":1,"unit":"count","used":250,"total":1000,"resetsAt":"2026-11-30T21:10:00Z"}]}}
```

#### Successo con gli ultimi valori noti

```json
{"schemaVersion":1,"provider":"fake","fetchedAt":"2026-10-31T21:10:00Z","stale":true,"staleReason":{"code":"unavailable","message":"Provider is temporarily unavailable"},"usage":{"planTier":"plus","subscriptionRenewsAt":null,"quotaWindows":[{"id":"five-hour","label":"5 hours","periodType":"rolling-hours","periodLength":5,"unit":"percentage","used":21,"total":100,"resetsAt":"2026-10-31T22:10:00Z"},{"id":"weekly","label":"7 days","periodType":"rolling-days","periodLength":7,"unit":"percentage","used":42,"total":100,"resetsAt":"2026-11-07T21:10:00Z"}]}}
```

#### Sessione non autenticata

```json
{"schemaVersion":1,"provider":"fake","error":{"code":"signed_out","message":"Sign in required"}}
```

#### Dati non ancora pronti

```json
{"schemaVersion":1,"provider":"fake","error":{"code":"not_ready","message":"Usage is not ready yet"}}
```

#### Timeout

```json
{"schemaVersion":1,"provider":"fake","error":{"code":"timeout","message":"Request timed out"}}
```

#### Format drift

```json
{"schemaVersion":1,"provider":"fake","error":{"code":"format_drift","message":"Unrecognized usage response","endpoint":"/usage","shape":{"active":"boolean","items":[{"remaining":"number"}],"label":"string","reset":"null"}}}
```

#### Provider non disponibile

```json
{"schemaVersion":1,"provider":"fake","error":{"code":"unavailable","message":"Provider is temporarily unavailable"}}
```

#### Errore negli argomenti

```json
{"schemaVersion":1,"error":{"code":"usage","message":"Unknown provider: codex"}}
```

#### Versione

```json
{"schemaVersion":1,"name":"hypermiler","version":"dev","os":"linux","arch":"amd64"}
```

### Codici di errore e comportamento del client

| Codice | Significato | Azione del client |
|---|---|---|
| `signed_out` | Nessuna sessione autenticata utilizzabile. | Mostrare lo stato di accesso, non un errore generico. |
| `not_ready` | Il provider non ha ancora prodotto i dati di utilizzo. | Riprovare più tardi. |
| `timeout` | Deadline del recupero scaduta, incluse le deadline context incapsulate. | Conservare gli ultimi valori come stale e riprovare più tardi. |
| `format_drift` | La struttura della risposta non è più riconosciuta. | Proporre un report drift con solo endpoint e shape, mai i valori della risposta. |
| `unavailable` | Altro errore del provider o della rete. | Conservare gli ultimi valori come stale e riprovare più tardi. |
| `usage` | Invocazione CLI non valida; solo documenti con exit 2. | Correggere gli argomenti prima di riprovare. |

`shape` conserva i nomi ordinati dei campi e i nomi dei tipi (`string`, `number`, `boolean`, `null`), sostituisce gli array con un elemento rappresentativo (oppure `[]`) e usa `truncated` oltre la profondità 4. Non contiene mai i valori della risposta. I provider passano il JSON decodificato attraverso `usage.ExtractShape` e devono fornire messaggi ed etichette degli endpoint sicuri, senza ID degli account o credenziali.

### Exit code

| Exit | Significato |
|---|---|
| `0` | Successo, inclusi valori stale, help e version. |
| `1` | Errore del provider. Anche gli errori di scrittura dell'output restituiscono 1 e registrano il problema. |
| `2` | Errore di utilizzo: provider/comando sconosciuto, flag errati, argomenti extra, timeout o input secret non validi. |

Con `--json`, gli errori di utilizzo non hanno la chiave provider. L'help è solo testuale; richiederlo con `--json` produce un documento di errore di utilizzo. Senza `--json`, help/version conservano il comportamento testuale.

## Versionamento e fixture condivise

I campi aggiuntivi mantengono `schemaVersion: 1`; i client devono ignorare i campi sconosciuti. Rimuovere o rinominare un campo, o cambiarne il significato, incrementa la versione dello schema. Un client che vede una versione dello schema non supportata deve rifiutare esplicitamente il documento. Un codice di errore sconosciuto viene trattato come `unavailable`, conservando gli ultimi valori come stale.

I file indipendenti dalla lingua in `gocore/contract/v1/` sono esempi normativi. I test black-box Go della CLI riproducono ogni fixture byte per byte attraverso `RunWith`, un provider fake e un orologio fisso. I test del client TypeScript aggiunti in #177 leggeranno gli stessi file. `version.json` usa `hypermiler`, `dev`, `linux`, `amd64`; il suo test Go sostituisce `buildinfo.Name`, `buildinfo.Version`, `runtime.GOOS` e `runtime.GOARCH` prima del confronto byte per byte per supportare versioni impostate in build ed esecuzioni multipiattaforma. Ogni fixture viene anche verificata come JSON compatto valido con `schemaVersion: 1` ed esattamente un newline finale.
