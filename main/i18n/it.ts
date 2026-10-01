// main/i18n/it.ts — Italian main-process strings, typed against en.ts.

import type { MainMessageKey } from './en';

export const it: Record<MainMessageKey, string> = {
  'tray.toggle': 'Mostra/Nascondi',
  'tray.settings': 'Impostazioni…',
  'tray.refresh': 'Aggiorna ora',
  'tray.alwaysOnTop': 'Sempre in primo piano',
  'tray.quit': 'Esci',
  'tray.updateAvailable': 'Aggiornamento disponibile ({version})…',

  'notify.threshold': "{account}: hai superato il {threshold}% del budget.",
  'notify.formatDrift': 'Il formato della risposta {provider} sembra cambiato: ho aperto una bozza di segnalazione nel browser (da rivedere e confermare tu).',
  'notify.updateAvailable': 'È disponibile la versione {version}: apri Impostazioni → Aggiornamenti per scaricarla.',

  'startup.failedTitle': 'IA Hypermiler non è riuscita ad avviarsi',
  'login.claudeWindowTitle': 'Accedi a Claude',

  'oauth.successTitle': 'Accesso GitHub completato',
  'oauth.successMessage': 'Autenticazione riuscita.',
  'oauth.failedTitle': 'Accesso GitHub non riuscito',
  'oauth.invalidCallback': 'Callback OAuth non valida o scaduta.',
  'oauth.exchangeFailed': 'Scambio del token fallito.',
  'oauth.closeTab': "Puoi chiudere questa scheda e tornare all'app.",

  'error.sessionExpired': "Sessione scaduta o non valida — riconnetti l'account da Impostazioni. ({detail})",
};
