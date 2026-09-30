// settings.ts — logica finestra impostazioni (nessun accesso diretto a Node.js)

import type { AccountConfig, AccountId, AppSettings, HypermilerBridge, ProviderId, UpdateSettings } from './types';

declare global {
  interface Window {
    hypermiler: HypermilerBridge;
  }
}

const DAY_LABELS: Record<string, string> = {
  mon: 'Lunedì', tue: 'Martedì', wed: 'Mercoledì', thu: 'Giovedì', fri: 'Venerdì', sat: 'Sabato', sun: 'Domenica',
};

let settings: AppSettings | null = null;
// Ultimo stato realmente persistito (confermato con "Salva" o appena ricevuto da
// getSettings()): usato da "Annulla" per ripristinare il form, e per capire quali
// campi sono davvero cambiati rispetto all'ultimo salvataggio (es. per non
// ricreare la finestra ad ogni Salva se lo stile non è stato toccato).
let savedSettings: AppSettings | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
// Account con il pannello di dettaglio aperto nella tabella (uno alla volta).
let expandedAccountId: AccountId | null = null;
// Account appena creato con "Aggiungi account" e non ancora salvato: stesso form
// di dettaglio, cambia solo il titolo ("Nuovo account …" invece di "Configura …").
let newAccountId: AccountId | null = null;

const PROVIDER_LABELS: Record<ProviderId, string> = { claude: 'Claude', copilot: 'GitHub Copilot' };

type PlainRecord = Record<string, unknown>;

function isPlainRecord(value: unknown): value is PlainRecord {
  return typeof value === 'object' && value !== null;
}

function getPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (isPlainRecord(o) ? o[k] : undefined), obj);
}

function setPath(obj: PlainRecord, path: string, value: unknown): void {
  const keys = path.split('.');
  let cursor: PlainRecord = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!isPlainRecord(cursor[keys[i]])) cursor[keys[i]] = {};
    cursor = cursor[keys[i]] as PlainRecord;
  }
  cursor[keys[keys.length - 1]] = value;
}

function topLevelKey(path: string): string {
  return path.split('.')[0];
}

function readFieldValue(el: HTMLInputElement | HTMLSelectElement): unknown {
  if (el instanceof HTMLInputElement) {
    if (el.type === 'checkbox') return el.checked;
    if (el.type === 'number') return el.value === '' ? null : Number(el.value);
  }
  return el.value;
}

function buildWeekGrid(): void {
  const grid = document.getElementById('week-grid') as HTMLElement;
  grid.innerHTML = '';
  Object.entries(DAY_LABELS).forEach(([key, label]) => {
    const labelEl = document.createElement('span');
    labelEl.textContent = label;
    const select = document.createElement('select');
    select.dataset.field = `workSchedule.days.${key}`;
    (['full', 'half', 'off'] as const).forEach((opt) => {
      const optionEl = document.createElement('option');
      optionEl.value = opt;
      optionEl.textContent = opt === 'full' ? 'Intera' : opt === 'half' ? 'Mezza giornata' : 'Riposo';
      select.appendChild(optionEl);
    });
    grid.appendChild(labelEl);
    grid.appendChild(select);
  });
}

function fieldElements(): (HTMLInputElement | HTMLSelectElement)[] {
  return Array.from(document.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-field]'));
}

function accounts(): AccountConfig[] {
  return Array.isArray(settings?.accounts) ? settings.accounts : [];
}

function isAccountConnected(account: AccountConfig): boolean {
  return account.provider === 'claude' ? !!account.session?.sessionKey : !!account.credentials?.username;
}

function connectionLabel(account: AccountConfig): string {
  if (!isAccountConnected(account)) return 'Non connesso';
  return account.provider === 'copilot' && account.credentials.username
    ? `Connesso come ${account.credentials.username}`
    : 'Connesso';
}

function actionButton(label: string, action: string, id: AccountId, disabled = false): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn-secondary btn-small';
  btn.textContent = label;
  btn.dataset.action = action;
  btn.dataset.accountId = id;
  btn.disabled = disabled;
  return btn;
}

