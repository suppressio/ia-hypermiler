🌐 [English](SPIKE-CLAUDE-USAGE-PTY.md) | **Italiano**

# Spike #141 — Quote di Claude da `claude /usage` in un PTY

> Parte di #139. Stato: **completato su Linux, si procede.** Windows (ConPTY) e macOS non ancora provati.

## Setup

La prima esecuzione (2026-10-26, agente non presidiato) non aveva il login di Claude e si fermava su "Select login method". Ripetuto lo stesso giorno su una macchina Linux con login (Debian testing, Claude Code 2.1.311, login claude.ai Max), con `scripts/spikes/claude-usage-pty.py`: Python `pty.fork()`, finestra 50×140, `TERM=xterm-256color`, `--settings '{"disableAllHooks":true}'`, cwd in una cartella temporanea, poi `/usage` + Invio e il processo viene terminato.

## Risultati

| Domanda | Risposta |
|---|---|
| Il PTY funziona? | Sì. La TUI parte, il menu slash si apre, `/usage` apre la scheda *Usage* del pannello impostazioni. |
| Campi mostrati | `Current session` (finestra 5h) e `Current week (all models)`, ognuno con `NN% used` e `Resets <ora> (<fuso IANA>)`, es. `Resets 12:10am (Europe/Rome)`, `Resets Oct 28, 10pm (Europe/Rome)`. Sotto: `Usage credits` (on/off) e un riepilogo locale "what's contributing" (non serve). Le righe settimanali per modello non comparivano su questo account; il parser tiene qualsiasi `<etichetta>` + `NN% used`, quindi verrebbero lette. |
| `/usage` consuma quota o chiama un modello? | No. Lo stesso pannello mostra `Total cost: $0.0000`, `0 input, 0 output` token, e 21% / 41% sono rimasti identici su 5 sonde. |
| Lascia un file di sessione? | No: nessuna trascrizione in `~/.claude/projects` per la cartella della sonda (non viene inviato nessun messaggio). All'avvio tocca lo stato di Claude (backup di `.claude.json`, cache del changelog, sync di skill/plugin), come qualunque avvio. |
| Costo per sonda | ~8,6 s reali (3 s di attesa iniziale) e ~1,9 s di CPU (user+sys, Python + `claude`). Con l'aggiornamento ogni 30 min dell'app è ~0,1% di un core. |
| Intervallo di polling | 30 min di default, mai sotto i 5 min. Una sonda è un avvio completo di Claude Code, non una chiamata HTTP leggera. |
| Offline / refresh fallito | Il pannello mostra gli ultimi numeri in cache con `Showing last-known usage as of 3m ago (could not refresh)`: tenere i valori ma segnarli come non aggiornati. |
| Senza login | Lo schermo mostra `Select login method`: segnalare "non connesso", non un errore di parsing. |
| Insidie | Togliere `CLAUDE_CODE_*` dall'ambiente del figlio quando l'app gira dentro Claude Code (i marcatori ereditati cambiano il comportamento, es. "transcript saving is off"). `--no-session-persistence` è rifiutato fuori da `--print`. Ripulire ANSI/OSC; i movimenti del cursore possono eliminare ogni spazio (`Currentsession`, `21%used`, `Resets12:10am`), quindi non contare mai su spazi o `\b` tra le parole. |
| Stabilità del parsing | È una TUI, non un'API. Tenere uno schermo grezzo di riferimento per versione di Claude Code e fallire in modo esplicito (format drift) se nessuna delle due finestre viene trovata. |

## Decisione

- **Fonte primaria: `/usage` in un PTY.** I numeri vengono dal server, quindi sono giusti qualunque client usi l'utente (anche l'estensione VS Code, che non esegue la status line).
- **Ripiego per chi usa solo il terminale:** inoltro della status line (`rate_limits.five_hour` / `seven_day`), gratuito e in push, ma assente nell'estensione VS Code (anthropics/claude-code#21943).
- **Regole ferme:** eseguire solo il binario `claude` non modificato con il login dell'utente; non leggere mai i suoi file di credenziali; non chiedere mai di accedere dentro la nostra app (#140). Cartella di lavoro temporanea, hook disattivati, processo terminato dopo ogni lettura, timeout con uno stato "non pronto" chiaro (avvisi di primo avvio o di aggiornamento possono bloccare il PTY).
- **Core in Go (#139):** `creack/pty` su Linux/macOS e una libreria ConPTY su Windows. Sono dipendenze nuove: chiedere prima di aggiungerle. Windows e macOS richiedono una sonda a parte.

## Prototipo

`scripts/spikes/claude-usage-pty.py` — usa e getta, Python, solo POSIX, fuori da build, lint e test. `--raw` stampa lo schermo ripulito; i flag extra per `claude` vanno dopo `--`.
