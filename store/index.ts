// store/index.ts — wrapper electron-store
// Schema definito in ARCHITECTURE.md §1. Segreti (sessionKey, PAT/token) restano
// cifrati via encryptionKey e non passano mai al renderer se non tramite IPC nel main.
//
// NOTA sicurezza: la encryptionKey qui sotto è un placeholder di sviluppo.
// Prima di qualunque distribuzione va sostituita con una chiave generata in modo
// sicuro (es. da un secret manager o da un valore legato alla macchina), MAI committata.
//
// NOTA electron-store/conf: i DEFAULTS si applicano con un merge SHALLOW
// (Object.assign(defaults, fileStore) in conf/dist/source/index.js) — su
// un'installazione con un file già persistito, un campo nuovo aggiunto dentro un
// oggetto annidato che esiste già nel file (es. `history`, `accounts.claude`) non
// viene fuso: l'intero oggetto persistito sovrascrive quello dei default, campo
// nuovo escluso. Bug reale scoperto aggiungendo `history.recentSamples` (vedi
// CLAUDE.md, gauge "consumo istantaneo"): `store.get('history.recentSamples')`
// tornava `undefined` su installazioni preesistenti, non `[]`. Ogni lettura di un
// campo nested aggiunto dopo il primo rilascio veniva perso. Risolto alla radice
// da normalizeSettings() in fondo a questo file (merge profondo all'avvio):
// basta aggiungere il campo nuovo ai DEFAULTS qui sotto.

import Store from 'electron-store';
import type { AppSettings } from '../types/index';
import { normalizeSettings } from './normalize';
import { DEFAULTS } from './defaults';

export { DEFAULTS };

const store = new Store<AppSettings>({
  name: 'ia-hypermiler-config',
  encryptionKey: 'dev-only-placeholder-change-before-release',
  defaults: DEFAULTS,
});

// Normalizzazione all'avvio (store/normalize.ts): riporta il file su disco alla
// forma di AppSettings — campi mancanti (merge shallow di electron-store), tipi
// sbagliati, schema account legacy `{ claude, copilot }` → `AccountConfig[]`
// (issue #4, migrazione una tantum). Da qui in poi i tipi di AppSettings dicono
// il vero e nessuna lettura ha bisogno di fallback. Si riscrive il file solo se
// qualcosa è davvero cambiato.
const normalized = normalizeSettings(store.store, DEFAULTS);
if (JSON.stringify(normalized) !== JSON.stringify(store.store)) {
  store.store = normalized;
}

export default store;
