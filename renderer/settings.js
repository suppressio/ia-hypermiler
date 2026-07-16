// settings.js — logica finestra impostazioni (nessun accesso diretto a Node.js)

(function () {
  const DAY_LABELS = { mon: 'Lunedì', tue: 'Martedì', wed: 'Mercoledì', thu: 'Giovedì', fri: 'Venerdì', sat: 'Sabato', sun: 'Domenica' };
  let settings = null;
  let saveTimer = null;

  function getPath(obj, path) {
    return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
  }

  function setPath(obj, path, value) {
    const keys = path.split('.');
    let cursor = obj;
    for (let i = 0; i < keys.length - 1; i++) {
      if (typeof cursor[keys[i]] !== 'object' || cursor[keys[i]] === null) cursor[keys[i]] = {};
      cursor = cursor[keys[i]];
    }
    cursor[keys[keys.length - 1]] = value;
  }

  function topLevelKey(path) {
    return path.split('.')[0];
  }

  function readFieldValue(el) {
    if (el.type === 'checkbox') return el.checked;
    if (el.type === 'number') return el.value === '' ? null : Number(el.value);
    return el.value;
  }

  function buildWeekGrid() {
    const grid = document.getElementById('week-grid');
    grid.innerHTML = '';
    Object.entries(DAY_LABELS).forEach(([key, label]) => {
      const labelEl = document.createElement('span');
      labelEl.textContent = label;
      const select = document.createElement('select');
      select.dataset.field = `workSchedule.days.${key}`;
      ['full', 'half', 'off'].forEach((opt) => {
        const optionEl = document.createElement('option');
        optionEl.value = opt;
        optionEl.textContent = opt === 'full' ? 'Intera' : opt === 'half' ? 'Mezza giornata' : 'Riposo';
        select.appendChild(optionEl);
      });
      grid.appendChild(labelEl);
      grid.appendChild(select);
    });
  }

  function populateForm() {
    document.querySelectorAll('[data-field]').forEach((el) => {
      const value = getPath(settings, el.dataset.field);
      if (value === undefined || value === null) return;
      if (el.type === 'checkbox') el.checked = !!value;
      else el.value = value;
    });
    updateCopilotWarningVisibility();
    updateConnectionStatuses();
  }

  function updateCopilotWarningVisibility() {
    const warning = document.getElementById('copilot-org-warning');
    const scope = getPath(settings, 'accounts.copilot.accountScope');
    warning.hidden = scope !== 'organization';
  }

  function updateConnectionStatuses() {
    const claudeStatus = document.getElementById('claude-connection-status');
    const hasClaudeSession = !!getPath(settings, 'accounts.claude.session.sessionKey');
    claudeStatus.textContent = hasClaudeSession ? 'Connesso' : 'Non connesso';
    claudeStatus.classList.toggle('connected', hasClaudeSession);

    const copilotStatus = document.getElementById('copilot-connection-status');
    const copilotUsername = getPath(settings, 'accounts.copilot.credentials.username');
    copilotStatus.textContent = copilotUsername ? `Connesso come ${copilotUsername}` : 'Non connesso';
    copilotStatus.classList.toggle('connected', !!copilotUsername);
  }

  function showSaveStatus(text) {
    const el = document.getElementById('save-status');
    el.textContent = text;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { el.textContent = ''; }, 2500);
  }

  async function persist(key) {
    await window.hypermiler.setSettings({ [key]: settings[key] });
  }

  function bindEvents() {
    document.querySelectorAll('[data-field]').forEach((el) => {
      el.addEventListener('change', async () => {
        const value = readFieldValue(el);
        setPath(settings, el.dataset.field, value);
        if (el.dataset.field === 'accounts.copilot.accountScope') updateCopilotWarningVisibility();
        await persist(topLevelKey(el.dataset.field));
        showSaveStatus('Salvato');

        // Cambiare stile finestra richiede di ricreare la BrowserWindow principale.
        if (el.dataset.field === 'ui.windowStyle') {
          window.hypermiler.setWindowStyle(value);
        }
        if (el.dataset.field === 'ui.alwaysOnTop') {
          window.hypermiler.setAlwaysOnTop(value);
        }
      });
    });

    document.getElementById('btn-save').addEventListener('click', async () => {
      // Rilegge esplicitamente tutti i campi (anche quelli senza un evento 'change'
      // ancora scattato, es. input numerico in focus) e salva tutto in un colpo solo.
      const touchedKeys = new Set();
      document.querySelectorAll('[data-field]').forEach((el) => {
        setPath(settings, el.dataset.field, readFieldValue(el));
        touchedKeys.add(topLevelKey(el.dataset.field));
      });
      for (const key of touchedKeys) {
        await persist(key);
      }
      showSaveStatus('Impostazioni salvate ✓');
    });

    document.getElementById('btn-connect-claude').addEventListener('click', async () => {
      const btn = document.getElementById('btn-connect-claude');
      const status = document.getElementById('claude-connection-status');
      btn.disabled = true;
      status.textContent = 'Login in corso… (completa nella finestra che si è aperta)';
      try {
        const result = await window.hypermiler.connectClaude();
        settings = await window.hypermiler.getSettings();
        updateConnectionStatuses();
        showSaveStatus(result?.organizationId ? 'Claude connesso' : 'Claude connesso (organizzazione non rilevata)');
      } catch (err) {
        status.textContent = `Connessione non riuscita: ${err?.message || err}`;
      } finally {
        btn.disabled = false;
      }
    });

    document.getElementById('btn-connect-copilot').addEventListener('click', async () => {
      const btn = document.getElementById('btn-connect-copilot');
      const status = document.getElementById('copilot-connection-status');
      const input = document.getElementById('copilot-token-input');
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
        status.textContent = `Token non valido: ${err?.message || err}`;
      } finally {
        btn.disabled = false;
      }
    });
  }

  async function init() {
    buildWeekGrid();
    settings = await window.hypermiler.getSettings();
    populateForm();
    bindEvents();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
