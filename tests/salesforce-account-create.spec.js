/**
 * End-to-end Salesforce Account creation (Playwright).
 * Credentials: test-data/Credentials and URLs.csv or SF_LOGIN_URL / SF_USERNAME / SF_PASSWORD.
 */

const { test, expect } = require('@playwright/test');
const { loadCredentials } = require('./load-test-data');

/** Real-time lines for batch / terminal (flushes on newline in Node). */
function progress(line) {
  console.log(`[Automation] ${line}`);
}

const ACCOUNT_LIST_PATH = '/lightning/o/Account/list?filterName=AllAccounts';

function newAccountButton(page) {
  return page
    .getByRole('button', { name: 'New', exact: true })
    .or(page.getByRole('link', { name: /^new$/i }))
    .first();
}

/** Dismiss stray Lightning popups without waiting on invisible controls. */
async function dismissLightningOverlays(page) {
  await page.keyboard.press('Escape').catch(() => {});
  const closeBtn = page.getByRole('button', { name: /close/i }).first();
  if (await closeBtn.isVisible({ timeout: 600 }).catch(() => false)) {
    await closeBtn.click({ timeout: 1500 }).catch(() => {});
  }
}

async function waitForAccountListNewButton(page, timeout = 15_000) {
  const btn = newAccountButton(page);
  const ok = await btn.isVisible({ timeout }).catch(() => false);
  return ok ? btn : null;
}

async function openAccountList(page) {
  await page.goto(ACCOUNT_LIST_PATH, { waitUntil: 'commit' });
  await dismissLightningOverlays(page);
  const btn = await waitForAccountListNewButton(page, 30_000);
  if (!btn) {
    await expect(newAccountButton(page)).toBeVisible({ timeout: 45_000 });
    return newAccountButton(page);
  }
  return btn;
}

async function isLoginPageVisible(page) {
  if (/login|secur\/login|my\.salesforce\.com\/?(\?|$)/i.test(page.url())) {
    return true;
  }
  const byRole = page.getByRole('textbox', { name: /username/i }).first();
  if (await byRole.isVisible({ timeout: 2000 }).catch(() => false)) {
    return true;
  }
  return page.locator('input#username, input[name="username"]').first().isVisible({ timeout: 1000 }).catch(() => false);
}

/**
 * Log in when the Salesforce login form is shown (classic or sandbox "Log In to Sandbox" page).
 */
async function performSalesforceLogin(page, { loginUrl, username, password }) {
  if (!(await isLoginPageVisible(page))) {
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });
  }
  await page.waitForLoadState('domcontentloaded').catch(() => {});

  const usernameInput = page
    .getByRole('textbox', { name: /username/i })
    .or(page.locator('input#username, input[name="username"]'))
    .first();
  if (!(await usernameInput.waitFor({ state: 'visible', timeout: 30_000 }).then(() => true).catch(() => false))) {
    return false;
  }

  const passwordInput = page
    .getByRole('textbox', { name: /password/i })
    .or(page.locator('input#password, input[name="pw"]'))
    .first();
  const loginButton = page
    .getByRole('button', { name: /log in/i })
    .or(page.locator('input[name="Login"], input#Login'));

  await usernameInput.fill(username);
  await passwordInput.fill(password);
  await loginButton.first().click();

  await page.waitForURL(/lightning\.force\.com|my\.salesforce\.com/i, {
    timeout: 120_000,
    waitUntil: 'commit',
  });
  return true;
}

/**
 * Fast path: go straight to Account list (auth.json / session). Login only if New is not ready.
 * Skips loading Lightning home between login and Account list.
 */
async function ensureLoggedInAndOnAccountList(page, { loginUrl, username, password }) {
  progress('1–2. Login + Account list - Running...');

  await page.goto(ACCOUNT_LIST_PATH, { waitUntil: 'commit' });
  await dismissLightningOverlays(page);

  let newButton = await waitForAccountListNewButton(page, 18_000);
  if (newButton) {
    progress('1–2. Login + Account list - Passed (session reuse, skipped login + home)');
    return newButton;
  }

  await page.waitForLoadState('domcontentloaded').catch(() => {});

  progress('1. Login - Running...');
  const didLogin = await performSalesforceLogin(page, { loginUrl, username, password });
  if (!didLogin) {
    throw new Error('Salesforce login form not found — check credentials CSV or SF_LOGIN_URL / SF_USERNAME / SF_PASSWORD.');
  }
  progress('1. Login - Passed');

  newButton = await openAccountList(page);
  progress('2. Navigate to Account list - Passed');
  return newButton;
}

const NONE_OPTION = /^[\s\u00a0]*(--)?none(--)?[\s\u00a0]*$/i;

/** Pause between fields (ms). Override: SF_STEP_DELAY_MS=0 for fastest run. */
const STEP_BETWEEN_FIELDS_MS = Math.max(
  0,
  Number.parseInt(process.env.SF_STEP_DELAY_MS ?? '80', 10) || 80,
);

/**
 * How many times `fillAllVisibleFields` scrolls the modal and re-scans rows (lazy LWC sections).
 * Default 3 is enough after `scrollModalBody` primes the modal; raise with env if your layout loads very late.
 * Example: `SF_FORM_SCROLL_PASSES=6 npx playwright test ...`
 */
const FORM_SCROLL_PASSES = Math.min(
  12,
  Math.max(1, Number.parseInt(process.env.SF_FORM_SCROLL_PASSES ?? '2', 10) || 2),
);

function randInt(lo, hi) {
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

function randomDigits(length) {
  let s = '';
  for (let i = 0; i < length; i += 1) {
    s += String(randInt(0, 9));
  }
  return s;
}

function randomAlphaNum(length) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let o = '';
  for (let i = 0; i < length; i += 1) {
    o += alphabet.charAt(randInt(0, alphabet.length - 1));
  }
  return o;
}

function randomEmail() {
  return `acct_${randomAlphaNum(6)}_${Date.now()}@example.com`;
}

function randomPhoneDigits() {
  return `9${randomDigits(9)}`;
}

function randomNumberFieldValue() {
  return String(randInt(10000, 999_999));
}

function randomTextFieldValue({ prefix = 'Auto_' } = {}) {
  return `${prefix}${randomAlphaNum(5)}_${Date.now()}`;
}

function randomTextareaValue() {
  return `Rand ${randomAlphaNum(10)} / ${Date.now()}`;
}

async function pickRandomNonNonePicklistLabel(page) {
  const opts = await picklistOverlay(page)
    .locator('[role="option"], li.slds-listbox__item')
    .all()
    .catch(() => []);
  const labels = [];
  for (const opt of opts) {
    const t = ((await opt.innerText().catch(() => '')) || '').trim();
    if (t && !NONE_OPTION.test(t) && !/^no results|^no matches/i.test(t)) {
      labels.push(t);
    }
  }
  if (labels.length === 0) return '';
  return labels[randInt(0, labels.length - 1)];
}

function echoFieldLabel(label) {
  return (label || '(no label)').replace(/\s+/g, ' ').trim().slice(0, 72);
}

/** LWC overlay animation after combobox click. */
const LWC_MENU_ANIMATION_MS = 250;

async function waitAfterComboClick(page) {
  await page.waitForTimeout(LWC_MENU_ANIMATION_MS);
}

/**
 * Global Lightning overlay: listbox with options, filtered to Playwright-visible only.
 * (CSS `[role="listbox"]:visible` can miss LWC overlays; `filter({ visible: true })` matches SLDS behavior.)
 */
function picklistOverlay(page) {
  return page
    .locator('[role="listbox"]')
    .filter({ has: page.locator('[role="option"], li.slds-listbox__item') })
    .filter({ visible: true });
}

/** Lookup / typeahead results: visible scroller (global overlay, not row-scoped). */
function lookupResultsScroller(page) {
  return page.locator('.forceSearchScroller:visible');
}

