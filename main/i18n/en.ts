// main/i18n/en.ts — main-process strings (tray, system notifications, dialogs,
// login window, OAuth callback page). Reference dictionary: it.ts must have the
// same keys (compile-time check). UI strings live in renderer/i18n instead — each
// process owns its own texts (two separate TypeScript projects).

export const en = {
  'tray.toggle': 'Show/Hide',
  'tray.settings': 'Settings…',
  'tray.refresh': 'Refresh now',
  'tray.alwaysOnTop': 'Always on top',
  'tray.quit': 'Quit',
  'tray.updateAvailable': 'Update available ({version})…',

  'notify.threshold': '{account}: you have passed {threshold}% of the budget.',
  'notify.pace': '{account}: today you have used {used}% of the quota, against a daily budget of {budget}%. Slow down to make it last until renewal.',
  'notify.formatDrift': 'The format of the {provider} response seems to have changed: a report draft opened in your browser (for you to review and confirm).',
  'notify.updateAvailable': 'Version {version} is available: open Settings → Updates to download it.',

  'startup.failedTitle': 'IA Hypermiler could not start',
  'login.claudeWindowTitle': 'Sign in to Claude',

  'oauth.successTitle': 'GitHub sign-in complete',
  'oauth.successMessage': 'Authentication succeeded.',
  'oauth.failedTitle': 'GitHub sign-in failed',
  'oauth.invalidCallback': 'Invalid or expired OAuth callback.',
  'oauth.exchangeFailed': 'Token exchange failed.',
  'oauth.closeTab': 'You can close this tab and go back to the app.',

  'error.sessionExpired': 'Session expired or invalid — reconnect the account from Settings. ({detail})',
  'error.invalidGithubHost': 'GitHub domain not supported: use github.com or your company domain <name>.ghe.com.',
  'error.reportNoAccounts': 'Connect at least one account before reporting the responses.',
  'report.confirmTitle': "Create a diagnostic report?",
  'report.confirmDetail': "The report reads the usage of {accounts} connected account(s) and saves one text file in your Downloads folder with:\n• the usage responses of Claude/GitHub, with real values (percentages, amounts, dates)\n• the settings that affect pacing (scope, renewal day, work schedule)\n• how the app read the data (windows, verdicts, budgets)\n• the last 7 days of history and today's samples\n• the last errors and warnings of the app\n• system facts: time zone, screens and scaling, memory/CPU used by the app, its internal timings, number of cores and RAM\n\nNever included: account names, credentials, cookies, ids, your company domain, free text, CPU/GPU model, computer or user name.\n\nNothing is sent: the folder opens and a GitHub issue draft opens in the browser. You decide whether to attach the file and submit it.",
  'report.confirm': "Create report",
  'report.cancel': "Cancel",
  'error.copilotEnterpriseManaged': 'This github.com account has no Copilot usage data. If your company uses its own GitHub domain (<name>.ghe.com), set it in the account and reconnect with an account of that domain.',
} as const;

export type MainMessageKey = keyof typeof en;
