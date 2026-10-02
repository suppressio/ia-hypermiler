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
  'notify.pace': "{account}: oggi hai usato il {used}% della quota, a fronte di un budget giornaliero del {budget}%. Rallenta per arrivare al rinnovo.",
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
  'error.invalidGithubHost': 'Dominio GitHub non supportato: usa github.com oppure il dominio aziendale <nome>.ghe.com.',
  'error.reportNoAccounts': 'Collega almeno un account prima di segnalare le risposte.',
  'report.confirmTitle': "Creare un report di diagnosi?",
  'report.confirmDetail': "Il report legge l'utilizzo di {accounts} account collegati e salva un file di testo nella cartella Download con:\n• le risposte di utilizzo di Claude/GitHub, con valori reali (percentuali, importi, date)\n• le impostazioni che influiscono sul pacing (ambito, giorno di rinnovo, calendario di lavoro)\n• come l'app ha letto i dati (finestre, verdetti, budget)\n• gli ultimi 7 giorni di storico e i campioni di oggi\n• gli ultimi errori e avvisi dell'app\n\nMai inclusi: nomi degli account, credenziali, cookie, id, il dominio aziendale, testi liberi.\n\nNon viene inviato nulla: si apre la cartella e una bozza di issue GitHub nel browser. Sei tu a decidere se allegare il file e inviarla.",
  'report.confirm': "Crea report",
  'report.cancel': "Annulla",
  'error.copilotEnterpriseManaged': "Questo account github.com non ha dati di consumo Copilot. Se la tua azienda usa un proprio dominio GitHub (<nome>.ghe.com), impostalo nell'account e ricollegati con un account di quel dominio.",
};