// Tabella account (issue #4): una riga per account + riga di dettaglio espandibile,
// clonata dal template del provider. I campi del dettaglio diventano
// data-field="accounts.<indice>.<campo>": getPath/setPath funzionano già su indici
// di array, quindi bozza/Salva/Annulla restano quelli generici del resto del form.
function renderAccountsTable(): void {
  const tbody = document.getElementById('accounts-tbody') as HTMLTableSectionElement;
  tbody.innerHTML = '';
  (document.getElementById('accounts-empty') as HTMLElement).hidden = accounts().length > 0;

  accounts().forEach((account, index) => {
    const isExpanded = expandedAccountId === account.id;
    const row = document.createElement('tr');
    row.dataset.accountId = account.id;
    // Zebra calcolata qui e non con :nth-child: le righe di dettaglio aperte
    // sfaserebbero l'alternanza.
    row.className = `account-row${index % 2 ? ' zebra' : ''}${isExpanded ? ' expanded' : ''}`;

    const nameCell = document.createElement('td');
    nameCell.textContent = account.label;
    const providerCell = document.createElement('td');
    providerCell.textContent = PROVIDER_LABELS[account.provider];
    const statusCell = document.createElement('td');
    const status = document.createElement('span');
    status.className = 'connection-status';
    status.dataset.role = 'row-status';
    status.textContent = connectionLabel(account);
    status.classList.toggle('connected', isAccountConnected(account));
    statusCell.appendChild(status);

    const enabledCell = document.createElement('td');
    const enabled = document.createElement('input');
    enabled.type = 'checkbox';
    enabled.dataset.field = `accounts.${index}.enabled`;
    enabled.setAttribute('aria-label', `Account ${account.label} attivo`);
    enabledCell.appendChild(enabled);

    const actionsCell = document.createElement('td');
    actionsCell.className = 'account-actions';
    actionsCell.appendChild(actionButton(expandedAccountId === account.id ? 'Chiudi' : 'Configura', 'toggle-detail', account.id));
    if (isAccountConnected(account)) {
      actionsCell.appendChild(actionButton('Disconnetti', 'disconnect', account.id));
    } else if (account.provider === 'claude') {
      actionsCell.appendChild(actionButton('Connetti…', 'connect-claude', account.id));
    }
    actionsCell.appendChild(actionButton('Rimuovi', 'remove', account.id));

    row.append(nameCell, providerCell, statusCell, enabledCell, actionsCell);
    tbody.appendChild(row);

    if (expandedAccountId === account.id) {
      const detailRow = document.createElement('tr');
      detailRow.className = 'account-detail-row';
      detailRow.dataset.accountId = account.id;
      const cell = document.createElement('td');
      cell.colSpan = 5;
      const tpl = document.getElementById(`tpl-detail-${account.provider}`) as HTMLTemplateElement;
      const detail = tpl.content.firstElementChild!.cloneNode(true) as HTMLElement;
      detail.dataset.accountId = account.id;
      const title = document.createElement('h3');
      title.className = 'account-detail-title';
      title.textContent = account.id === newAccountId
        ? `Nuovo account ${PROVIDER_LABELS[account.provider]}`
        : `Configura «${account.label}»`;
      detail.prepend(title);
      detail.querySelectorAll<HTMLElement>('[data-account-field]').forEach((el) => {
        el.dataset.field = `accounts.${index}.${el.dataset.accountField}`;
      });
      detail.querySelectorAll<HTMLElement>('[data-action]').forEach((el) => { el.dataset.accountId = account.id; });
      cell.appendChild(detail);
      detailRow.appendChild(cell);
      tbody.appendChild(detailRow);
    }
  });
}

function populateForm(): void {
  renderAccountsTable();
  fieldElements().forEach((el) => {
    const value = getPath(settings, el.dataset.field as string);
    if (value === undefined || value === null) return;
    if (el instanceof HTMLInputElement && el.type === 'checkbox') el.checked = !!value;
    else el.value = String(value);
  });
  accounts().forEach((_account, index) => { applyAccountDetailState(index); });
  updateWorkScheduleLock();
}

