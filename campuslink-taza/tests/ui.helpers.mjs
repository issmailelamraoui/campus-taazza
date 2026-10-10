import { expect } from '@playwright/test';

export async function chooseOption(trigger, value) {
  const id = await trigger.getAttribute('id');
  await trigger.click();
  const page = trigger.page();
  const list = page.getByRole('listbox').filter({ visible: true });
  await expect(list).toBeVisible();
  await list.locator(`[role="option"][data-value=${JSON.stringify(String(value))}]`).click();
  await expect(page.locator(`[id=${JSON.stringify(id)}]`)).toHaveAttribute('aria-expanded', 'false');
}

export async function autocompleteValues(input) {
  const controls = await input.getAttribute('aria-controls');
  if (!controls) return [];
  return input.page().locator(`[id=${JSON.stringify(controls)}] [role="option"]`).evaluateAll(options => options.map(option => option.getAttribute('data-value') ?? option.textContent.trim()));
}

export async function classifyChatFiles(page, module = 'Module des fichiers du message') {
  const modal = page.getByRole('dialog');
  await expect(modal.getByRole('heading', { name: 'Classer les fichiers du message', exact: true })).toBeVisible();
  const batch = modal.locator('.upload-batch');
  await batch.getByLabel(/^Module/).fill(module);
  await batch.getByRole('button', { name: /Appliquer aux/ }).click();
  for (let index = 0; index < await modal.locator('.upload-file').count(); index++) {
    const row = modal.locator('.upload-file').nth(index);
    if (!(await row.locator('.upload-file-editor').count())) await row.getByRole('button', { name: /^Modifier / }).click();
    await row.locator('.upload-file-editor').getByLabel(/^Part\/Chapitre/).fill(String(index + 1));
  }
  await modal.getByRole('button', { name: /^Vérifier/ }).click();
  await expect(modal.locator('.upload-review-list')).toBeVisible();
  await modal.getByRole('button', { name: 'Joindre au message', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}
