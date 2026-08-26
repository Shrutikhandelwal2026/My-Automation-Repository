const { defineConfig, devices } = require('@playwright/test');

// `viewport: null` is incompatible with `deviceScaleFactor` from the stock device preset.
const { viewport: _vp, deviceScaleFactor: _dsf, ...desktopChromeRest } = devices['Desktop Chrome'];

/**
 * Default: visible Chrome (watch anytime). Set SF_HEADLESS=1 to hide the window.
 * Auth reuse / MFA is handled in the test (auth.json).
 */
const FORCE_HEADLESS = /^(1|true|yes)$/i.test(String(process.env.SF_HEADLESS || process.env.CI || ''));
const HEADLESS = FORCE_HEADLESS;
/** Full artifacts slow the run a lot — only keep on failure unless SF_DEBUG_MEDIA=1. */
const DEBUG_MEDIA = /^(1|true|yes)$/i.test(String(process.env.SF_DEBUG_MEDIA || ''));

module.exports = defineConfig({
  testDir: './tests',
  timeout: 2_700_000,
  expect: {
    timeout: 10_000,
  },
  retries: process.env.CI ? 2 : 0,
  reporter: [['html', { open: 'never' }], ['list']],
  use: {
    headless: HEADLESS,
    baseURL: 'https://tibbiyah--qa.sandbox.lightning.force.com',
    viewport: HEADLESS ? { width: 1920, height: 1080 } : null,
    permissions: ['geolocation'],
    geolocation: { latitude: 24.7136, longitude: 46.6753 }, // Riyadh
    actionTimeout: 20_000,
    navigationTimeout: 60_000,
    trace: DEBUG_MEDIA ? 'on' : 'retain-on-failure',
    screenshot: DEBUG_MEDIA ? 'on' : 'only-on-failure',
    video: DEBUG_MEDIA ? 'on' : 'off',
    launchOptions: {
      args: HEADLESS
        ? ['--disable-dev-shm-usage', '--window-size=1920,1080']
        : ['--disable-dev-shm-usage', '--start-maximized'],
    },
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...desktopChromeRest,
        channel: 'chrome',
        viewport: HEADLESS ? { width: 1920, height: 1080 } : null,
        permissions: ['geolocation'],
        geolocation: { latitude: 24.7136, longitude: 46.6753 },
        launchOptions: {
          args: HEADLESS
            ? ['--disable-dev-shm-usage', '--window-size=1920,1080']
            : ['--disable-dev-shm-usage', '--start-maximized'],
        },
      },
    },
  ],
});