// Quando il calendario di lavoro è disattivato (account personale, nessun
// giorno/ora specifico da rispettare — feedback utente), i selettori dei giorni
// e le ore/giorno non hanno più alcun effetto sul pacing (vedi budget.getDayUnit):
// disabilitati visivamente invece di lasciarli modificabili senza conseguenze,
// stesso pattern di updateCopilotEnabledLock.
function updateWorkScheduleLock(): void {
  const enabled = getPath(settings, 'workSchedule.enabled') !== false;
  const hint = document.getElementById('work-schedule-disabled-hint') as HTMLElement;
  hint.hidden = enabled;
  document
    .querySelectorAll<HTMLSelectElement>('#week-grid select[data-field^="workSchedule.days."]')
    .forEach((el) => { el.disabled = !enabled; });
  const hoursInput = document.querySelector<HTMLInputElement>('[data-field="workSchedule.hoursPerDay"]');
  if (hoursInput) hoursInput.disabled = !enabled;
}

function detailElement(id: AccountId): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.account-detail[data-account-id="${CSS.escape(id)}"]`);
}

// Stato dinamico della riga/dettaglio di un account Copilot:
// - seat aziendale → nessuna via self-service affidabile per il consumo (RESEARCH.md
//   §2.2/§2.3): checkbox "Attivo" bloccata e forzata a false, avviso visibile;
// - PAT/OAuth condividono lo stesso slot di credenziali: un solo pannello visibile.
function applyAccountDetailState(index: number): void {
  const account = accounts()[index];
  if (!account || account.provider !== 'copilot') return;
  const isOrg = account.accountScope === 'organization';
  const enabled = document.querySelector<HTMLInputElement>(`[data-field="accounts.${index}.enabled"]`);
  if (enabled) {
    enabled.disabled = isOrg;
    enabled.title = isOrg ? 'Seat aziendale: monitoraggio non disponibile (vedi Configura)' : '';
    if (isOrg && enabled.checked) {
      enabled.checked = false;
      setPath(settings as PlainRecord, `accounts.${index}.enabled`, false);
    }
  }
  const detail = detailElement(account.id);
  if (!detail) return;
  (detail.querySelector('[data-role="org-warning"]') as HTMLElement).hidden = !isOrg;
  (detail.querySelector('[data-role="pat-panel"]') as HTMLElement).hidden = account.authMethod === 'oauth';
  (detail.querySelector('[data-role="oauth-panel"]') as HTMLElement).hidden = account.authMethod !== 'oauth';
}

// Le sessioni Claude Code locali non dicono a quale account appartengono: il flag
// può stare su un solo account Claude alla volta (lo stesso vincolo è riapplicato
// lato main, enforceSingleLocalInsights in store/migrate.ts).
function enforceSingleLocalInsightsDraft(keepIndex: number): void {
  accounts().forEach((account, index) => {
    if (index === keepIndex || account.provider !== 'claude' || !account.localInsights) return;
    account.localInsights = false;
    const el = document.querySelector<HTMLInputElement>(`[data-field="accounts.${index}.localInsights"]`);
    if (el) el.checked = false;
  });
}

// Dopo un'azione eseguita dal main (connetti/disconnetti/aggiungi/rimuovi) serve
// lo stato reale dello store per l'account toccato — ma le modifiche in bozza non
// ancora salvate sugli ALTRI account e sulle altre sezioni non vanno perse (prima
// si ricaricava tutto il form da capo, scartandole).
async function reloadAfterAccountAction(actedOn: AccountId | null): Promise<void> {
  const fresh = await window.hypermiler.getSettings();
  const draft = settings;
  savedSettings = structuredClone(fresh);
  if (draft) {
    const draftAccounts = new Map(accounts().map((a) => [a.id, a]));
    fresh.accounts = fresh.accounts.map((a) => (a.id !== actedOn && draftAccounts.has(a.id) ? draftAccounts.get(a.id)! : a));
    for (const [key, value] of Object.entries(draft)) {
      if (key !== 'accounts') (fresh as PlainRecord)[key] = value;
    }
  }
  settings = fresh;
  populateForm();
}

function setDetailStatus(id: AccountId, text: string): void {
  const el = detailElement(id)?.querySelector<HTMLElement>('[data-role="detail-status"]');
  if (el) el.textContent = text;
  const rowStatus = document.querySelector<HTMLElement>(`tr[data-account-id="${CSS.escape(id)}"] [data-role="row-status"]`);
  if (rowStatus) rowStatus.textContent = text;
}

async function runAccountAction(action: string, id: AccountId, button: HTMLButtonElement): Promise<void> {
  const account = accounts().find((a) => a.id === id);
  if (!account) return;

  if (action === 'toggle-detail') {
    expandedAccountId = expandedAccountId === id ? null : id;
    if (expandedAccountId === null) newAccountId = null;
    captureDraftFromForm();
    populateForm();
    return;
  }

  button.disabled = true;
  try {
    if (action === 'connect-claude') {
      setDetailStatus(id, 'Login in corso… (completa nella finestra che si è aperta)');
      const result = await window.hypermiler.connectClaude(id);
      await reloadAfterAccountAction(id);
      showSaveStatus(result?.organizationId ? `${account.label} connesso` : `${account.label} connesso (organizzazione non rilevata)`);
    } else if (action === 'connect-copilot-pat') {
      const input = detailElement(id)?.querySelector<HTMLInputElement>('[data-role="token-input"]');
      const token = input?.value.trim() ?? '';
      if (!token) {
        setDetailStatus(id, 'Incolla un token prima di salvare');
        return;
      }
      setDetailStatus(id, 'Verifica token…');
      const result = await window.hypermiler.connectCopilot(id, token);
      await reloadAfterAccountAction(id);
      showSaveStatus(`${account.label} connesso come ${result.username}`);
    } else if (action === 'connect-copilot-oauth') {
      const detail = detailElement(id);
      const clientId = detail?.querySelector<HTMLInputElement>('[data-role="oauth-client-id"]')?.value.trim() ?? '';
      const clientSecret = detail?.querySelector<HTMLInputElement>('[data-role="oauth-secret-input"]')?.value.trim() ?? '';
      if (!clientId || !clientSecret) {
        setDetailStatus(id, 'Inserisci Client ID e Client Secret prima di connetterti');
        return;
      }
      setDetailStatus(id, "Apri il browser e autorizza l'accesso…");
      const result = await window.hypermiler.connectCopilotOAuth(id, clientId, clientSecret);
      await reloadAfterAccountAction(id);
      showSaveStatus(`${account.label} connesso (OAuth) come ${result.username}`);
    } else if (action === 'disconnect') {
      await window.hypermiler.disconnectAccount(id);
      await reloadAfterAccountAction(id);
      showSaveStatus(`${account.label} disconnesso`);
    } else if (action === 'remove') {
      if (!window.confirm(`Rimuovere l'account "${account.label}"? La sessione salvata verrà cancellata.`)) return;
      await window.hypermiler.removeAccount(id);
      if (expandedAccountId === id) expandedAccountId = null;
      await reloadAfterAccountAction(id);
      showSaveStatus(`${account.label} rimosso`);
    }
  } catch (err) {
    setDetailStatus(id, `Operazione non riuscita: ${(err as Error)?.message || err}`);
  } finally {
    if (button.isConnected) button.disabled = false;
  }
}

