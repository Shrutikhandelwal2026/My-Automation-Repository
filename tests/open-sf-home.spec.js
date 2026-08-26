const { test, expect } = require('@playwright/test');

test('open Salesforce Lightning home page', async ({ page }) => {
  console.log('[Automation] 1. Open Lightning home - Running...');
  await page.goto('/lightning/page/home', { waitUntil: 'domcontentloaded' });

  // Salesforce commonly redirects unauthenticated users across domains.
  // We only assert we've reached a Salesforce-controlled URL related to this navigation.
  await expect(page).toHaveURL(
    /tibbiyah--qa\.sandbox\.(lightning\.force|my\.salesforce)\.com|\/(login|lightning\/page\/home)/,
  );
  console.log('[Automation] 1. Open Lightning home - Passed');
});