/**
 * After a combobox click: brief animation, then assert a visible listbox (bounded timeout only).
 */
async function expectPicklistOverlayVisible(page, { timeout = 18_000 } = {}) {
  await waitAfterComboClick(page);
  await expect(picklistOverlay(page)).toBeVisible({ timeout });
}

/**
 * Open picklist overlay with one retry (re-click) if the visible listbox does not appear.
 */
async function openPicklistOverlayWithRetry(page, combo, row, { timeout = 18_000 } = {}) {
  try {
    await expectPicklistOverlayVisible(page, { timeout });
    return true;
  } catch {
    await combo.click({ force: true });
    try {
      await expectPicklistOverlayVisible(page, { timeout });
      return true;
    } catch {
      const fallback = row.locator('.slds-combobox').locator('button.slds-combobox__input');
      if (await fallback.isVisible().catch(() => false)) {
        await fallback.click({ force: true });
        try {
          await expectPicklistOverlayVisible(page, { timeout: 12_000 });
          return true;
        } catch {
          return false;
        }
      }
      return false;
    }
  }
}

/**
 * Click a global overlay option by label (page-level; overlay is not row-scoped).
 * Uses getByRole when accessible name matches, else `[role="option"]` + hasText.
 */
async function clickGlobalPicklistOptionByText(page, value) {
  const byRole = page.getByRole('option', { name: value, exact: true });
  if ((await byRole.count()) > 0) {
    await byRole.click({ force: true, timeout: 15_000 }).catch(() => {});
    return;
  }
  const opt = page.locator('[role="option"]', { hasText: value });
  if ((await opt.count()) > 0) {
    await opt.click({ force: true, timeout: 15_000 }).catch(() => {});
    return;
  }
  await page.locator('li.slds-listbox__item:visible', { hasText: value }).click({ force: true, timeout: 15_000 }).catch(() => {});
}

function clipToMaxlength(value, maxRaw) {
  const n = maxRaw ? Number.parseInt(maxRaw, 10) : NaN;
  if (!Number.isFinite(n) || n <= 0) return value;
  return value.length > n ? value.slice(0, n) : value;
}

/** Salesforce text date fields often expect DD/MM/YYYY (en-GB). */
function localeDateStringForSalesforce() {
  return new Date().toLocaleDateString('en-GB');
}

function isoDateForNativeInput() {
  return new Date().toISOString().slice(0, 10);
}

