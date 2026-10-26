🌐 [English](SPIKE-CLAUDE-USAGE-PTY.md) | **Italiano**

# Spike #141 — Quote di Claude da `claude /usage` in un PTY

> Parte di #139. Stato: **inconcludente, serve un'esecuzione su una macchina con il login fatto.** L'ambiente dello spike aveva Claude Code 2.1.288 ma nessun login (`claude auth status` → `loggedIn: false`), e un agente non presidiato non può né deve accedere. Qui sotto sono separate le cose **verificate** da quelle ancora **ipotesi**.

## Verificato (2026-10-26, Linux, Claude Code 2.1.288)

- Pilotare un PTY funziona: Python `pty.fork()` + `TIOCSWINSZ` (50×140) + `TERM=xterm-256color` avvia la TUI interattiva, che si disegna per intero e accetta i tasti. L'output va ripulito da sequenze ANSI/OSC (`scripts/spikes/claude-usage-pty.py`).
- Dall'avvio a freddo alla UI disegnata passano alcuni secondi; la sonda aspetta ~8 s prima di scrivere.
- Senza login la TUI si ferma al primo avvio (scelta del tema, poi "Select login method"): `/usage` non è raggiungibile. Una sonda deve quindi trattare "non connesso" come stato a sé (lo schermo contiene `Select login method`) e segnalarlo, non come errore di parsing.
- `--settings '{"disableAllHooks":true}'` è accettato all'avvio.

## Non verificato (da fare su una macchina con login)

Lanciare `python3 scripts/spikes/claude-usage-pty.py --raw` e annotare:

| Domanda | Come verificare |
|---|---|
| Campi mostrati (5h, 7d, per modello, extra usage, reset) | leggere lo schermo `--raw`; poi scrivere il vero parser (quello attuale è una supposizione) |
| `/usage` consuma quota o chiama un modello? | annotare i numeri della status line / di `/usage` prima e dopo varie sonde; controllare che non ci sia alcun turno dell'assistente nell'elenco sessioni |
| Costo per sonda | `time` sullo script; CPU del processo `claude`; vedere se lascia un file di sessione |
| Intervallo di polling sicuro | dipende dal costo sopra; partire dai 30 min dell'app, mai sotto i 5 min |
| Windows (ConPTY), macOS | `pty` è solo POSIX; in Go una libreria ConPTY su Windows e `creack/pty` su Linux/macOS (nuove dipendenze: chiedere prima) |
| Stabilità del parsing tra versioni | salvare lo schermo grezzo per ogni versione di Claude Code; il parser deve fallire in modo esplicito (format drift, come `FormatDriftError`) se non riconosce alcuna finestra |

## Decisione proposta (provvisoria)

- **Fonte primaria:** `/usage` in un PTY, se i controlli sopra mostrano nessun consumo di quota e ben meno di un secondo di CPU per sonda. I numeri vengono dal server, quindi sono giusti qualunque client usi l'utente (anche l'estensione VS Code, che non esegue la status line).
- **Ripiego per chi usa solo il terminale:** inoltro della status line (`rate_limits.five_hour` / `seven_day`), gratuito e in push, ma assente nell'estensione VS Code (anthropics/claude-code#21943).
- **Regole ferme:** eseguire solo il binario `claude` non modificato con il login dell'utente; non leggere mai i suoi file di credenziali; non chiedere mai di accedere dentro la nostra app (#140). Sonda in una cartella neutra, hook disattivati, processo terminato dopo ogni lettura.
- **Rischi da misurare:** il pannello è una TUI, non un'API, quindi testi o layout possono cambiare tra versioni; una sonda potrebbe lasciare file di sessione che gli insight locali poi contano; un avviso di primo avvio o di aggiornamento può bloccare il PTY (servono timeout e uno stato "non pronto" chiaro).

## Prototipo

`scripts/spikes/claude-usage-pty.py` — usa e getta, Python (nell'ambiente dello spike non c'è Go), solo POSIX, fuori da build, lint e test. Il parser non è provato su output reale.
