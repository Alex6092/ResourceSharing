// Real Moodle page, PHP login/AJAX and TinyMCE in the fresh qualification DB.
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';

const fixture = JSON.parse(await readFile(process.argv[2], 'utf8'));
const origin = 'http://127.0.0.1:3458';
const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || undefined });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.setDefaultTimeout(45000);
page.setDefaultNavigationTimeout(90000);
try {
  await page.goto(origin + '/login/index.php');
  await page.locator('#username').fill('qacontributor');
  await page.locator('#password').fill(fixture.browserPassword);
  await Promise.all([page.waitForURL((url) => !url.pathname.startsWith('/login/')), page.locator('#loginbtn').click()]);
  await page.goto(origin + '/qa-filesharing-editor.php');
  const button = page.getByRole('button', { name: 'Select an educational resource', exact: true });
  await expect(button).toBeVisible({ timeout: 90000 });
  await page.getByRole('menuitem', { name: 'Insert', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: 'Select an educational resource', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await button.click();
  const dialog = page.getByRole('dialog', { name: 'Select an educational resource' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Debian — atelier & réseau.iso');
  await dialog.getByRole('button', { name: 'Insert download link', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const editor = page.frameLocator('#qaeditor_ifr');
  const anchor = editor.locator('a');
  await expect(anchor).toHaveText('Télécharger Debian <atelier> & VM');
  await expect(anchor).toHaveAttribute('href', `http://127.0.0.1:5174/download/${fixture.resourceId}`);
  assert.equal(await editor.locator('atelier').count(), 0, 'Le libellé doit être du texte échappé.');
  await expect(editor.locator('body')).toContainText('Existing content.');
  assert.deepEqual(errors, []);
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/moodle-tiny-editor.png', fullPage: true });
  console.log('OK Moodle Tiny réel : bouton, menu Insérer, modale AJAX et insertion du lien échappé.');
} catch (error) {
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/moodle-tiny-failure.png', fullPage: true }).catch(() => {});
  await writeFile('test-results/moodle-tiny-failure.txt', (await page.locator('body').innerText()).slice(0, 24000));
  throw error;
} finally {
  await browser.close();
}
