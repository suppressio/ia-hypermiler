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
  updateConnectionStatuses();
}

function updateCopilotWarningVisibility(): void {
  const warning = document.getElementById('copilot-org-warning') as HTMLElement;
  const scope = getPath(settings, 'accounts.copilot.accountScope');
  warning.hidden = scope !== 'organization';
}

function updateConnectionStatuses(): void {
  const claudeStatus = document.getElementById('claude-connection-status') as HTMLElement;
  const hasClaudeSession = !!getPath(settings, 'accounts.claude.session.sessionKey');
  claudeStatus.textContent = hasClaudeSession ? 'Connesso' : 'Non connesso';
  claudeStatus.classList.toggle('connected', hasClaudeSession);

  const copilotStatus = document.getElementById('copilot-connection-status') as HTMLElement;
  const copilotUsername = getPath(settings, 'accounts.copilot.credentials.username') as string | null;
  copilotStatus.textContent = copilotUsername ? `Connesso come ${copilotUsername}` : 'Non connesso';
  copilotStatus.classList.toggle('connected', !!copilotUsername);
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
    el.addEventListener('change', async () => {
      const field = el.dataset.field as string;
      const value = readFieldValue(el);
      setPath(settings as PlainRecord, field, value);
      if (field === 'accounts.copilot.accountScope') updateCopilotWarningVisibility();
      await persist(topLevelKey(field));
      showSaveStatus('Salvato');

      // Cambiare stile finestra richiede di ricreare la BrowserWindow principale.
      if (field === 'ui.windowStyle') {
        window.hypermiler.setWindowStyle(value as AppSettings['ui']['windowStyle']);
      }
      if (field === 'ui.alwaysOnTop') {
        window.hypermiler.setAlwaysOnTop(value as boolean);
      }
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
    showSaveStatus('Impostazioni salvate ✓');
  });

  document.getElementById('btn-connect-claude')!.addEventListener('click', async () => {
    const btn = document.getElementById('btn-connect-claude') as HTMLButtonElement;
    const status = document.getElementById('claude-connection-status') as HTMLElement;
    btn.disabled = true;
    status.textContent = 'Login in corso… (completa nella finestra che si è aperta)';
    try {
      const result = await window.hypermiler.connectClaude();
      settings = await window.hypermiler.getSettings();
      updateConnectionStatuses();
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
      updateConnectionStatuses();
      showSaveStatus(`Copilot connesso come ${result.username}`);
    } catch (err) {
      status.textContent = `Token non valido: ${(err as Error)?.message || err}`;
    } finally {
      btn.disabled = false;
    }
  });
}

async function init(): Promise<void> {
  buildWeekGrid();
  settings = await window.hypermiler.getSettings();
  populateForm();
  bindEvents();
}

document.addEventListener('DOMContentLoaded', init);
