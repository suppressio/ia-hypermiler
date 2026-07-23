// settings.ts — logica finestra impostazioni (nessun accesso diretto a Node.js)

import type { AppSettings, HypermilerBridge } from './types';

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

function populateForm(): void {
  fieldElements().forEach((el) => {
    const value = getPath(settings, el.dataset.field as string);
    if (value === undefined || value === null) return;
    if (el instanceof HTMLInputElement && el.type === 'checkbox') el.checked = !!value;
    else el.value = String(value);
  });
  updateCopilotWarningVisibility();
  updateCopilotAuthMethodVisibility();
  updateConnectionStatuses();
}

function updateCopilotWarningVisibility(): void {
  const warning = document.getElementById('copilot-org-warning') as HTMLElement;
  const scope = getPath(settings, 'accounts.copilot.accountScope');
  warning.hidden = scope !== 'organization';
}

// I due pannelli (PAT/OAuth) condividono lo stesso slot di credenziali
// (accounts.copilot.credentials): mostrarli entrambi contemporaneamente dava
// l'impressione di due connessioni indipendenti (feedback utente). Solo uno alla
// volta, in base al metodo selezionato — stesso pattern di updateCopilotWarningVisibility.
function updateCopilotAuthMethodVisibility(): void {
  const method = getPath(settings, 'accounts.copilot.authMethod');
  const patPanel = document.getElementById('copilot-pat-panel') as HTMLElement;
  const oauthPanel = document.getElementById('copilot-oauth-panel') as HTMLElement;
  patPanel.hidden = method === 'oauth';
  oauthPanel.hidden = method !== 'oauth';
}

function updateConnectionStatuses(): void {
  const claudeStatus = document.getElementById('claude-connection-status') as HTMLElement;
  const hasClaudeSession = !!getPath(settings, 'accounts.claude.session.sessionKey');
  claudeStatus.textContent = hasClaudeSession ? 'Connesso' : 'Non connesso';
  claudeStatus.classList.toggle('connected', hasClaudeSession);
  (document.getElementById('btn-disconnect-claude') as HTMLButtonElement).disabled = !hasClaudeSession;

  const copilotStatus = document.getElementById('copilot-connection-status') as HTMLElement;
  const copilotUsername = getPath(settings, 'accounts.copilot.credentials.username') as string | null;
  copilotStatus.textContent = copilotUsername ? `Connesso come ${copilotUsername}` : 'Non connesso';
  copilotStatus.classList.toggle('connected', !!copilotUsername);
  (document.getElementById('btn-disconnect-copilot') as HTMLButtonElement).disabled = !copilotUsername;
}

function showSaveStatus(text: string): void {
  const el = document.getElementById('save-status') as HTMLElement;
  el.textContent = text;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { el.textContent = ''; }, 2500);
}

async function persist(key: string): Promise<void> {
  await window.hypermiler.setSettings({ [key]: (settings as PlainRecord)[key] });
}

