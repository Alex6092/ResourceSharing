import { test, expect } from '@playwright/test';

test.use({ baseURL: 'http://127.0.0.1:5173', viewport: { width: 1440, height: 1000 },
  launchOptions: { executablePath: process.env.BROWSER_EXECUTABLE || (process.platform === 'win32' ? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' : undefined) } });

test('interface française : connexion, dossier, dépôt et renommage', async ({ page }) => {
  const suffix = Date.now();
  const failures = [];
  page.on('pageerror', (error) => failures.push(error.message));
  await page.goto('/');
  await page.getByRole('link', { name: 'Se connecter avec Moodle', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Ressources pédagogiques', exact: true })).toBeVisible();
  await expect(page.locator('tbody')).toContainText('Debian 13 — atelier réseau.iso');
  await page.screenshot({ path: 'test-results/interface-desktop.png', fullPage: true });
  await page.locator('.heading-actions').getByRole('button', { name: /Nouveau dossier/ }).click();
  await page.getByRole('dialog').getByRole('textbox').fill(`Dossier navigateur ${suffix}`);
  await page.getByRole('dialog').getByRole('button', { name: 'Enregistrer', exact: true }).click();
  await expect(page.locator('tbody')).toContainText(`Dossier navigateur ${suffix}`);

  await page.locator('.heading-actions').getByRole('button', { name: /Déposer des fichiers/ }).click();
  const bytes = Buffer.alloc(200000, 37);
  await page.locator('.uppy-Dashboard input[type=file]').first().setInputFiles({ name: `validation-navigateur-${suffix}.iso`, mimeType: 'application/octet-stream', buffer: bytes });
  await page.getByRole('button', { name: 'Lancer les transferts', exact: true }).click();
  await expect(page.locator('tbody')).toContainText(`validation-navigateur-${suffix}.iso`, { timeout: 30000 });
  const row = page.locator('tbody tr').filter({ hasText: `validation-navigateur-${suffix}.iso` });
  await row.locator('summary').click();
  await row.getByRole('button', { name: 'Renommer', exact: true }).click();
  await page.getByRole('dialog').getByRole('textbox').fill(`validation-renommée-${suffix}.iso`);
  await page.getByRole('dialog').getByRole('button', { name: 'Enregistrer', exact: true }).click();
  await expect(page.locator('tbody')).toContainText(`validation-renommée-${suffix}.iso`);
  const renamed = page.locator('tbody tr').filter({ hasText: `validation-renommée-${suffix}.iso` });
  await renamed.locator('summary').click();
  await renamed.getByRole('button', { name: 'Déplacer', exact: true }).click();
  await page.getByRole('dialog').getByRole('combobox').selectOption({ label: `Dossier navigateur ${suffix}` });
  await page.getByRole('dialog').getByRole('button', { name: 'Enregistrer', exact: true }).click();
  await expect(page.locator('tbody')).not.toContainText(`validation-renommée-${suffix}.iso`);
  await page.locator('.sidebar').getByRole('button', { name: new RegExp(`Dossier navigateur ${suffix}`) }).click();
  await expect(renamed).toBeVisible();
  await renamed.locator('summary').click();
  await renamed.getByRole('button', { name: 'Mettre en corbeille', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Mettre en corbeille', exact: true }).click();
  await page.locator('.sidebar').getByRole('button', { name: /Corbeille/ }).click();
  await expect(renamed).toBeVisible();
  await renamed.locator('summary').click();
  await renamed.getByRole('button', { name: 'Restaurer', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Enregistrer', exact: true }).click();
  await expect(page.locator('tbody')).not.toContainText(`validation-renommée-${suffix}.iso`);
  await page.locator('.sidebar').getByRole('button', { name: /Catalogue/ }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.heading-actions').getByRole('button', { name: /Déposer des fichiers/ }).click();
  await page.evaluate(() => window.scrollTo(0, 0));
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: 'test-results/interface-mobile.png', fullPage: true });
  await expect(page.getByRole('heading', { name: 'Ressources pédagogiques', exact: true })).toBeVisible();
  expect(failures).toEqual([]);
});