async function getRowLabelText(row) {
  const raw = await row
    .locator('.slds-form-element__label, legend.slds-form-element__legend')
    .first()
    .innerText()
    .catch(() => '');
  return raw.replace(/\*+/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Parent Account row: English/asterisk label **or** LWC `aria-label` (translated layouts where SLDS label text differs).
 * Keeps generic `fillVisibleLookup` from clicking the same resolved Parent combobox on wrapper rows.
 */
async function isParentAccountRow(row) {
  if (/parent account/i.test((await getRowLabelText(row)).toLowerCase())) {
    return true;
  }
  if (await row.locator('[aria-label*="Parent Account" i]').first().isVisible().catch(() => false)) {
    return true;
  }
  return false;
}

async function isAccountApprovalStatusRow(row) {
  if (/account approval status/i.test((await getRowLabelText(row)).toLowerCase())) {
    return true;
  }
  return row.locator('[aria-label*="Account Approval Status" i]').first().isVisible().catch(() => false);
}

/** Account Approval Status must stay **None** (not a random picklist value). */
async function fillAccountApprovalStatusNone(page, row, { force = false } = {}) {
  if (!(await isAccountApprovalStatusRow(row))) {
    return false;
  }

  const combo = row
    .getByRole('combobox')
    .or(row.locator('button.slds-combobox__input[role="combobox"], button.slds-combobox__input'))
    .first();

  if (!(await combo.isVisible().catch(() => false))) {
    return false;
  }
  if (await combo.isDisabled().catch(() => false) || (await isReadonly(combo))) {
    return true;
  }

  const shown = ((await combo.innerText().catch(() => '')) || '').trim();
  if (!force && shown && NONE_OPTION.test(shown)) {
    return true;
  }

  await combo.scrollIntoViewIfNeeded();
  await combo.click({ force: true });
  const opened = await openPicklistOverlayWithRetry(page, combo, row, { timeout: 12_000 });
  if (!opened) {
    return NONE_OPTION.test(((await combo.innerText().catch(() => '')) || '').trim());
  }

  for (const noneLabel of ['--None--', 'None']) {
    await clickGlobalPicklistOptionByText(page, noneLabel).catch(() => {});
    await picklistOverlay(page).waitFor({ state: 'hidden', timeout: 8000 }).catch(() => {});
    const after = ((await combo.innerText().catch(() => '')) || '').trim();
    if (NONE_OPTION.test(after)) {
      return true;
    }
    await combo.click({ force: true }).catch(() => {});
    await openPicklistOverlayWithRetry(page, combo, row, { timeout: 8000 }).catch(() => false);
  }

  return NONE_OPTION.test(((await combo.innerText().catch(() => '')) || '').trim());
}

function randomAddressSearchQuery() {
  const seeds = ['Riyadh', 'Jeddah', 'King Fahd', 'Olaya', 'Main Street', 'Industrial Area', 'Airport'];
  return `${seeds[randInt(0, seeds.length - 1)]} ${randomAlphaNum(4)}`;
}

async function isAddressSearchRow(row) {
  const label = (await getRowLabelText(row)).toLowerCase();
  if (/address search/i.test(label)) {
    return true;
  }
  const searchInput = row
    .locator('input[placeholder*="Search Address" i], input[aria-label*="Address Search" i]')
    .filter({ visible: true })
    .first();
  return searchInput.isVisible({ timeout: 800 }).catch(() => false);
}

async function addressSearchShowsSelection(row) {
  if (await row.locator('.slds-pill, lightning-pill, button.slds-pill__remove').first().isVisible().catch(() => false)) {
    return true;
  }
  const inp = row.locator('input[type="search"], input.slds-input, input[type="text"]').filter({ visible: true }).first();
  if (!(await inp.isVisible().catch(() => false))) {
    return false;
  }
  const val = ((await inp.inputValue().catch(() => '')) || '').trim();
  return val.length > 4 && !/^search address$/i.test(val);
}

/** Billing / Shipping **Address Search** — type query, pick first address from results list. */
async function fillAddressSearchRow(page, row, { force = false } = {}) {
  if (!(await isAddressSearchRow(row))) {
    return false;
  }
  if (!force && (await addressSearchShowsSelection(row))) {
    return true;
  }

  try {
    const searchInput = row
      .locator('input[placeholder*="Search Address" i], input[aria-label*="Address Search" i], input[type="search"]')
      .or(row.locator('input.slds-input, input[role="combobox"]'))
      .filter({ visible: true })
      .first();

    if (!(await searchInput.isVisible({ timeout: 4000 }).catch(() => false))) {
      return false;
    }
    if (await searchInput.isDisabled().catch(() => false) || (await isReadonly(searchInput))) {
      return true;
    }

    const query = randomAddressSearchQuery();
    const section = /billing/i.test(await getRowLabelText(row)) ? 'Billing' : /shipping/i.test(await getRowLabelText(row)) ? 'Shipping' : 'Address';
    progress(`${section} Address Search: type "${query}" → select first result`);

    await searchInput.click({ force: true });
    await searchInput.fill('');
    await searchInput.fill(query);
    await waitAfterComboClick(page);

    const resultOptions = page.locator(
      '[role="option"]:visible, li.slds-listbox__item:visible, .slds-listbox__item:visible',
    );
    await resultOptions.first().waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {});

    const candidates = await resultOptions.all().catch(() => []);
    for (const opt of candidates) {
      const t = ((await opt.innerText().catch(() => '')) || '').trim();
      if (!t || /no results|no matches|search address/i.test(t)) {
        continue;
      }
      await opt.click({ force: true });
      await page.waitForTimeout(400);
      if (await addressSearchShowsSelection(row)) {
        return true;
      }
    }

    await searchInput.press('ArrowDown').catch(() => {});
    await searchInput.press('Enter').catch(() => {});
    await page.waitForTimeout(400);
    return (await addressSearchShowsSelection(row)) || true;
  } catch (err) {
    progress(`Address Search skipped (non-blocking): ${err?.message ?? err}`);
    return false;
  }
}

async function isBillingShippingAddressTextRow(row) {
  const label = (await getRowLabelText(row)).toLowerCase();
  return /^(billing|shipping)\s+(street|city|state|province|zip|postal|country)/i.test(label);
}

/**
 * Selected Parent Account is not always `.slds-pill` — LWC often hides the label in shadow, leaves
 * combobox text empty, or only sets `title` / a record link. Too-strict checks made the script redo Parent
 * and stall before other fields.
 */
async function parentAccountLookupShowsSelection(row) {
  if (await row.locator('button.slds-pill__remove, button[title*="Remove" i]').first().isVisible().catch(() => false)) {
    return true;
  }
  if (await row.locator('.slds-pill, lightning-pill').first().isVisible().catch(() => false)) {
    return true;
  }

  const lk = row.locator('lightning-lookup').first();
  if (await lk.locator('button.slds-pill__remove').first().isVisible().catch(() => false)) {
    return true;
  }
  if (!(await lk.isVisible().catch(() => false))) {
    return false;
  }

  /** Resolved lookup often exposes a link to the Account record */
  if (
    await lk
      .locator('a[href*="/lightning/r/001"], a[href*="/Account/"], .outputLookupLink a, a.outputLookupLink')
      .first()
      .isVisible()
      .catch(() => false)
  ) {
    return true;
  }

  const inp = lk
    .locator('input[role="combobox"], input.slds-input, input[type="text"]')
    .filter({ visible: true })
    .first();
  if (await inp.isVisible().catch(() => false)) {
    const val = ((await inp.inputValue().catch(() => '')) || '').trim();
    if (val.length > 0 && !/^test\s*$/i.test(val) && !NONE_OPTION.test(val)) {
      return true;
    }
    /** LWC lookup often keeps the chosen record only on `data-value` while `inputValue()` stays empty. */
    const dataVal = ((await inp.getAttribute('data-value')) || '').trim();
    if (
      dataVal &&
      !/^test\s*$/i.test(dataVal) &&
      !NONE_OPTION.test(dataVal) &&
      !/^parent account$/i.test(dataVal) &&
      !/^search\b/i.test(dataVal)
    ) {
      return true;
    }
    const ro = ((await inp.getAttribute('readonly')) || '').toLowerCase();
    const ariaR = ((await inp.getAttribute('aria-readonly')) || '').toLowerCase();
    if ((ro === 'readonly' || ariaR === 'true') && val.length > 2) {
      return true;
    }
    const cls = ((await inp.getAttribute('class')) || '').toString();
    if (cls.includes('slds-combobox__input-value') && (dataVal.length > 1 || val.length > 2)) {
      return true;
    }
  }

  const fmt = lk.locator('lightning-formatted-text, lightning-formatted-rich-text, [class*="formatted"]').first();
  if (await fmt.isVisible().catch(() => false)) {
    const ft = ((await fmt.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
    if (
      ft &&
      !/^search\b/i.test(ft) &&
      !NONE_OPTION.test(ft) &&
      !/^parent account$/i.test(ft) &&
      !/^test\s*$/i.test(ft)
    ) {
      return true;
    }
  }

  const combo = lk.getByRole('combobox').first();
  if (await combo.isVisible().catch(() => false)) {
    const title = ((await combo.getAttribute('title')) || '').replace(/\s+/g, ' ').trim();
    if (title && !/^parent account$/i.test(title) && !/^search\b/i.test(title) && !NONE_OPTION.test(title)) {
      return true;
    }

    const txt = ((await combo.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
    const lower = txt.toLowerCase();
    if (!txt.length) {
      const visibleInp = lk
        .locator('input[role="combobox"], input.slds-input')
        .filter({ visible: true })
        .first();
      const dv = ((await visibleInp.getAttribute('data-value').catch(() => '')) || '').trim();
      if (
        dv &&
        !/^test\s*$/i.test(dv) &&
        !NONE_OPTION.test(dv) &&
        !/^parent account$/i.test(dv) &&
        !/^search\b/i.test(dv)
      ) {
        return true;
      }
      return false;
    }
    if (/^search\b/i.test(txt)) {
      return false;
    }
    if (NONE_OPTION.test(txt)) {
      return false;
    }
    if (/^parent account$/i.test(lower)) {
      return false;
    }
    if (/^test\s*$/i.test(txt)) {
      return false;
    }
    return true;
  }

  return false;
}

async function waitUntilParentAccountShowsSelection(page, row, { timeoutMs = 8_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await parentAccountLookupShowsSelection(row)) {
      return true;
    }
    await page.waitForTimeout(150);
  }
  return parentAccountLookupShowsSelection(row);
}

/** Advanced-search popup stacked over the New Account modal (radio list + footer Select). */
function parentAccountAdvancedSearchModal(page) {
  return page
    .locator('.slds-modal__container:visible, section.slds-modal:not(.slds-hide):visible, [role="dialog"]:visible')
    .filter({
      has: page
        .getByText(/Search Results|Advanced Search|Account Search/i)
        .or(page.locator('.slds-radio_faux, .slds-radio--faux'))
        .or(page.getByRole('button', { name: /^Select$/i })),
    })
    .last();
}

async function waitForParentAdvancedSearchModal(page, timeoutMs = 12_000) {
  const modal = parentAccountAdvancedSearchModal(page);
  await modal.waitFor({ state: 'visible', timeout: timeoutMs });
  await page.locator('.slds-spinner').first().waitFor({ state: 'hidden', timeout: 8000 }).catch(() => {});
  return modal;
}

/** First visible row in the advanced-search popup, then footer **Select** when enabled. */
async function selectFirstVisibleParentSearchOption(searchModal, page) {
  const firstRadioFaux = searchModal.locator('.slds-radio_faux, .slds-radio--faux').first();
  const firstRadioInput = searchModal.locator('input[type="radio"]').first();
  const firstListRow = searchModal
    .locator('[role="option"]:visible, tr[data-row-key]:visible, li.slds-listbox__item:visible')
    .first();

  if (await firstRadioFaux.isVisible({ timeout: 5000 }).catch(() => false)) {
    await firstRadioFaux.scrollIntoViewIfNeeded().catch(() => {});
    try {
      await firstRadioFaux.click({ timeout: 5000 });
    } catch {
      await firstRadioFaux.click({ force: true, timeout: 5000 });
    }
  } else if (await firstRadioInput.isVisible({ timeout: 3000 }).catch(() => false)) {
    await firstRadioInput.click({ force: true, timeout: 5000 });
  } else if (await firstListRow.isVisible({ timeout: 3000 }).catch(() => false)) {
    await firstListRow.click({ timeout: 5000 });
  } else {
    throw new Error('Parent Account: no visible search result in advanced-search popup');
  }

  const selectBtn = searchModal.getByRole('button', { name: /^Select$/i }).last();
  await expect(selectBtn).toBeEnabled({ timeout: 12_000 });
  await selectBtn.click({ timeout: 10_000 });
}

async function findParentAccountRow(modal) {
  const rows = modal.locator('.slds-form-element');
  for (const row of await rows.all()) {
    if (await isParentAccountRow(row)) {
      return row;
    }
  }
  return null;
}

/**
 * Parent Account lookup — single attempt, user flow:
 * click field → type "test" → Enter → wait for advanced-search popup → first visible result → Select.
 */
async function fillParentAccountLookup(page, row) {
  if (await parentAccountLookupShowsSelection(row)) {
    return true;
  }

  try {
    await row.scrollIntoViewIfNeeded().catch(() => {});

    let input = row
      .locator('input[role="combobox"][id^="combobox-input-"]')
      .or(row.locator('input[id^="combobox-input-"]'))
      .or(row.locator('lightning-lookup input[type="text"], lightning-lookup input.slds-input'))
      .filter({ visible: true })
      .first();

    if (!(await input.isVisible({ timeout: 4000 }).catch(() => false))) {
      const opener = row
        .locator('lightning-lookup')
        .getByRole('combobox')
        .or(row.getByRole('combobox'))
        .first();
      if (await opener.isVisible().catch(() => false)) {
        await opener.click({ force: true });
        await waitAfterComboClick(page);
      }
      await input.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
    }

    if (!(await input.isVisible().catch(() => false))) {
      progress('Parent Account: combobox input not visible');
      return false;
    }

    if (await parentAccountLookupShowsSelection(row)) {
      return true;
    }

    const ariaReadonly = ((await input.getAttribute('aria-readonly')) || '').toLowerCase();
    const readOnlyAttr = ((await input.getAttribute('readonly')) || '').toLowerCase();
    const dataValPre = ((await input.getAttribute('data-value')) || '').trim();
    if (
      (ariaReadonly === 'true' || readOnlyAttr === 'readonly') &&
      dataValPre &&
      !/^test\s*$/i.test(dataValPre) &&
      !NONE_OPTION.test(dataValPre)
    ) {
      return true;
    }

    progress('Parent Account: click → type "test" → Enter → wait for advanced search');
    await input.click({ force: true });
    await input.fill('test');
    await input.press('Enter');

    const searchModal = await waitForParentAdvancedSearchModal(page, 12_000);

    progress('Parent Account: selecting first visible result');
    await selectFirstVisibleParentSearchOption(searchModal, page);

    await searchModal.waitFor({ state: 'hidden', timeout: 12_000 }).catch(() => {});

    const verified = await waitUntilParentAccountShowsSelection(page, row, { timeoutMs: 8_000 });
    if (!verified) {
      progress('Parent Account: selection not reflected on field after advanced search');
      return false;
    }

    progress('Parent Account: verified populated');
    return true;
  } catch (err) {
    progress(`Parent Account failed: ${err?.message ?? String(err)}`);
    return false;
  }
}

/** Fill Parent Account once before scrolling other fields (avoids long retries on every scroll pass). */
async function fillParentAccountInModalOnce(page, modal) {
  let row = await findParentAccountRow(modal);
  if (!row) {
    await scrollModalBody(modal);
    row = await findParentAccountRow(modal);
  }
  if (!row) {
    progress('Parent Account: row not visible yet — will retry on first scroll pass');
    return false;
  }
  return fillParentAccountLookup(page, row);
}

/**
 * Mandatory SAP Sync Date — calendar only; picks today when possible.
 * Never throws — returns false so the rest of the form can keep filling/retry passes.
 */
async function fillMandatoryDate(page, row) {
  const label = await getRowLabelText(row);
  if (!/sap sync date/i.test(label)) {
    return false;
  }

  try {
    const dateInput = row.locator('input[id^="input-"]').filter({ visible: true }).first();
    const calendar = page.locator('.slds-datepicker').filter({ visible: true }).first();

    async function openSapDatepicker() {
      const triggers = [
        row.locator('button:has(.slds-icon-calendar)').first(),
        row.locator('button[title*="Date" i], button[aria-label*="Date" i]').first(),
        row.locator('.slds-input__icon-container button').filter({ visible: true }).first(),
        row.locator('lightning-datepicker button').filter({ visible: true }).first(),
      ];
      for (const trig of triggers) {
        if (await trig.isVisible().catch(() => false)) {
          await trig.click().catch(() => {});
          const ok = await calendar.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false);
          if (ok) return true;
        }
      }
      if (await dateInput.isVisible().catch(() => false)) {
        await dateInput.click({ force: true }).catch(() => {});
        await page.waitForTimeout(250);
        return await calendar.waitFor({ state: 'visible', timeout: 10_000 }).then(() => true).catch(() => false);
      }
      return false;
    }

    let opened = await openSapDatepicker();
    if (!opened) {
      opened = await openSapDatepicker();
    }
    if (!opened) {
      return false;
    }

    const todayTd = calendar
      .locator('td.slds-day.slds-is-today')
      .or(calendar.locator('td.slds-is-today'))
      .first();
    if (await todayTd.isVisible({ timeout: 4000 }).catch(() => false)) {
      await todayTd.click({ force: true }).catch(() => {});
    } else {
      const todayBtn = page.getByRole('button', { name: /^today$/i }).first();
      if (await todayBtn.isVisible().catch(() => false)) {
        await todayBtn.click().catch(() => {});
      } else {
        const dayNum = String(new Date().getDate());
        const cell = calendar
          .locator('td.slds-day:not(.slds-day_adjacent-month)')
          .filter({ hasText: new RegExp(`^\\s*${dayNum}\\s*$`) })
          .first();
        if (await cell.isVisible().catch(() => false)) {
          await cell.click({ force: true }).catch(() => {});
        } else {
          await calendar.locator('td.slds-day:not(.slds-day_adjacent-month)').first().click({ force: true }).catch(() => {});
        }
      }
    }

    await calendar.waitFor({ state: 'hidden', timeout: 12_000 }).catch(() => {});

    if (await dateInput.isVisible().catch(() => false)) {
      const v = await dateInput.inputValue().catch(() => '');
      if (!v.trim()) {
        await page.keyboard.press('Escape').catch(() => {});
      }
    }

    return true;
  } catch (e) {
    progress(`SAP Sync Date deferred (will retry scroll pass): ${e?.message ?? e}`);
    await page.keyboard.press('Escape').catch(() => {});
    return false;
  }
}

async function selectDateFromCalendar(page, row, input) {
  if (!(await input.isVisible().catch(() => false))) {
    return false;
  }

  const calendarBtn = row
    .locator(
      'button:has(.slds-icon-calendar), button[title*="Date" i], button[title*="Date"], button[aria-label*="Date" i]',
    )
    .first();

  if (!(await calendarBtn.isVisible().catch(() => false))) {
    return false;
  }

  await calendarBtn.click();
  await page.waitForTimeout(300);

  const calendar = page.locator('.slds-datepicker').first();
  const opened = await calendar.waitFor({ state: 'visible', timeout: 10_000 }).then(() => true).catch(() => false);
  if (!opened) {
    return false;
  }

  const days = calendar.locator('td.slds-day:not(.slds-day_adjacent-month)');
  const count = await days.count();
  if (count === 0) {
    return false;
  }
  let picked = false;
  for (let i = 0; i < count; i++) {
    const cls = ((await days.nth(i).getAttribute('class')) || '').toString();
    if (cls.includes('slds-is-today')) {
      if (i + 1 < count) {
        await days.nth(i + 1).click({ force: true });
        picked = true;
      }
      break;
    }
  }
  if (!picked) {
    await days.first().click({ force: true }).catch(() => {});
  }

  await calendar.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
  return true;
}

async function isDateLikeField(row, input) {
  const role = ((await input.getAttribute('role')) || '').toLowerCase();
  if (role === 'combobox') {
    return false;
  }
  const type = ((await input.getAttribute('type')) || '').toLowerCase();
  if (type === 'date') {
    return true;
  }
  const label = (await getRowLabelText(row)).toLowerCase();
  if (/\bdate\b/i.test(label)) {
    return true;
  }
  const ph = ((await input.getAttribute('placeholder')) || '').toLowerCase();
  if (/\bdd\b|\bmm\b|\byyyy\b|dd\/|\/mm|mm\/|dd-/i.test(ph)) {
    return true;
  }
  const calBtn = row
    .locator(
      'button:has(.slds-icon-calendar), ' +
        '.slds-input__icon-container button, ' +
        'lightning-datepicker button, ' +
        'button[title*="date" i], ' +
        'button[title*="Date" i]',
    )
    .first();
  if (await calBtn.isVisible().catch(() => false)) {
    return true;
  }
  return false;
}

/**
 * After **New** on Account list: choose record type by name, then **Next**.
 * Skipped when the org opens the edit form directly (single/default record type).
 */
function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function selectAccountRecordType(page, recordTypeName) {
  const typePattern = new RegExp(escapeRegex(recordTypeName), 'i');
  const pickerReady = page
    .getByRole('button', { name: /^Next$/i })
    .or(page.locator('.slds-radio--faux, .slds-radio_faux'))
    .or(page.getByRole('radio'))
    .first();

  const hasRecordTypePicker = await pickerReady
    .waitFor({ state: 'visible', timeout: 45_000 })
    .then(() => true)
    .catch(() => false);
  if (!hasRecordTypePicker) {
    return false;
  }

  progress(`Record type: selecting "${recordTypeName}"`);

  const byRadio = page.getByRole('radio', { name: typePattern });
  if ((await byRadio.count()) > 0 && (await byRadio.first().isVisible({ timeout: 5000 }).catch(() => false))) {
    const radio = byRadio.first();
    if (await radio.isChecked().catch(() => false)) {
      progress(`Record type: "${recordTypeName}" already selected`);
    } else {
      try {
        await radio.click({ timeout: 8000 });
      } catch {
        const row = page
          .locator('.changeRecordTypeOptionLeftColumn, .slds-form-element')
          .filter({ hasText: typePattern })
          .first();
        await row.click({ force: true, timeout: 8000 }).catch(() => {});
        await radio.click({ force: true, timeout: 8000 }).catch(() => {});
      }
    }
  } else {
    const typeRow = page
      .locator('.changeRecordTypeOptionLeftColumn, label, .slds-form-element__label')
      .filter({ hasText: typePattern })
      .first();
    if (await typeRow.isVisible({ timeout: 5000 }).catch(() => false)) {
      await typeRow.click({ force: true, timeout: 8000 });
    } else if (/sold to party/i.test(recordTypeName)) {
      await page
        .locator('.slds-radio--faux, .slds-radio_faux')
        .first()
        .click({ force: true, timeout: 8000 })
        .catch(() => page.locator('input[type="radio"]').first().click({ force: true }));
    } else {
      throw new Error(`Record type "${recordTypeName}" was not found in the New Account picker.`);
    }
  }

  await page.waitForTimeout(350);

  const nextBtn = page.getByRole('button', { name: /^Next$/i }).first();
  if (await nextBtn.isVisible({ timeout: 8000 }).catch(() => false)) {
    progress('Record type: clicking Next');
    await nextBtn.click();
    await page.locator('.slds-spinner').first().waitFor({ state: 'hidden', timeout: 60_000 }).catch(() => {});
  }

  return true;
}

async function saveNewAccountModal(page, modal) {
  progress('Save — click Save - Running...');
  let lastSaveErr = '';
  let saved = isAccountRecordUrl(page.url());

  for (let attempt = 0; attempt < 4 && !saved; attempt++) {
    if (!(await modal.isVisible({ timeout: 3000 }).catch(() => false))) {
      throw new Error(
        'New Account modal closed before Save finished — the form was dismissed. Stay on the modal and click Save.',
      );
    }

    try {
      await clickSaveOnModal(page);
    } catch (saveErr) {
      lastSaveErr = String(saveErr?.message ?? saveErr);
      progress(`Save attempt ${attempt + 1}/4 — ${lastSaveErr}`);
    }

    await modal.locator('.slds-spinner:visible').first().waitFor({ state: 'hidden', timeout: 12_000 }).catch(() => {});

    const outcome = await waitForSaveOutcome(page, modal, { timeoutMs: 40_000 });
    if (outcome.ok || isAccountRecordUrl(page.url())) {
      saved = true;
      break;
    }
    if (outcome.reason === 'modal_closed_on_list') {
      throw new Error(
        'Save did not create a record — the New Account modal closed and returned to Accounts list. Check required fields and validation errors.',
      );
    }

    const hadErrors = await handleValidationErrors(page);
    if (hadErrors) {
      progress('Validation errors on form — fixing fields and retrying Save…');
      continue;
    }

    progress(`Save attempt ${attempt + 1}/4 — no navigation yet (${outcome.reason})`);
  }

  if (!saved && !isAccountRecordUrl(page.url())) {
    throw new Error(
      `Save failed after 4 attempts${lastSaveErr ? ` (last error: ${lastSaveErr})` : ''}. Check the modal for required fields or inline validation errors.`,
    );
  }
  progress('Save - Passed');
}

async function waitForAccountRecordPage(page) {
  progress('Wait for Account record page - Running...');
  const accountPathView = /\/Account\/[^/]+\/view/i;
  const lightningAccountView = /\/lightning\/r\/001[a-z0-9]{12,15}\/view/i;
  if (!isAccountRecordUrl(page.url())) {
    const urlWait = { timeout: 60_000, waitUntil: 'domcontentloaded' };
    await Promise.race([
      page.waitForURL(accountPathView, urlWait),
      page.waitForURL(lightningAccountView, urlWait),
      page.getByText(/created|successfully saved|was saved/i).first().waitFor({ state: 'visible', timeout: 60_000 }),
    ]);
  }
  if (!accountPathView.test(page.url()) && !lightningAccountView.test(page.url())) {
    await page.waitForURL(new RegExp(`${accountPathView.source}|${lightningAccountView.source}`, 'i'), {
      timeout: 45_000,
      waitUntil: 'domcontentloaded',
    });
  }
  const finalUrl = page.url();
  const recordId = extractAccountRecordIdFromUrl(finalUrl);
  if (!recordId) {
    throw new Error(`Account record URL did not match expected patterns; URL: ${finalUrl}`);
  }
  progress(`Account record page - Passed (Record ID: ${recordId})`);
  return recordId;
}

/**
 * New → record type → fill all fields by data type → Save → wait for record page.
 */
async function createAccountWithRecordType(page, { recordTypeName, namePrefix, scenarioLabel }) {
  progress(`[${scenarioLabel}] Open New Account - Running...`);
  const newButton = newAccountButton(page);
  await expect(newButton).toBeVisible({ timeout: 45_000 });
  await newButton.click();
  progress(`[${scenarioLabel}] Open New Account - Passed`);

  progress(`[${scenarioLabel}] Select record type "${recordTypeName}" - Running...`);
  const pickedRecordType = await selectAccountRecordType(page, recordTypeName);
  progress(
    pickedRecordType
      ? `[${scenarioLabel}] Select record type - Passed`
      : `[${scenarioLabel}] Select record type - Skipped (no picker)`,
  );

  progress(`[${scenarioLabel}] New Account modal ready - Running...`);
  const modal = accountModal(page);
  await expect(modal).toBeVisible({ timeout: 120_000 });
  await page.locator('.slds-spinner').first().waitFor({ state: 'hidden', timeout: 60_000 }).catch(() => {});

  const nameField = modal
    .locator('input[name="Name"]')
    .or(modal.locator('lightning-input[name="Name"] input'))
    .first();
  await expect(nameField).toBeVisible({ timeout: 90_000 });
  progress(`[${scenarioLabel}] New Account modal ready - Passed`);

  const accountName = randomTextFieldValue({ prefix: namePrefix });
  await nameField.fill(accountName);
  progress(`[${scenarioLabel}] Account Name — ${accountName}`);
  await page.waitForTimeout(STEP_BETWEEN_FIELDS_MS);

  await expandSections(modal);
  await scrollModalBody(modal);

  progress(`[${scenarioLabel}] Fill form (all fields by data type) - Running...`);
  await fillAllVisibleFields(page, modal);

  await saveNewAccountModal(page, modal);
  const recordId = await waitForAccountRecordPage(page);
  progress(`[${scenarioLabel}] Account created - Record ID: ${recordId}`);
  return recordId;
}

async function returnToAccountList(page) {
  progress('Return to Account list (All Accounts) - Running...');
  await page.goto(ACCOUNT_LIST_PATH, { waitUntil: 'commit' });
  await dismissLightningOverlays(page);
  await expect(newAccountButton(page)).toBeVisible({ timeout: 45_000 });
  progress('Return to Account list - Passed');
}

/**
 * **New Account** SLDS modal: visible footer plus **Name** field (ignored other stacked modals that only have footer).
 */
function accountModal(page) {
  return page
    .locator('.slds-modal__container')
    .filter({ visible: true })
    .filter({ has: page.locator('.slds-modal__footer') })
    .filter({
      has: page.locator('input[name="Name"], lightning-input[name="Name"]'),
    })
    .last();
}

function isAccountRecordUrl(url) {
  return (
    /\/Account\/[^/]+\/view/i.test(url) ||
    /\/lightning\/r\/001[a-z0-9]{12,15}\/view/i.test(url) ||
    /\/r\/Account\/[^/]+\/view/i.test(url)
  );
}

async function isReadonly(locator) {
  const aria = ((await locator.getAttribute('aria-readonly')) || '').toLowerCase();
  if (aria === 'true') return true;
  return locator.evaluate((el) => {
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el.readOnly;
    return el.getAttribute('readonly') !== null;
  }).catch(() => false);
}

async function handleContinueSavePopupIfPresent(page) {
  const dialog = page
    .locator('[role="dialog"], [role="alertdialog"]')
    .filter({ hasText: /Continue with save\?/i })
    .first();
  const hasPopup = await dialog.isVisible({ timeout: 2500 }).catch(() => false);
  if (!hasPopup) {
    return;
  }
  await dialog.getByRole('button', { name: /^Continue$/i }).click();
  console.log('Handled Continue popup');
  await dialog.waitFor({ state: 'hidden', timeout: 60_000 }).catch(() => {});
}

function extractAccountRecordIdFromUrl(url) {
  const accountMatch = url.match(/\/Account\/([^/]+)\/view/i);
  if (accountMatch) {
    return accountMatch[1];
  }
  const lightningMatch = url.match(/\/lightning\/r\/(001[a-z0-9]{12,15})\/view/i);
  if (lightningMatch) {
    return lightningMatch[1];
  }
  const classicMatch = url.match(/\/r\/Account\/([^/]+)\/view/i);
  return classicMatch ? classicMatch[1] : '';
}

/** Primary Save control on the New Account modal (org locator). */
function saveButtonOnAccountModal(page) {
  const modal = accountModal(page);
  return modal
    .locator('.slds-modal__footer')
    .locator("xpath=.//button[normalize-space()='Save']")
    .first();
}

/**
 * After Save click: wait for record navigation, success toast, or detect modal dismissed without save.
 */
async function waitForSaveOutcome(page, modal, { timeoutMs = 35_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const url = page.url();
    if (isAccountRecordUrl(url)) {
      return { ok: true, reason: 'record_url' };
    }
    if (await page.getByText(/created|successfully saved|was saved/i).first().isVisible({ timeout: 200 }).catch(() => false)) {
      return { ok: true, reason: 'toast' };
    }
    const modalOpen = await modal.isVisible({ timeout: 200 }).catch(() => false);
    if (!modalOpen && /\/lightning\/o\/Account\/list/i.test(url)) {
      return { ok: false, reason: 'modal_closed_on_list' };
    }
    await page.waitForTimeout(250);
  }
  if (isAccountRecordUrl(page.url())) {
    return { ok: true, reason: 'record_url' };
  }
  return { ok: false, reason: 'timeout' };
}

/**
 * Click **Save** on the New Account modal — keeps the form open until Save is clicked.
 * Uses: `.//button[normalize-space()='Save']` in the modal footer.
 */
async function clickSaveOnModal(page) {
  const modal = accountModal(page);
  await modal.waitFor({ state: 'visible', timeout: 15_000 });

  const footer = modal.locator('.slds-modal__footer').first();
  await footer.scrollIntoViewIfNeeded().catch(() => {});

  const btn = saveButtonOnAccountModal(page);
  progress('Save: waiting for //button[normalize-space()="Save"] in modal footer…');
  await btn.waitFor({ state: 'visible', timeout: 15_000 });

  if (!(await btn.isEnabled().catch(() => false))) {
    progress('Save: waiting for Save to enable (max 20s)…');
    await expect(btn).toBeEnabled({ timeout: 20_000 });
  }

  progress('Save: clicking //button[normalize-space()="Save"]…');
  await btn.click({ timeout: 15_000 });

  await handleContinueSavePopupIfPresent(page);
  progress('Save: click completed');
}

/**
 * Read inline `.slds-form-element__help`, fix each parent row once, dismiss blocking OK if present.
 * @returns {Promise<boolean>} true if at least one visible error help was processed
 */
async function handleValidationErrors(page) {
  await page.getByRole('button', { name: /^ok$/i }).first().click().catch(() => {});

  const modal = accountModal(page);
  if (!(await modal.isVisible({ timeout: 2000 }).catch(() => false))) {
    return false;
  }

  const helps = modal.locator('.slds-form-element__help');
  const n = await helps.count().catch(() => 0);
  const seen = new Set();
  let found = false;

  for (let i = 0; i < n; i++) {
    const h = helps.nth(i);
    if (!(await h.isVisible().catch(() => false))) {
      continue;
    }
    const msg = ((await h.innerText().catch(() => '')) || '').trim();
    if (!msg) {
      continue;
    }
    found = true;
    const row = h.locator('xpath=./ancestor::*[contains(@class,"slds-form-element")][1]').first();
    if (!(await row.isVisible().catch(() => false))) {
      continue;
    }
    const key = await row
      .locator('.slds-form-element__label, legend.slds-form-element__legend')
      .first()
      .innerText()
      .catch(() => `row-${i}`);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    await row.scrollIntoViewIfNeeded().catch(() => {});
    await fixFieldRowFromValidation(page, row);
  }
  return found;
}

/** Re-apply value for the row that failed validation (force overwrite / re-pick). */
async function fixFieldRowFromValidation(page, row) {
  try {
    if (await fillMandatoryDate(page, row)) {
      return;
    }
  } catch {
    /* SAP row may not be in view yet */
  }
  if (await isParentAccountRow(row)) {
    if (await parentAccountLookupShowsSelection(row)) {
      return;
    }
    await fillParentAccountLookup(page, row);
    return;
  }
  if (await fillAccountApprovalStatusNone(page, row, { force: true })) {
    return;
  }
  if (await fillAddressSearchRow(page, row, { force: true })) {
    return;
  }
  if (await fillVisibleLookup(page, row, { force: true })) {
    return;
  }
  if (await fillVisiblePicklist(page, row, { force: true })) {
    return;
  }
  if (await fillVisibleTextarea(row, { force: true })) {
    return;
  }
  await fillVisibleInput(page, row, { force: true });
}

/**
 * Fill all visible fields on New Account; re-query rows each scroll pass (lazy sections).
 * Per field: **if the control already has a value, skip** (`fillVisible*` / row guards).
 * Parent Account uses the dedicated search-popup flow (see `fillParentAccountLookup`).
 */
async function fillAllVisibleFields(page, modal) {
  await modal.locator('.slds-spinner:visible').first().waitFor({ state: 'hidden', timeout: 8000 }).catch(() => {});

  const body = modal.locator('.slds-modal__content').first();
  const scrollPasses = FORM_SCROLL_PASSES;

  progress(
    `6. Fill new account form — random values, one field at a time (${scrollPasses} scroll pass(es), SF_FORM_SCROLL_PASSES to override)...`,
  );

  /** One Parent Account attempt before scrolling — avoids long retries on every scroll pass. */
  const progressedFieldKeys = new Set();
  let parentAccountResolvedForModal = await fillParentAccountInModalOnce(page, modal);
  if (parentAccountResolvedForModal) {
    progressedFieldKeys.add('parent account');
    progress('      → Parent Account — filled');
    await page.waitForTimeout(STEP_BETWEEN_FIELDS_MS);
  }

  async function markFieldProgress(labelStr) {
    const key = echoFieldLabel(labelStr).toLowerCase();
    if (progressedFieldKeys.has(key)) {
      return;
    }
    progressedFieldKeys.add(key);
    progress(`      → ${echoFieldLabel(labelStr)} — filled`);
    await page.waitForTimeout(STEP_BETWEEN_FIELDS_MS);
  }

  for (let pass = 0; pass < scrollPasses; pass++) {
    const fieldCountAtPassStart = progressedFieldKeys.size;

    if (pass === 0 || pass === scrollPasses - 1 || (pass + 1) % 4 === 0) {
      progress(`   ... scroll pass ${pass + 1}/${scrollPasses} (lazy sections)`);
    }
    const rows = modal.locator('.slds-form-element');
    const rowList = await rows.all();
    for (const row of rowList) {
      try {
        await row.scrollIntoViewIfNeeded().catch(() => {});
        await page.waitForTimeout(50);

        if (!(await row.isVisible().catch(() => false))) {
          continue;
        }

        const label = await row
          .locator('.slds-form-element__label, legend.slds-form-element__legend')
          .first()
          .innerText()
          .catch(() => '');
        const labelStr = typeof label === 'string' ? label : '';

        if (await fillMandatoryDate(page, row)) {
          await markFieldProgress(labelStr);
          continue;
        }

        if (await isParentAccountRow(row)) {
          if (!parentAccountResolvedForModal && pass === 0) {
            parentAccountResolvedForModal = await fillParentAccountLookup(page, row);
          }
          if (parentAccountResolvedForModal || (await parentAccountLookupShowsSelection(row))) {
            parentAccountResolvedForModal = true;
            await markFieldProgress(labelStr);
          }
          continue;
        }

        if (await fillAccountApprovalStatusNone(page, row)) {
          await markFieldProgress(labelStr);
          continue;
        }

        if (await fillAddressSearchRow(page, row)) {
          await markFieldProgress(labelStr || 'Address Search');
          continue;
        }

        const el = row.locator('input, button, textarea').first();
        const quick = { timeout: 2500 };
        const dis = await el.isDisabled(quick).catch(() => false);
        const aria = await el.getAttribute('aria-disabled', quick).catch(() => null);
        if (dis || aria === 'true') {
          continue;
        }

        if (await fillVisibleLookup(page, row)) {
          await markFieldProgress(labelStr);
          continue;
        }
        if (await fillVisiblePicklist(page, row)) {
          await markFieldProgress(labelStr);
          continue;
        }
        if (await fillVisibleTextarea(row)) {
          await markFieldProgress(labelStr);
          continue;
        }
        if (await fillVisibleInput(page, row)) {
          await markFieldProgress(labelStr);
        }
      } catch (rowErr) {
        progress(`   ... row skipped (non-blocking): ${rowErr?.message ?? rowErr}`);
      }
    }

    await body.evaluate((el) => el.scrollBy(0, el.clientHeight || 400));
    await page.waitForTimeout(120);

    /** Stop scrolling once a pass completes no new fields (after pass 2). */
    if (
      pass >= 1 &&
      progressedFieldKeys.size > 0 &&
      progressedFieldKeys.size === fieldCountAtPassStart
    ) {
      progress(`   ... early exit: no new fields completed on pass ${pass + 1} — stopping further scroll passes`);
      break;
    }
  }
  progress('6. Fill new account form (all sections) - Passed');
  await modal.locator('.slds-modal__footer').first().scrollIntoViewIfNeeded().catch(() => {});
}

/**
 * Standard Lightning lookup (dropdown / scroller); never throws so one bad lookup cannot abort step 6.
 */
async function fillVisibleLookup(page, row, { force = false } = {}) {
  try {
    if (await isParentAccountRow(row)) {
      return false;
    }
    if (await isAddressSearchRow(row)) {
      return false;
    }
    const isLookupUi =
      (await row.locator('lightning-lookup').first().isVisible().catch(() => false)) ||
      (await row.locator('.slds-combobox__input-entity-icon').first().isVisible().catch(() => false));
    if (!isLookupUi) {
      return false;
    }
    if (!force) {
      const lkCombo = row.locator('lightning-lookup input[role="combobox"]').filter({ visible: true }).first();
      if (await lkCombo.isVisible().catch(() => false)) {
        const dv = ((await lkCombo.getAttribute('data-value')) || '').trim();
        const ariaRo = ((await lkCombo.getAttribute('aria-readonly')) || '').toLowerCase();
        const ro = ((await lkCombo.getAttribute('readonly')) || '').toLowerCase();
        if (
          dv &&
          !/^test\s*$/i.test(dv) &&
          !NONE_OPTION.test(dv) &&
          (ariaRo === 'true' || ro === 'readonly' || ro === 'true')
        ) {
          return true;
        }
      }
    }
    const hasPill = await row.locator('.slds-pill, lightning-pill').first().isVisible().catch(() => false);
    /** Already chosen — counts as satisfied for lookups (no remount random each pass). */
    if (hasPill && !force) {
      return true;
    }
    if (hasPill && force) {
      const remove = row
        .locator('button.slds-pill__remove, button[title*="Remove" i], lightning-button-icon')
        .first();
      if (await remove.isVisible().catch(() => false)) {
        await remove.click().catch(() => {});
      }
    }

    const opener = row
      .locator('lightning-lookup')
      .getByRole('combobox')
      .or(row.getByRole('combobox'))
      .or(row.getByRole('button', { name: /search/i }));

    const openerReady = opener.first();
    if (!(await openerReady.isVisible().catch(() => false))) {
      return true;
    }
    if (await openerReady.isDisabled().catch(() => false) || (await isReadonly(openerReady))) {
      return true;
    }

    await openerReady.click().catch(() => {});
    await waitAfterComboClick(page);

    const resultsPanel = picklistOverlay(page).or(lookupResultsScroller(page));

    async function waitResultsVisible() {
      return await resultsPanel.waitFor({ state: 'visible', timeout: 12_000 }).then(() => true).catch(() => false);
    }

    let panelOk = await waitResultsVisible();
    if (!panelOk) {
      await openerReady.click({ force: true }).catch(() => {});
      await waitAfterComboClick(page);
      panelOk = await waitResultsVisible();
    }
    if (!panelOk) {
      await page.keyboard.press('Escape').catch(() => {});
      return false;
    }

    const optionOverlay = page.locator(
      '[role="option"]:visible, tr[data-row-key]:visible, li.slds-listbox__item:visible',
    );

    await optionOverlay
      .first()
      .waitFor({ state: 'visible', timeout: 12_000 })
      .catch(() => {});

    const candidates = await optionOverlay.all().catch(() => []);
    const good = [];
    for (const c of candidates) {
      const t = ((await c.innerText().catch(() => '')) || '').trim();
      if (!t || /no results|no matches/i.test(t)) {
        continue;
      }
      good.push(c);
    }
    const rowOpt = good.length ? good[randInt(0, good.length - 1)] : null;
    if (!rowOpt) {
      await page.keyboard.press('Escape').catch(() => {});
      return false;
    }
    await rowOpt.click({ force: true }).catch(() => {});
    await page.waitForTimeout(800);

    const pillOk = await row
      .locator('.slds-pill, lightning-pill')
      .first()
      .waitFor({ state: 'visible', timeout: 15_000 })
      .then(() => true)
      .catch(() => false);

    if (!pillOk) {
      return false;
    }
    return true;
  } catch {
    await page.keyboard.press('Escape').catch(() => {});
    return false;
  }
}

async function fillVisiblePicklist(page, row, { force = false } = {}) {
  try {
    if (await isAccountApprovalStatusRow(row)) {
      return false;
    }
    if (await row.locator('.slds-combobox__input-entity-icon').first().isVisible().catch(() => false)) {
      return false;
    }

    const combo = row
      .getByRole('combobox')
      .or(row.locator('button.slds-combobox__input[role="combobox"], button.slds-combobox__input'));

    if (!(await combo.isVisible().catch(() => false))) {
      return false;
    }
    if (await combo.isDisabled().catch(() => false) || (await isReadonly(combo))) {
      return true;
    }

    if (!force) {
      const shown = ((await combo.innerText().catch(() => '')) || '').trim();
      if (shown && !NONE_OPTION.test(shown)) {
        return true;
      }
    }

    await combo.scrollIntoViewIfNeeded();
    await combo.focus().catch(() => {});
    await combo.click({ force: true });
    const opened = await openPicklistOverlayWithRetry(page, combo, row, { timeout: 18_000 });
    if (!opened) {
      await combo.press('Escape').catch(() => {});
      return false;
    }

    const value = await pickRandomNonNonePicklistLabel(page);
    if (!value) {
      await combo.focus().catch(() => {});
      await combo.press('Escape').catch(() => {});
      return false;
    }

    await clickGlobalPicklistOptionByText(page, value).catch(() => {});

    await picklistOverlay(page)
      .waitFor({ state: 'hidden', timeout: 10_000 })
      .catch(async () => {
        await combo.focus().catch(() => {});
        await combo.press('Escape').catch(() => {});
      });
    return true;
  } catch {
    await page.keyboard.press('Escape').catch(() => {});
    return false;
  }
}

async function fillVisibleTextarea(row, { force = false } = {}) {
  const ta = row.locator('textarea').first();
  if (!(await ta.isVisible().catch(() => false))) {
    return false;
  }
  if (await ta.isDisabled().catch(() => false) || (await isReadonly(ta))) {
    return false;
  }
  const cur = await ta.inputValue().catch(() => '');
  if (cur.trim() && !force) {
    return false;
  }
  if (force && cur.trim()) {
    await ta.fill('');
  }
  const prefix = (await isBillingShippingAddressTextRow(row)) ? 'Addr_' : '';
  const v = clipToMaxlength(`${prefix}${randomTextareaValue()}`, await ta.getAttribute('maxlength'));
  await ta.fill(v);
  return true;
}

/** @returns {Promise<boolean>} true if this call wrote random data into the row */
async function fillVisibleInput(page, row, { force = false } = {}) {
  const labelLower = (await getRowLabelText(row)).toLowerCase();
  if (/sap sync date/i.test(labelLower)) {
    try {
      if (await fillMandatoryDate(page, row)) {
        return true;
      }
    } catch {
      /* leave for next pass */
    }
    return false;
  }

  const input = row
    .locator(
      'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="search"]):not([type="button"]):not([type="submit"]):not([type="file"])',
    )
    .first();
  if (!(await input.isVisible().catch(() => false))) {
    return false;
  }
  if (await input.isDisabled().catch(() => false) || (await isReadonly(input))) {
    return false;
  }
  const cur = await input.inputValue().catch(() => '');
  if (cur.trim() && !force) {
    return false;
  }
  if (force && cur.trim()) {
    await input.fill('');
  }

  const inputType = ((await input.getAttribute('type')) || '').toLowerCase();
  if (inputType === 'date') {
    await input.fill(isoDateForNativeInput());
    return true;
  }
  if (await isDateLikeField(row, input)) {
    if (await selectDateFromCalendar(page, row, input)) {
      return true;
    }
    const maxLen = await input.getAttribute('maxlength').catch(() => '');
    const v = clipToMaxlength(localeDateStringForSalesforce(), maxLen);
    await input.fill(v);
    return true;
  }

  const role = ((await input.getAttribute('role')) || '').toLowerCase();
  const type = ((await input.getAttribute('type')) || 'text').toLowerCase();

  if (role === 'spinbutton' || type === 'number') {
    await input.fill(randomNumberFieldValue());
    return true;
  }
  if (type === 'tel') {
    await input.fill(clipToMaxlength(randomPhoneDigits(), await input.getAttribute('maxlength')));
    return true;
  }
  if (type === 'email') {
    await input.fill(clipToMaxlength(randomEmail(), await input.getAttribute('maxlength')));
    return true;
  }
  const prefix = (await isBillingShippingAddressTextRow(row)) ? 'Addr_' : 'Auto_';
  await input.fill(clipToMaxlength(randomTextFieldValue({ prefix }), await input.getAttribute('maxlength')));
  return true;
}

async function expandSections(scope) {
  const collapsed = scope.locator(
    'button[aria-expanded="false"].slds-section__title-action, lightning-accordion-section button[aria-expanded="false"]',
  );
  const k = await collapsed.count();
  for (let i = 0; i < k; i++) {
    const btn = collapsed.nth(i);
    if (await btn.isVisible().catch(() => false)) {
      await btn.click().catch(() => {});
    }
  }
}

async function scrollModalBody(modal) {
  const body = modal.locator('.slds-modal__content').first();
  if (await body.isVisible().catch(() => false)) {
    await body.evaluate((el) => {
      const h = el.scrollHeight;
      for (let y = 0; y <= h; y += Math.max(200, el.clientHeight * 0.6)) {
        el.scrollTop = y;
      }
      el.scrollTop = 0;
    });
  }
}

test.describe('Salesforce Account (E2E)', () => {
  test('Create Sold To Party and Vendor/Competitor Accounts', async ({ page }) => {
    /**
     * Two record types × large layouts can exceed 15 minutes.
     * Form fill uses scroll passes (SF_FORM_SCROLL_PASSES) plus early exit when idle.
     */
    test.setTimeout(1_800_000);
    page.setDefaultTimeout(60_000);

    const creds = loadCredentials();
    const loginUrl = (process.env.SF_LOGIN_URL || creds.loginUrl || '').trim();
    const username = (process.env.SF_USERNAME || creds.loginId || '').trim();
    const password = (process.env.SF_PASSWORD || creds.password || '').trim();
    const passwordMissing =
      !password || password === 'YOUR_PASSWORD' || String(password).startsWith('YOUR_PASSWORD');

    test.skip(!loginUrl || !username || passwordMissing, 'Configure Salesforce credentials (CSV or env vars).');

    progress('1–2. Login + Account list - Running...');
    await ensureLoggedInAndOnAccountList(page, { loginUrl, username, password });
    progress('1–2. Login + Account list - Passed');

    const soldToPartyId = await createAccountWithRecordType(page, {
      recordTypeName: 'Sold To Party',
      namePrefix: 'Acc_STP_',
      scenarioLabel: 'Sold To Party',
    });

    await returnToAccountList(page);

    const vendorCompetitorId = await createAccountWithRecordType(page, {
      recordTypeName: 'Vendor/Competitor',
      namePrefix: 'Acc_VC_',
      scenarioLabel: 'Vendor/Competitor',
    });

    progress(`Done — Sold To Party: ${soldToPartyId}, Vendor/Competitor: ${vendorCompetitorId}`);
  });
});
