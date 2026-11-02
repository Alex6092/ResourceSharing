import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e', testMatch: '**/browser.test.mjs',
  outputDir: 'test-results/playwright', timeout: 60000, workers: 1, reporter: 'list',
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' },
});