function bindEvents(): void {
  fieldElements().forEach((el) => {
    el.addEventListener('change', () => {
      const field = el.dataset.field as string;
      const value = readFieldValue(el);
      setPath(settings as PlainRecord, field, value);
      if (field === 'accounts.copilot.accountScope') updateCopilotWarningVisibility();
      if (field === 'accounts.copilot.authMethod') updateCopilotAuthMethodVisibility();
      // Nessun salvataggio né effetto collaterale qui: la modifica resta "in
      // bozza" nel form finché l'utente non preme "Salva" (o "Annulla" per
      // scartarla) — prima si salvava ad ogni campo, un comportamento discordante
      // col pulsante "Salva impostazioni" già presente (feedback utente).
    });
  });

  document.getElementById('btn-save')!.addEventListener('click', async () => {
    // Rilegge esplicitamente tutti i campi (anche quelli senza un evento 'change'
    // ancora scattato, es. input numerico in focus) e salva tutto in un colpo solo.
    const touchedKeys = new Set<string>();
    fieldElements().forEach((el) => {
      const field = el.dataset.field as string;
      setPath(settings as PlainRecord, field, readFieldValue(el));
      touchedKeys.add(topLevelKey(field));
    });
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
    showSaveStatus('Impostazioni salvate ✓');
  });

  document.getElementById('btn-cancel')!.addEventListener('click', async () => {
    // Scarta le modifiche non salvate: ricarica lo stato realmente persistito e
    // ripopola il form da lì.
    settings = await window.hypermiler.getSettings();
    savedSettings = structuredClone(settings);
    populateForm();
    showSaveStatus('Modifiche annullate');
  });

  document.getElementById('btn-connect-claude')!.addEventListener('click', async () => {
    const btn = document.getElementById('btn-connect-claude') as HTMLButtonElement;
    const status = document.getElementById('claude-connection-status') as HTMLElement;
    btn.disabled = true;
    status.textContent = 'Login in corso… (completa nella finestra che si è aperta)';
    try {
      const result = await window.hypermiler.connectClaude();
      settings = await window.hypermiler.getSettings();
      savedSettings = structuredClone(settings);
      // connectClaude() abilita anche accounts.claude.enabled lato main (main.ts,
      // handler auth:connectClaude): senza rileggere l'intero form, la checkbox
      // "Account collegato/abilitato" restava visibilmente disallineata (spuntata
      // no) rispetto allo stato "Connesso" appena mostrato.
      populateForm();
      showSaveStatus(result?.organizationId ? 'Claude connesso' : 'Claude connesso (organizzazione non rilevata)');
    } catch (err) {
      status.textContent = `Connessione non riuscita: ${(err as Error)?.message || err}`;
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById('btn-connect-copilot')!.addEventListener('click', async () => {
    const btn = document.getElementById('btn-connect-copilot') as HTMLButtonElement;
    const status = document.getElementById('copilot-connection-status') as HTMLElement;
    const input = document.getElementById('copilot-token-input') as HTMLInputElement;
    const token = input.value.trim();
    if (!token) {
      status.textContent = 'Incolla un token prima di salvare';
      return;
    }
    btn.disabled = true;
    status.textContent = 'Verifica token…';
    try {
      const result = await window.hypermiler.connectCopilot(token);
      input.value = '';
      settings = await window.hypermiler.getSettings();
      savedSettings = structuredClone(settings);
      populateForm();
      showSaveStatus(`Copilot connesso come ${result.username}`);
    } catch (err) {
      status.textContent = `Token non valido: ${(err as Error)?.message || err}`;
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById('btn-connect-copilot-oauth')!.addEventListener('click', async () => {
    const btn = document.getElementById('btn-connect-copilot-oauth') as HTMLButtonElement;
    // Riusa lo stesso indicatore di stato del flusso PAT: rappresentano la stessa
    // connessione (accounts.copilot.credentials), solo ottenuta in due modi diversi.
    const status = document.getElementById('copilot-connection-status') as HTMLElement;
    const clientIdInput = document.querySelector<HTMLInputElement>('[data-field="accounts.copilot.oauthApp.clientId"]');
    const secretInput = document.getElementById('copilot-oauth-secret-input') as HTMLInputElement;
    const clientId = clientIdInput?.value.trim() ?? '';
    const clientSecret = secretInput.value.trim();
    if (!clientId || !clientSecret) {
      status.textContent = 'Inserisci Client ID e Client Secret prima di connetterti';
      return;
    }
    btn.disabled = true;
    status.textContent = "Apri il browser e autorizza l'accesso…";
    try {
      const result = await window.hypermiler.connectCopilotOAuth(clientId, clientSecret);
      secretInput.value = '';
      settings = await window.hypermiler.getSettings();
      savedSettings = structuredClone(settings);
      populateForm();
      showSaveStatus(`Copilot connesso (OAuth) come ${result.username}`);
    } catch (err) {
      status.textContent = `Accesso OAuth non riuscito: ${(err as Error)?.message || err}`;
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById('btn-disconnect-claude')!.addEventListener('click', async () => {
    const btn = document.getElementById('btn-disconnect-claude') as HTMLButtonElement;
    const status = document.getElementById('claude-connection-status') as HTMLElement;
    btn.disabled = true;
    try {
      await window.hypermiler.disconnectClaude();
      settings = await window.hypermiler.getSettings();
      savedSettings = structuredClone(settings);
      // populateForm() ricalcola anche lo stato disabled del pulsante (ora "non
      // connesso" → disabilitato): nessun riabilitazione qui nel percorso di successo.
      populateForm();
      showSaveStatus('Claude disconnesso');
    } catch (err) {
      status.textContent = `Disconnessione non riuscita: ${(err as Error)?.message || err}`;
      btn.disabled = false;
    }
  });

  document.getElementById('btn-disconnect-copilot')!.addEventListener('click', async () => {
    const btn = document.getElementById('btn-disconnect-copilot') as HTMLButtonElement;
    const status = document.getElementById('copilot-connection-status') as HTMLElement;
    btn.disabled = true;
    try {
      await window.hypermiler.disconnectCopilot();
      settings = await window.hypermiler.getSettings();
      savedSettings = structuredClone(settings);
      populateForm();
      showSaveStatus('Copilot disconnesso');
    } catch (err) {
      status.textContent = `Disconnessione non riuscita: ${(err as Error)?.message || err}`;
      btn.disabled = false;
    }
  });
}

async function init(): Promise<void> {
  buildWeekGrid();
  settings = await window.hypermiler.getSettings();
  savedSettings = structuredClone(settings);
  populateForm();
  bindEvents();
}

document.addEventListener('DOMContentLoaded', init);
