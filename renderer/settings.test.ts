import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('only Codex omits the manual renewal field and its hint', () => {
  const html = readFileSync(new URL('./settings.html', import.meta.url), 'utf8');
  for (const provider of ['codex', 'claude', 'copilot']) {
    const template = html.match(new RegExp(`<template id="tpl-detail-${provider}">([\\s\\S]*?)</template>`))?.[1];
    assert.ok(template, `Missing ${provider} detail template`);
    for (const attribute of ['data-account-field="subscription.renewalRule.day"', 'data-role="renewal-hint"']) {
      assert.equal(template.includes(attribute), provider !== 'codex', `${provider}: ${attribute}`);
    }
  }
});