// Rilegge nella bozza tutti i campi attualmente nel DOM: serve prima di ridisegnare
// la tabella (apri/chiudi dettaglio), altrimenti un valore digitato ma non ancora
// "change" (input in focus) andrebbe perso.
function captureDraftFromForm(): Set<string> {
  const touchedKeys = new Set<string>();
  fieldElements().forEach((el) => {
    const field = el.dataset.field as string;
    setPath(settings as PlainRecord, field, readFieldValue(el));
    touchedKeys.add(topLevelKey(field));
  });
  return touchedKeys;
}

// Card "Aggiornamenti" (issue #5): stato letto da settings.updates, scritto solo
// dal main (services/updates.ts). Non fa parte della bozza del form: si aggiorna
// dal vivo anche quando arriva l'esito di un controllo automatico.
function renderUpdatesCard(updates: UpdateSettings | undefined): void {
  const status = document.getElementById('updates-status') as HTMLElement;
  const download = document.getElementById('btn-download-update') as HTMLButtonElement;
  const hint = document.getElementById('updates-download-hint') as HTMLElement;
  const checkedAt = updates?.lastCheckedAt ? new Date(updates.lastCheckedAt).toLocaleString('it-IT') : null;
  const available = updates?.available ?? null;

  status.classList.remove('connected', 'update-available', 'update-error');
  if (available) {
    status.textContent = '';
    status.classList.add('update-available');
    status.append(`Disponibile la versione ${available.version} `);
    const notes = document.createElement('a');
    notes.href = '#';
    notes.textContent = '(note di rilascio)';
    notes.addEventListener('click', (event) => {
      event.preventDefault();
      // Passa dal main, che apre solo URL del repository del progetto.
      runGuarded(window.hypermiler.openReleaseNotes());
    });
    status.append(notes);
  } else if (updates?.lastError) {
    status.textContent = `Controllo non riuscito: ${updates.lastError}`;
    status.classList.add('update-error');
  } else if (checkedAt) {
    status.textContent = `Sei aggiornato (ultimo controllo: ${checkedAt})`;
    status.classList.add('connected');
  } else {
    status.textContent = 'Nessun controllo eseguito.';
  }

  download.hidden = !available;
  hint.hidden = !available;
  if (available) {
    download.textContent = `Scarica ${available.version}`;
    hint.textContent = available.assetName
      ? `Si scarica ${available.assetName} nel browser: chiudi l'app e installalo.`
      : 'Nessun pacchetto specifico per questo sistema: si apre la pagina della release.';
  }
}

function showSaveStatus(text: string): void {
  const el = document.getElementById('save-status') as HTMLElement;
  el.textContent = text;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { el.textContent = ''; }, 2500);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Nessuna promise lasciata a sé stessa: un errore (IPC rifiutato, main che lancia)
// finisce nella barra di stato invece di perdersi nella console — prima un
// fallimento di "Aggiungi account"/"Salva" non mostrava nulla all'utente.
function runGuarded(task: Promise<unknown>): void {
  task.catch((err: unknown) => {
    console.error('[settings]', err);
    showSaveStatus(`Operazione non riuscita: ${errorMessage(err)}`);
  });
}

function guarded(handler: () => Promise<void>): () => void {
  return () => { runGuarded(handler()); };
}

async function persist(key: string): Promise<void> {
  await window.hypermiler.setSettings({ [key]: (settings as PlainRecord)[key] });
}

function bindEvents(): void {
  // Delegato su document: righe e dettagli della tabella account vengono ricreati
  // ad ogni populateForm(), listener per-elemento andrebbero persi.
  document.addEventListener('change', (event) => {
    const el = event.target;
    if (!(el instanceof HTMLInputElement || el instanceof HTMLSelectElement) || !el.dataset.field) return;
    const field = el.dataset.field;
    const value = readFieldValue(el);
    setPath(settings as PlainRecord, field, value);
    const accountMatch = /^accounts\.(\d+)\.(.+)$/.exec(field);
    if (accountMatch) {
      const index = Number(accountMatch[1]);
      if (accountMatch[2] === 'localInsights' && value === true) enforceSingleLocalInsightsDraft(index);
      applyAccountDetailState(index);
    }
    if (field === 'workSchedule.enabled') updateWorkScheduleLock();
    // Nessun salvataggio né effetto collaterale qui: la modifica resta "in
    // bozza" nel form finché l'utente non preme "Salva" (o "Annulla" per
    // scartarla) — prima si salvava ad ogni campo, un comportamento discordante
    // col pulsante "Salva impostazioni" già presente (feedback utente).
  });

  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button[data-action]') : null;
    if (!target?.dataset.accountId) return;
    runGuarded(runAccountAction(target.dataset.action as string, target.dataset.accountId, target));
  });

  document.getElementById('btn-add-account')!.addEventListener('click', guarded(async () => {
    const provider = (document.getElementById('add-account-provider') as HTMLSelectElement).value as ProviderId;
    captureDraftFromForm();
    const id = await window.hypermiler.addAccount(provider);
    expandedAccountId = id;
    newAccountId = id;
    await reloadAfterAccountAction(id);
  }));

  document.getElementById('btn-save')!.addEventListener('click', guarded(async () => {
    // Rilegge esplicitamente tutti i campi (anche quelli senza un evento 'change'
    // ancora scattato, es. input numerico in focus) e salva tutto in un colpo solo.
    const touchedKeys = captureDraftFromForm();
    for (const key of touchedKeys) {
      await persist(key);
    }

    // Effetti collaterali che richiedono un'azione dedicata lato main: applicati
    // solo ora che l'utente ha confermato col Salva, e solo se il valore è
    // davvero cambiato rispetto all'ultimo salvataggio (altrimenti ogni Salva
    // ricreerebbe la finestra anche per una modifica non correlata, es. il piano).
    const newStyle = getPath(settings, 'ui.windowStyle') as AppSettings['ui']['windowStyle'];
    const newAlwaysOnTop = getPath(settings, 'ui.alwaysOnTop') as boolean;
    if (newStyle !== savedSettings?.ui.windowStyle) {
      await window.hypermiler.setWindowStyle(newStyle);
    }
    if (newAlwaysOnTop !== savedSettings?.ui.alwaysOnTop) {
      await window.hypermiler.setAlwaysOnTop(newAlwaysOnTop);
    }

    // Un campo che cambia il calcolo del budget (piano, giorno di rinnovo, quota
    // manuale, calendario di lavoro...) non deve restare visibile solo al widget
    // dopo il prossimo refresh automatico (fino a 30 min dopo, vedi CLAUDE.md).
    if (touchedKeys.has('accounts') || touchedKeys.has('workSchedule')) {
      window.hypermiler.requestUsageRefresh();
    }

    savedSettings = structuredClone(settings);
    newAccountId = null;
    showSaveStatus('Impostazioni salvate ✓');
  }));

  document.getElementById('btn-check-updates')!.addEventListener('click', guarded(async () => {
    const btn = document.getElementById('btn-check-updates') as HTMLButtonElement;
    const status = document.getElementById('updates-status') as HTMLElement;
    btn.disabled = true;
    status.textContent = 'Controllo in corso…';
    try {
      renderUpdatesCard(await window.hypermiler.checkForUpdates());
    } catch (err) {
      status.textContent = `Controllo non riuscito: ${(err as Error)?.message || err}`;
    } finally {
      btn.disabled = false;
    }
  }));

  document.getElementById('btn-download-update')!.addEventListener('click', guarded(async () => {
    try {
      await window.hypermiler.downloadUpdate();
    } catch (err) {
      showSaveStatus(`Download non riuscito: ${(err as Error)?.message || err}`);
    }
  }));

  document.getElementById('btn-cancel')!.addEventListener('click', guarded(async () => {
    // Scarta le modifiche non salvate: ricarica lo stato realmente persistito e
    // ripopola il form da lì.
    settings = await window.hypermiler.getSettings();
    savedSettings = structuredClone(settings);
    populateForm();
    showSaveStatus('Modifiche annullate');
  }));
}

async function init(): Promise<void> {
  buildWeekGrid();
  settings = await window.hypermiler.getSettings();
  savedSettings = structuredClone(settings);
  populateForm();
  bindEvents();
  (document.getElementById('app-version') as HTMLElement).textContent = await window.hypermiler.getAppVersion();
  renderUpdatesCard(settings.updates);
  // Solo lo stato aggiornamenti (gestito dal main): il resto del form resta in
  // bozza, un ripopolamento completo scarterebbe le modifiche non salvate.
  window.hypermiler.onSettingsUpdate((updated) => {
    if (settings && updated.updates) {
      settings.updates = { ...updated.updates, autoCheck: settings.updates?.autoCheck ?? updated.updates.autoCheck };
    }
    renderUpdatesCard(updated.updates);
  });
}

document.addEventListener('DOMContentLoaded', () => { runGuarded(init()); });
