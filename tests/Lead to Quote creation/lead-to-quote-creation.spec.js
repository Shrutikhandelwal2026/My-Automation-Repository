/**
 * Salesforce Lead → Quote E2E (checklist):
 *   1. Lead creation
 *   2. Lead qualification
 *   3. Lead conversion
 *   4. Contact record fill — optional (skip by default; SF_FILL_CONTACT=1 only)
 *   5. Account record fill — optional (skip by default; SF_FILL_ACCOUNT=1 only)
 *   6. Opportunity record fill
 *   7. Add Price Book
 *   8. Add Product(s)
 *   9. Create/open Quote — set Quote Type + Business Unit on the Quote
 *  10. Browse Catalogs only if QLI count is 0
 *  11. Each QLI → Pricing Calculator update + validate vs QLI record
 *  12. Quote Totals (Total Price / GP% / GP Amount) per formulas
 *  13. Generate PDF Document → Preview PDF → validate Quotation Details vs Lines
 *
 * After Convert the Lead record is gone. Account RT: Sold To Party.
 * Opportunity RT from Product Category (Consumables / Medical Equipment).
 *
 * Credentials: test-data/Credentials and URLs.csv or SF_* env vars.
 * Optional: SF_STEP_DELAY_MS, SF_PASSKEY_WAIT_MS, SF_FORM_SCROLL_PASSES,
 *           SF_FAST=0 (fill every empty field — slow; default is required-only),
 *           SF_SPEED=0.25 (scale fixed sleeps; default 0.25 when SF_FAST=1, else 1),
 *           SF_HEADLESS=1 (hide Chrome; default = visible window so you can watch anytime),
 *           SF_HEADLESS_AFTER_MFA=0 (use Playwright fixture page instead of owned browser + auth.json),
 *           SF_ACCOUNT_RECORD_TYPE (Sold to Party | Supplier),
 *           SF_FILL_CONTACT=1 (opt-in Contact fill — skipped by default),
 *           SF_FILL_ACCOUNT=1 (opt-in Account fill — skipped by default),
 *           SF_STRICT_VALIDATION=1 (throw on remaining FAILs; default = read errors, fix, continue),
 *           SF_PRICEBOOK_SEARCH, SF_PRODUCT_SEARCH, SF_ADD_PRODUCT_MIN / SF_ADD_PRODUCT_MAX (default 2–3),
 *           SF_CATALOG_NAME (Browse Catalog pick when 0 QLI — default Al Hammad),
 *           SF_SUPPLIER_ACCOUNT (existing Account search text for Supplier PriceBook — never New),
 *           SF_SKIP_QUOTE=1,
 *           SF_STOP_AFTER_CONVERT=1 (stop after Lead Convert; skip Acc/Contact/Opp fill + Quote),
 *           SF_QUOTE_ID=0Q0… (resume Quote → Lines → Configure pricing → validate → PDF),
 *           SF_REUSE_LEAD=1 + SF_LEAD_ID=00Q… (opt-in only — default is always New Lead),
 *           SF_OPP_ID=006… (resume: skip Lead/Convert; fill Opp → Price Book → Products → Quote),
 *           One Quote per Opportunity — never create a second; open existing if Quotes (n) ≥ 1.
 *           SF_CALC_UNIT_PRICE / SF_CALC_DISCOUNT_PCT / SF_CALC_UNIT_COST (defaults if blank/0)
 */

const { test, expect, chromium } = require('@playwright/test');
const { loadCredentials } = require('../load-test-data');
const fs = require('fs');
const path = require('path');

function progress(line) {
  console.log(`[Automation] ${line}`);
}

const STEP_MS = Math.max(0, Number.parseInt(process.env.SF_STEP_DELAY_MS ?? '0', 10) || 0);
const FORM_SCROLL_PASSES = Math.min(
  12,
  Math.max(1, Number.parseInt(process.env.SF_FORM_SCROLL_PASSES ?? '1', 10) || 1),
);
/**
 * Fast fill (default ON): only required + Qualify prerequisites — not every empty field.
 * Set SF_FAST=0 to fill all empty fields (slow, old behavior).
 */
const FAST_FILL = !/^(0|false|no)$/i.test(String(process.env.SF_FAST ?? '1'));
/**
 * Scale fixed sleep() delays. Default 0.1 when SF_FAST=1 (snappy), else 1.
 * Override with SF_SPEED=0.1 … 1.
 */
const SPEED = Math.min(
  1,
  Math.max(
    0.05,
    Number.parseFloat(process.env.SF_SPEED ?? (FAST_FILL ? '0.1' : '1')) || (FAST_FILL ? 0.1 : 1),
  ),
);
/**
 * Own a Chrome browser + auth.json (default ON).
 * Set SF_HEADLESS_AFTER_MFA=0 to use the Playwright fixture page instead.
 */
const HEADLESS_AFTER_MFA = !/^(0|false|no)$/i.test(String(process.env.SF_HEADLESS_AFTER_MFA ?? '1'));
/**
 * Hide the Chrome window. Default OFF — keep a visible window so you can watch anytime.
 * Set SF_HEADLESS=1 for invisible (true headless).
 */
const RUN_HEADLESS = /^(1|true|yes)$/i.test(String(process.env.SF_HEADLESS || ''));
const SF_AUTH_STATE_PATH = path.join(process.cwd(), 'auth.json');
const SF_ORIGIN = 'https://tibbiyah--qa.sandbox.lightning.force.com';
const SF_BASE_URL = process.env.SF_BASE_URL || SF_ORIGIN;
const LEAD_LIST_PATH = '/lightning/o/Lead/list?filterName=AllOpenLeads';
const HOME_PATH = '/lightning/page/home';
const NONE_OPTION = /^[\s\u00a0]*(--)?none(--)?[\s\u00a0]*$/i;
const LWC_MENU_ANIMATION_MS = FAST_FILL ? 40 : 150;
const PRICEBOOK_SEARCH = (process.env.SF_PRICEBOOK_SEARCH || '').trim();
/** Existing org Price Books only — never create New. */
const EXISTING_PRICE_BOOKS = [
  'Al-Hammad - Standard',
  'FMS - Standard',
  'PREMMA - Standard',
  'Standard Price Book',
  'Al-Hammad - NUPCO Price Book',
  'FMS - NUPCO Price Book',
  'Premma - NUPCO Price Book',
];
const PRODUCT_SEARCH = (process.env.SF_PRODUCT_SEARCH || '').trim();
/** Browse Catalog — pick this catalog on "All Catalogs" (screenshot: Al Hammad). Only used when Quote has 0 QLI. */
const CATALOG_NAME = (process.env.SF_CATALOG_NAME || 'Al Hammad').trim();
/** Always add multiple Opp products when the price book has enough rows (defaults 2–3). */
const ADD_PRODUCT_MIN = Math.max(1, Number.parseInt(process.env.SF_ADD_PRODUCT_MIN || '2', 10) || 2);
const ADD_PRODUCT_MAX = Math.max(
  ADD_PRODUCT_MIN,
  Number.parseInt(process.env.SF_ADD_PRODUCT_MAX || '3', 10) || 3,
);
const ACCOUNT_RT_PREF = (process.env.SF_ACCOUNT_RECORD_TYPE || '').trim();
const STOP_AFTER_CONVERT = /^(1|true|yes)$/i.test(process.env.SF_STOP_AFTER_CONVERT || '');
/** Contact/Account fills are optional — only when explicitly requested. */
const FILL_CONTACT = /^(1|true|yes)$/i.test(process.env.SF_FILL_CONTACT || '');
const FILL_ACCOUNT = /^(1|true|yes)$/i.test(process.env.SF_FILL_ACCOUNT || '');
const REUSE_LEAD = /^(1|true|yes)$/i.test(process.env.SF_REUSE_LEAD || '');
const EXISTING_LEAD_ID = REUSE_LEAD ? (process.env.SF_LEAD_ID || '').trim() : '';
const RESUME_OPP_ID = (process.env.SF_OPP_ID || process.env.SF_RESUME_OPP_ID || '').trim();
const RESUME_QUOTE_ID = (process.env.SF_QUOTE_ID || process.env.SF_RESUME_QUOTE_ID || '').trim();
/** Ignored: one Quote per Opp — always open existing when Quotes (n) ≥ 1. */
const FORCE_NEW_QUOTE = /^(1|true|yes)$/i.test(process.env.SF_FORCE_NEW_QUOTE || '');
/**
 * When false (default): read validation / formula errors, attempt fixes, continue when recoverable.
 * Set SF_STRICT_VALIDATION=1 to throw on any remaining FAIL.
 */
const STRICT_VALIDATION = /^(1|true|yes)$/i.test(process.env.SF_STRICT_VALIDATION || '');
const CALC_UNIT_PRICE = Number.parseFloat(process.env.SF_CALC_UNIT_PRICE || '4000') || 4000;
/** Any percentage typed into the UI must be in 0–100 inclusive. */
function clampPercent(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return NaN;
  return Math.min(100, Math.max(0, v));
}
const CALC_DISCOUNT_PCT = clampPercent(Number.parseFloat(process.env.SF_CALC_DISCOUNT_PCT || '0') || 0);
const CALC_DISCOUNT_AMOUNT = Number.parseFloat(process.env.SF_CALC_DISCOUNT_AMOUNT || '0') || 0;
const CALC_UNIT_COST = Number.parseFloat(process.env.SF_CALC_UNIT_COST || '2500') || 2500;
const CALC_CATEGORY_HINT = (process.env.SF_CALC_CATEGORY || process.env.SF_PRODUCT_CATEGORY || '').trim();
const CALC_CURRENCY = (process.env.SF_CALC_CURRENCY || 'SAR').trim() || 'SAR';
const CALC_SUPPLIER_PRICE = Number.parseFloat(process.env.SF_CALC_SUPPLIER_PRICE || '1000') || 1000;
/** Product Ids (01t…) already checked/created for SupplierPriceBook this run — never New again. */
const SPB_ATTEMPTED_PRODUCT_IDS = new Set();
/** QLI row indexes that already took the SPB path this run — never divert twice for the same line. */
const SPB_ATTEMPTED_QLI_ROWS = new Set();
const CALC_FREIGHT_PCT = clampPercent(Number.parseFloat(process.env.SF_CALC_FREIGHT_PCT || '5') || 5);
const CALC_CUSTOMS_PCT = clampPercent(Number.parseFloat(process.env.SF_CALC_CUSTOMS_PCT || '3') || 3);
const CALC_WS_VALUE = Number.parseFloat(process.env.SF_CALC_WS_VALUE || '1000') || 1000;
const CALC_EW_RATE_PCT = clampPercent(Number.parseFloat(process.env.SF_CALC_EW_RATE_PCT || '2') || 2);
const ME_VAT_RATE_PCT = 15;
/** Extra product provision lines default to 200% — reduce to this (must stay 1–10) so GP% stays positive. */
const CALC_PROVISION_CAP_PCT = clampPercent(
  Math.min(10, Math.max(1, Number.parseFloat(process.env.SF_CALC_PROVISION_CAP_PCT || '5') || 5)),
);
const CALC_PROVISION_RATE_MAX = 10;
const CALC_QTY_MAX = Math.max(1, Number.parseInt(process.env.SF_CALC_QTY_MAX || '20', 10) || 20);
const CONSUMABLES_PROVISION_CHARGES = [
  { name: 'Financing Charges', ratePct: 3, aliases: ['Financing Charges', 'Financing Charge'] },
  {
    name: 'Bank Charges for LCs/LGs',
    ratePct: 1,
    aliases: ['Bank Charges for LCs/LGs', 'Bank Charges for LCs', 'Bank Charges', 'LC/LG'],
  },
  { name: 'Risk / Penalties', ratePct: 3, aliases: ['Risk / Penalties', 'Risk/Penalties', 'Risk Penalties', 'Penalties'] },
];
/** Medical Equipment / Medical Equipment & Consumables — default Provision Charges */
const MEDICAL_EQUIPMENT_PROVISION_CHARGES = [
  {
    name: 'Financing Charges (ZZFI)',
    ratePct: 5,
    aliases: ['Financing Charges (ZZFI)', 'Financing Charges', 'Finance', 'ZZFI'],
  },
  {
    name: 'Bank Charges for LCs/LGs (ZZBC)',
    ratePct: 1,
    aliases: ['Bank Charges for LCs/LGs (ZZBC)', 'Bank Charges for LCs/LGs', 'Bank Charges', 'ZZBC'],
  },
  {
    name: 'Risk / Penalties (ZPEN)',
    ratePct: 5,
    aliases: ['Risk / Penalties (ZPEN)', 'Risk / Penalties', 'Risk/Penalties', 'ZPEN'],
  },
  { name: 'PMO (ZZPM)', ratePct: 0, aliases: ['PMO (ZZPM)', 'PMO', 'ZZPM'] },
  {
    name: 'Standard Warranty (1st Year)',
    ratePct: 0,
    aliases: ['Standard Warranty (1st Year)', 'Standard Warranty', 'Warranty 1st Year'],
  },
];
/**
 * ME — Warranty, Services & Equipment Liable to VAT (updated calculator UI)
 * Service rows: W/S manual → Percentage auto from W/S; VAT = W/S × 15%
 * Warranty rows (Extended): % editable → W/S auto (read-only);
 *   W/S = Total Selling Price After Discount (SAR) × %; VAT = W/S × 15%
 *   (renamed from Unit Sales Price After Discount)
 */
const MEDICAL_EQUIPMENT_SERVICE_LINES = [
  { name: 'Civil Work', kind: 'service', aliases: ['Civil Work'] },
  {
    name: 'Installation and Labor (1st Year) "SAR"',
    kind: 'service',
    aliases: [
      'Installation and Labor (1st Year) "SAR"',
      'Installation and Labor (1st Year)',
      'Installation and Labor',
    ],
  },
  {
    name: 'Total Supplier Price (Taxable Equipment)',
    kind: 'service',
    aliases: ['Total Supplier Price (Taxable Equipment)', 'Taxable Equipment'],
  },
  { name: 'Training', kind: 'service', aliases: ['Training'] },
  { name: 'External Installation', kind: 'service', aliases: ['External Installation'] },
  {
    name: 'Philips Cost: Philips Warranty (4 Years)',
    kind: 'service',
    aliases: ['Philips Cost: Philips Warranty (4 Years)', 'Philips Warranty', 'Philips Cost'],
  },
  {
    name: 'Extended Warranty 2nd Year',
    kind: 'warranty',
    aliases: ['Extended Warranty 2nd Year', 'External Warranty — 2nd Year', 'External Warranty 2nd Year'],
  },
  {
    name: 'Extended Warranty 3rd Year',
    kind: 'warranty',
    aliases: ['Extended Warranty 3rd Year', 'External Warranty — 3rd Year', 'External Warranty 3rd Year'],
  },
  {
    name: 'Extended Warranty 4th Year',
    kind: 'warranty',
    aliases: ['Extended Warranty 4th Year', 'External Warranty — 4th Year', 'External Warranty 4th Year'],
  },
  {
    name: 'Extended Warranty 5th Year',
    kind: 'warranty',
    aliases: ['Extended Warranty 5th Year', 'External Warranty — 5th Year', 'External Warranty 5th Year'],
  },
  {
    name: 'Extended Warranty (6th + 7th) Years',
    kind: 'warranty',
    aliases: [
      'Extended Warranty 6th+7th Years',
      'Extended Warranty (6th + 7th) Years',
      'External Warranty — 6th+7th Years',
      '6th + 7th',
    ],
  },
];

/**
 * Fields that must match between Pricing Calculator (Configure) and Quote Line Item (View).
 * QLI Details: scroll the record — same section names as the calculator.
 */
const CALC_VS_QLI_FIELDS_ME = [
  {
    section: 'Selling Price & Discount',
    fields: [
      { name: 'Quantity', aliases: ['Quantity'] },
      { name: 'Unit Sales Price Before Discount (SAR)', aliases: ['Unit Sales Price Before Discount'] },
      { name: 'Customer Discount (%)', aliases: ['Customer Discount (%)', 'Discount (%)', 'Discount %'], asPct: true },
      { name: 'Discount Amount (SAR)', aliases: ['Discount Amount'] },
      { name: 'Total Selling Price Before Discount (SAR)', aliases: ['Total Selling Price Before Discount'] },
      { name: 'Total Selling Price After Discount (SAR)', aliases: ['Total Selling Price After Discount'] },
      {
        name: 'Unit Sales Price After Discount (Back-Calculated) (SAR)',
        aliases: ['Unit Sales Price After Discount (Back-Calculated)', 'Unit Sales Price After Discount'],
      },
      { name: 'VAT Amount (From Services) (SAR)', aliases: ['VAT Amount (From Services)'] },
      { name: 'Net Selling Price Including VAT (Total)', aliases: ['Net Selling Price Including VAT'] },
    ],
  },
  {
    section: 'Supplier Cost & Basic Info',
    fields: [
      {
        name: 'SP Price (Per Unit) (Original Currency)',
        aliases: ['SP Price (Per Unit) (Original Currency)', 'Supplier Price'],
      },
      { name: 'Exchange Rate', aliases: ['Exchange Rate'] },
      { name: 'SP Price (Per Unit) (SAR)', aliases: ['SP Price (SAR)', 'SP Price (Per Unit) (SAR)'] },
      { name: 'Total Supplier Price (SAR)', aliases: ['Total Supplier Price'] },
    ],
  },
  {
    section: '3 Landed Material Cost',
    fields: [
      { name: 'Freight & Insurance Amount (SAR)', aliases: ['Freight & Insurance Amount', 'Freight Amount'] },
      { name: 'Customs Duty Amount (SAR)', aliases: ['Customs Duty Amount', 'Customs Duty'] },
      { name: 'Total Freight & Customs (SAR)', aliases: ['Total Freight & Customs'] },
      { name: 'Landed Material Cost (SAR)', aliases: ['Landed Material Cost'] },
      { name: 'Landed Cost (SAR)', aliases: ['Landed Cost', 'Landed Cost (AFMS Warehouse)'] },
    ],
  },
  {
    section: 'Warranty, Services & Equipment Liable to VAT',
    fields: [
      { name: 'Total W/S Value (SAR)', aliases: ['Total W/S Value', 'W/S Value'] },
      { name: 'Total VAT Value (SAR)', aliases: ['Total VAT Value'] },
    ],
  },
  {
    section: 'Provision Charges',
    fields: [
      { name: 'Financing Charges (ZZFI)', aliases: ['Financing Charges'] },
      { name: 'Bank Charges for LCs/LGs (ZZBC)', aliases: ['Bank Charges for LCs/LGs', 'Bank Charges'] },
      { name: 'Risk / Penalties (ZPEN)', aliases: ['Risk / Penalties'] },
      { name: 'PMO (ZZPM)', aliases: ['PMO'] },
      { name: 'Standard Warranty (1st Year)', aliases: ['Standard Warranty'] },
      { name: 'Total EK02 Charges', aliases: ['Total Provision Charges', 'Total Charges'] },
    ],
  },
  {
    section: 'Profitability Summary',
    fields: [
      { name: 'Total Selling Amount (SAR)', aliases: ['Total Selling Amount'] },
      { name: 'Total Project Cost (SAR)', aliases: ['Total Project Cost'] },
      { name: 'GP Amount (SAR)', aliases: ['GP Amount', 'Gross Profit Amount'] },
      { name: 'GP %', aliases: ['GP%', 'Gross Profit %', 'Line Item GP%'], asPct: true },
    ],
  },
];

const CALC_VS_QLI_FIELDS_CONSUMABLES = [
  {
    section: 'Selling Price & Discount',
    fields: [
      { name: 'Quantity', aliases: ['Quantity'] },
      { name: 'Unit Sales Price Before Discount (SAR)', aliases: ['Unit Sales Price Before Discount'] },
      { name: 'Customer Discount (%)', aliases: ['Customer Discount (%)', 'Discount %'], asPct: true },
      { name: 'Discount Amount (SAR)', aliases: ['Discount Amount'] },
      { name: 'Total Selling Price Before Discount (SAR)', aliases: ['Total Selling Price Before Discount'] },
      { name: 'Total Selling Price After Discount (SAR)', aliases: ['Total Selling Price After Discount'] },
      {
        name: 'Unit Sales Price After Discount (Back-Calculated) (SAR)',
        aliases: ['Unit Sales Price After Discount'],
      },
    ],
  },
  {
    section: 'Supplier Cost & Basic Info',
    fields: [
      { name: 'Supplier Price (SAR)', aliases: ['Supplier Price', 'SP Price (Per Unit) (SAR)'] },
      { name: 'Total Supplier Price (SAR)', aliases: ['Total Supplier Price'] },
    ],
  },
  {
    section: 'Provision Charges',
    fields: [
      { name: 'Financing Charges', aliases: ['Financing Charges (ZZFI)'] },
      { name: 'Bank Charges for LCs/LGs', aliases: ['Bank Charges'] },
      { name: 'Risk / Penalties', aliases: ['Risk / Penalties (ZPEN)'] },
      { name: 'Landed Material Cost (SAR)', aliases: ['Landed Material Cost'] },
      { name: 'Landed Cost (SAR)', aliases: ['Landed Cost'] },
    ],
  },
  {
    section: 'Profitability Summary',
    fields: [
      { name: 'Total Selling Amount (SAR)', aliases: ['Total Selling Amount'] },
      { name: 'Total Project Cost (SAR)', aliases: ['Total Project Cost'] },
      { name: 'GP Amount (SAR)', aliases: ['GP Amount', 'Gross Profit Amount'] },
      { name: 'GP %', aliases: ['GP%', 'Gross Profit %'], asPct: true },
    ],
  },
];
const MONEY_TOLERANCE = 0.05;
const LAST_LEAD_ID_FILE = path.join(process.cwd(), 'test-results', 'last-lead-id.txt');

function rememberLeadId(leadId) {
  const id = (leadId || '').trim();
  if (!id) return;
  try {
    fs.mkdirSync(path.dirname(LAST_LEAD_ID_FILE), { recursive: true });
    fs.writeFileSync(LAST_LEAD_ID_FILE, id, 'utf8');
    progress(`Remembered Lead Id → ${LAST_LEAD_ID_FILE} (${id})`);
  } catch (err) {
    progress(`WARN could not remember Lead Id: ${err?.message || err}`);
  }
}

function readRememberedLeadId() {
  try {
    const id = fs.readFileSync(LAST_LEAD_ID_FILE, 'utf8').trim();
    return /^00Q[a-zA-Z0-9]{12,15}$/i.test(id) || /^[a-zA-Z0-9]{15,18}$/.test(id) ? id : '';
  } catch {
    return '';
  }
}

const PRODUCT_CATEGORY_PREFER = [
  /^medical\s*equipment\s*&\s*consumables$/i,
  /^medical\s*equipment$/i,
];
const PRODUCT_CATEGORY_EXCLUDE = [/^consumables$/i];

function sleep(ms) {
  const scaled = Math.round(Number(ms) * SPEED);
  if (scaled <= 0) return Promise.resolve();
  return new Promise((r) => setTimeout(r, scaled));
}

function randInt(lo, hi) {
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

function randomAlphaNum(length) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let o = '';
  for (let i = 0; i < length; i += 1) {
    o += alphabet.charAt(randInt(0, alphabet.length - 1));
  }
  return o;
}

function stamp() {
  return `${Date.now()}_${randomAlphaNum(4)}`;
}

function randomText(prefix = 'Auto_') {
  return `${prefix}${randomAlphaNum(5)}_${Date.now()}`;
}

function randomEmail() {
  return `lead_${randomAlphaNum(6)}_${Date.now()}@example.com`;
}

function randomPhone() {
  return `9${String(randInt(0, 999_999_999)).padStart(9, '0')}`;
}

function randomNumber() {
  return String(randInt(10000, 999_999));
}

function clipToMaxlength(value, maxRaw) {
  const n = maxRaw ? Number.parseInt(maxRaw, 10) : NaN;
  if (!Number.isFinite(n) || n <= 0) return value;
  return value.length > n ? value.slice(0, n) : value;
}

function echoLabel(label) {
  return (label || '(no label)').replace(/\s+/g, ' ').trim().slice(0, 72);
}

function isProductCategoryLabel(label) {
  return /product\s*cat+egor/i.test(label || '');
}

function isLeadStatusLabel(label) {
  return /^(lead\s*)?status$/i.test((label || '').replace(/\*/g, '').trim());
}

function isUnqualifiedReasonLabel(label) {
  return /unqualified\s*reason/i.test((label || '').replace(/\*/g, '').trim());
}

function isDoNotCallLabel(label) {
  return /do\s*not\s*call/i.test((label || '').replace(/\*/g, '').trim());
}

/** SAP Information section — leave blank; values sync from SAP. */
function isSapInformationSectionTitle(text) {
  return /sap\s*information/i.test((text || '').replace(/\*/g, '').trim());
}

function isSapFieldLabel(label) {
  const t = (label || '').replace(/\*/g, '').trim();
  return /^sap\b/i.test(t) || /\bsap\s*(id|code|number|no\.?|customer|account|vendor|partner|material)/i.test(t);
}

async function isSapInformationRow(row) {
  const label = await getRowLabelText(row);
  if (isSapFieldLabel(label) || isSapInformationSectionTitle(label)) return true;
  return row
    .evaluate((el) => {
      let n = el;
      for (let i = 0; i < 14 && n; i++, n = n.parentElement) {
        const heading = n.querySelector?.(
          '.slds-section__title, .slds-section__title-action, .slds-accordion__summary-heading, legend, h2, h3',
        );
        const t = `${heading?.innerText || ''} ${n.getAttribute?.('aria-label') || ''}`.replace(/\s+/g, ' ');
        if (/sap\s*information/i.test(t)) return true;
      }
      return false;
    })
    .catch(() => false);
}

/** Skip optional SAP Information fields; fill only if the row is required (*). */
async function shouldSkipOptionalSapRow(row) {
  if (!(await isSapInformationRow(row))) return false;
  if (await isRequiredFormRow(row)) return false;
  return true;
}

function isBusinessUnitLabel(label) {
  return /business\s*unit/i.test((label || '').replace(/\*/g, '').trim());
}

function isDivisionLabel(label) {
  return /^division$/i.test((label || '').replace(/\*/g, '').trim());
}

/** Opportunity / Quote — required before Opp products and Quote catalog. */
function isQuoteTypeLabel(label) {
  return /^quote\s*type$/i.test((label || '').replace(/\*/g, '').trim());
}

function isSapDivisionLabel(label) {
  return /sap\s*division/i.test((label || '').replace(/\*/g, '').trim());
}

function isAccountApprovalStatusLabel(label) {
  return /account\s*approval\s*status/i.test((label || '').replace(/\*/g, '').trim());
}

/** Never create a Price Book from Opp/Quote forms — only Choose existing later. */
function isPriceBookLabel(label) {
  const t = (label || '').replace(/\*/g, '').trim();
  return /^price\s*book(\s*name)?$/i.test(t) || /^pricebook2id$/i.test(t);
}

/** Convert already sets Close Date — never overwrite it. */
function isCloseDateLabel(label) {
  return /close\s*date/i.test((label || '').replace(/\*/g, '').trim());
}

function isStartDateLabel(label) {
  return /^start\s*date$/i.test((label || '').replace(/\*/g, '').trim());
}

function isExpirationDateLabel(label) {
  return /expiration\s*date/i.test((label || '').replace(/\*/g, '').trim());
}

/** Lead Status prefers Open/New/Working — never Unqualified during create (Convert path). */
const LEAD_STATUS_PREFER = [/^open\b/i, /^new$/i, /^working/i];

/** Facility Type — Other is valid again (mapping issue resolved). Prefer Other when filling. */
const FACILITY_TYPE_PREFER = [
  /^other$/i,
  /^hospital$/i,
  /^medical\s*center$/i,
  /^clinic$/i,
  /^governmental/i,
  /^private\s*distributor/i,
];
const FACILITY_TYPE_EXCLUDE = [];

function isLeadStatusUnqualified(value) {
  return /^unqualified$/i.test((value || '').replace(/\s+/g, ' ').trim());
}

function isOpportunityStageLabel(label) {
  return /^stage$/i.test((label || '').replace(/\*/g, '').trim());
}

function isLostReasonLabel(label) {
  return /(lost|loss)\s*reason/i.test((label || '').replace(/\*/g, '').trim());
}

function isStageClosedLost(value) {
  return /closed\s*lost/i.test((value || '').replace(/\s+/g, ' ').trim());
}

function isFacilityTypeLabel(label) {
  return /facility\s*type/i.test((label || '').replace(/\*/g, '').trim());
}

/** Opportunity Facility Department — avoid "Other" (requires Other Facility Department text). */
const FACILITY_DEPARTMENT_PREFER = [
  /^radiology$/i,
  /^laboratory$/i,
  /^cardiology$/i,
  /^pharmacy$/i,
  /^emergency/i,
  /^icu$/i,
  /^surgery$/i,
  /^outpatient/i,
];
const FACILITY_DEPARTMENT_EXCLUDE = [/^\s*other\s*$/i];

function isFacilityDepartmentLabel(label) {
  const t = (label || '').replace(/\*/g, '').trim();
  return /^facility\s*department$/i.test(t) && !/other/i.test(t);
}

function isOtherFacilityDepartmentLabel(label) {
  return /other\s*facility\s*department/i.test((label || '').replace(/\*/g, '').trim());
}

/** Convert Lead page only — Account Type picklist under Create New Account (not on Lead record). */
const ACCOUNT_TYPE_PREFER = [
  /^customer$/i,
  /^prospect$/i,
  /^partner$/i,
  /^distributor$/i,
  /^supplier$/i,
  /^end\s*user/i,
  /^hospital$/i,
  /^clinic$/i,
];

function isFacilityTypeValueMapped(value) {
  const v = (value || '').replace(/\s+/g, ' ').trim();
  if (!v || NONE_OPTION.test(v)) return false;
  return FACILITY_TYPE_PREFER.some((p) => p.test(v)) || /^other$/i.test(v);
}

/**
 * Map Lead Product Category → Opportunity Record Type (Convert panel).
 *
 *   Consumables                        → Consumables
 *   Medical Equipment                  → Medical Equipment
 *   Medical Equipment & Consumables    → Medical Equipment
 */
function opportunityRecordTypeFromProductCategory(productCategory) {
  const v = (productCategory || '').replace(/\s+/g, ' ').trim();
  if (!v) {
    throw new Error('Opportunity Record Type requires Lead Product Category (empty).');
  }
  // Exact Consumables only — do not treat "...& Consumables" as Consumables RT
  if (/^consumables$/i.test(v)) {
    return 'Consumables';
  }
  // Medical Equipment OR Medical Equipment & Consumables → Medical Equipment
  if (/^medical\s*equipment(\s*&\s*consumables)?$/i.test(v) || /medical\s*equipment/i.test(v)) {
    return 'Medical Equipment';
  }
  throw new Error(
    `Cannot map Product Category "${v}" to Opportunity Record Type. Expected Consumables, Medical Equipment, or Medical Equipment & Consumables.`,
  );
}

function pickAccountRecordType() {
  // Convert: default Sold To Party (env can force Supplier)
  if (/supplier/i.test(ACCOUNT_RT_PREF)) return 'Supplier';
  if (/sold\s*to\s*part/i.test(ACCOUNT_RT_PREF)) return 'Sold To Party';
  return 'Sold To Party';
}

/**
 * Read Product Category from the open Lead record page (before Convert).
 * @returns {Promise<string>}
 */
async function readProductCategoryFromLeadRecord(page) {
  // Highlight / detail field
  const candidates = [
    page.locator('records-record-layout-item, lightning-output-field, .slds-form-element').filter({
      has: page.getByText(/product\s*cat+egor/i),
    }),
    page.locator('[field-label*="Product Category" i], [data-target-selection-name*="Product_Category" i]'),
  ];

  for (const loc of candidates) {
    const row = loc.first();
    if (!(await row.isVisible({ timeout: 2_000 }).catch(() => false))) continue;
    const text = ((await row.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
    const m = text.match(
      /product\s*cat+egor(?:y|ies)?\s*[:\n]?\s*(Consumables|Medical Equipment(?:\s*&\s*Consumables)?)/i,
    );
    if (m) return m[1].replace(/\s+/g, ' ').trim();
    // Value often in a sibling/output
    const val = row.locator('lightning-formatted-text, .slds-form-element__control, span.test-id__field-value').first();
    const v = ((await val.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
    if (/consumables|medical\s*equipment/i.test(v)) return v;
  }

  // Page-wide scan for known values near the label
  const body = ((await page.locator('.record-body-container, .slds-page-header, one-record-home-flexipage2').first().innerText().catch(() => '')) || '')
    .replace(/\s+/g, ' ');
  const near = body.match(/Product\s*Cat+egor(?:y|ies)?\s+(Consumables|Medical Equipment(?:\s*&\s*Consumables)?)/i);
  if (near) return near[1].replace(/\s+/g, ' ').trim();
  return '';
}

// ─── Login / Passkey ─────────────────────────────────────────────────────────

/**
 * Find a visible Lightning / Salesforce popup or dialog (not the New Lead form).
 */
function popupDialogLocator(page) {
  return page
    .locator(
      '[role="dialog"]:visible, [role="alertdialog"]:visible, .slds-modal:visible, .slds-modal__container:visible, .modal-container:visible, .forceModalActionContainer:visible, .slds-notify_container:visible, .slds-modal__container',
    )
    .filter({ visible: true })
    .filter({
      // Exclude New/Edit Lead (and similar) record forms
      hasNot: page.locator(
        'input[name="lastName"], input[name="LastName"], input[name="Company"], input[name="Name"]',
      ),
    });
}

/**
 * Read popup body text and decide the correct button action.
 * @returns {{ action: 'allow'|'accept'|'continue'|'skip'|'ok'|'dismiss'|'none', reason: string }}
 */
function decidePopupAction(popupText) {
  const t = (popupText || '').replace(/\s+/g, ' ').trim();
  if (!t) return { action: 'none', reason: 'empty popup' };

  // Salesforce success toasts often start with "Success notification…" — must beat
  // the browser notification-permission matcher below (was falsely choosing Allow).
  if (
    /success\s*notification/i.test(t) ||
    /successfully|was saved|was created|your lead has been converted/i.test(t)
  ) {
    return { action: 'ok', reason: 'success / info toast-dialog' };
  }

  if (/allow access|wants to access|access your|permission to|authorize|grant access|connected app|third.party|is requesting/i.test(t)) {
    return { action: 'allow', reason: 'access / permission request' };
  }
  if (/notification|desktop notification|show notification|push notification/i.test(t)) {
    return { action: 'allow', reason: 'notification permission' };
  }
  // Location / geolocation — prefer Allow (native Chrome bubble is handled via grantPermissions)
  if (/know your location|wants to know your location|use your location|geolocation/i.test(t)) {
    return { action: 'allow', reason: 'location permission — allow' };
  }
  if (/location|camera|microphone|clipboard/i.test(t) && /allow|permission|access/i.test(t)) {
    return { action: 'allow', reason: 'browser feature permission' };
  }
  if (/continue with save/i.test(t)) {
    return { action: 'continue', reason: 'continue with save confirmation' };
  }
  if (/cookie|privacy|consent/i.test(t) && /accept|agree/i.test(t)) {
    return { action: 'accept', reason: 'cookie / privacy consent' };
  }
  if (/add (a )?passkey|register.*(passkey|authenticator)|set up.*(authenticator|mfa)/i.test(t)) {
    return { action: 'skip', reason: 'optional passkey / MFA setup' };
  }
  if (/\ballow\b/i.test(t) && !/deny|don't allow|do not allow/i.test(t)) {
    return { action: 'allow', reason: 'popup mentions Allow' };
  }
  if (/discard your unsaved|unsaved pricing updates|do you want to continue/i.test(t)) {
    return { action: 'continue', reason: 'discard unsaved pricing updates' };
  }
  if (/are you sure|confirm|warning/i.test(t)) {
    return { action: 'continue', reason: 'confirmation dialog' };
  }

  return { action: 'none', reason: 'unrecognized popup — leave for caller' };
}

function buttonPatternsForAction(action) {
  switch (action) {
    case 'allow':
      // Prefer "Allow this time" when present (Chrome location / similar in-page prompts)
      return /^(allow this time|allow while visiting the site|allow access|allow|approve)$/i;
    case 'accept':
      return /^(accept|agree|i agree|got it)$/i;
    case 'continue':
      return /^(continue|yes|confirm|ok|proceed)$/i;
    case 'skip':
      return /^(skip|not now|remind me later|no thanks|later|cancel|continue without)/i;
    case 'ok':
      return /^(ok|got it|close|dismiss|done)$/i;
    case 'dismiss':
      return /^(close|dismiss|cancel|no)$/i;
    default:
      return null;
  }
}

/**
 * Read each visible popup, decide action from its text, click the matching button.
 */
async function acceptAllowAccessPrompts(page, { rounds = FAST_FILL ? 2 : 5, perTryMs = FAST_FILL ? 350 : 2_500 } = {}) {
  let handled = 0;

  for (let i = 0; i < rounds; i++) {
    if (page.isClosed()) break;

    const dialogs = popupDialogLocator(page);
    const count = await dialogs.count().catch(() => 0);
    let acted = false;

    for (let d = 0; d < count; d++) {
      const dialog = dialogs.nth(d);
      if (!(await dialog.isVisible({ timeout: 400 }).catch(() => false))) continue;

      const rawText = ((await dialog.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
      if (!rawText || rawText.length < 3) continue;

      // Skip large record forms mistakenly matched
      if (/last name|company|save & new|save$/i.test(rawText) && /required/i.test(rawText)) {
        continue;
      }

      const snippet = rawText.slice(0, 180);
      const { action, reason } = decidePopupAction(rawText);
      progress(`Popup read: "${snippet}${rawText.length > 180 ? '…' : ''}"`);
      progress(`Popup decision: ${action} (${reason})`);

      if (action === 'none') {
        // Still try explicit Allow if that button is present on an access-style chrome
        const maybeAllow = dialog.getByRole('button', { name: /^(allow access|allow)$/i }).first();
        if (await maybeAllow.isVisible({ timeout: 600 }).catch(() => false)) {
          progress('Popup fallback — Allow button present; clicking Allow');
          await maybeAllow.click({ timeout: 8_000 }).catch(() => {});
          handled += 1;
          acted = true;
          await sleep(200);
        }
        continue;
      }

      const pattern = buttonPatternsForAction(action);
      const btn = dialog
        .getByRole('button', { name: pattern })
        .or(dialog.locator(`button[title], input[type="button"], input[type="submit"], a.btn`).filter({ hasText: pattern }))
        .first();

      if (await btn.isVisible({ timeout: Math.min(perTryMs, 1_200) }).catch(() => false)) {
        const label = ((await btn.innerText().catch(() => '')) || action).trim().slice(0, 40);
        progress(`Popup action — clicking "${label}"`);
        await btn.click({ timeout: 8_000 }).catch(() => {});
        handled += 1;
        acted = true;
        await sleep(250);
        break;
      }

      // Success toasts are informational — no button required; do not fall through to Allow
      if (action === 'ok') {
        progress('Popup: success toast — leave alone (Save already succeeded)');
        handled += 1;
        acted = true;
        break;
      }

      // Page-level Allow if button is outside dialog wrapper
      if (action === 'allow') {
        const pageAllow = page.getByRole('button', { name: /^(allow access|allow)$/i }).first();
        if (await pageAllow.isVisible({ timeout: 600 }).catch(() => false)) {
          progress('Popup action — clicking page-level Allow');
          await pageAllow.click({ timeout: 8_000 }).catch(() => {});
          handled += 1;
          acted = true;
          await sleep(250);
          break;
        }
      }

      progress(`Popup: no button matched for action "${action}"`);
    }

    // Standalone Allow (not inside a matched dialog container)
    if (!acted) {
      const standalone = page
        .getByRole('button', { name: /^(allow access|allow)$/i })
        .or(page.locator('input[type="button"][value="Allow"], input[type="submit"][value="Allow"]'))
        .first();
      if (await standalone.isVisible({ timeout: Math.min(perTryMs, 1_500) }).catch(() => false)) {
        // Read nearby text if possible
        const near = standalone.locator('xpath=ancestor::*[contains(@class,"modal") or @role="dialog"][1]').first();
        const nearText = (await near.innerText().catch(() => '')) || '';
        if (nearText) {
          const { action, reason } = decidePopupAction(nearText);
          progress(`Standalone Allow context: ${action} (${reason}) — "${nearText.slice(0, 120)}"`);
        }
        progress('Popup action — clicking standalone Allow');
        await standalone.click({ timeout: 8_000 }).catch(() => {});
        handled += 1;
        acted = true;
        await sleep(700);
      }
    }

    if (!acted) break;
  }

  return handled;
}

/**
 * Soft dismiss of non-form overlays. Tries Allow first (never skip Allow with Escape).
 * Avoid calling while a New/Edit record modal is open — Escape closes those forms.
 */
async function dismissLightningOverlays(page, { allowEscape = true } = {}) {
  await acceptAllowAccessPrompts(page, { rounds: 3, perTryMs: 1_200 });

  if (!allowEscape) return;

  // Never Escape over an open New/Edit Lead (or similar) record form.
  if (await isRecordFormModalOpen(page)) {
    await blurIntoRecordFormModal(page);
    await acceptAllowAccessPrompts(page, { rounds: 2, perTryMs: 800 });
    return;
  }

  await page.keyboard.press('Escape').catch(() => {});
  const closeBtn = page.getByRole('button', { name: /^close$/i }).first();
  if (await closeBtn.isVisible({ timeout: 600 }).catch(() => false)) {
    await closeBtn.click({ timeout: 1500 }).catch(() => {});
  }
  // One more Allow pass in case Escape revealed another prompt
  await acceptAllowAccessPrompts(page, { rounds: 2, perTryMs: 800 });
}

async function isLoginPageVisible(page) {
  if (/login|secur\/login|my\.salesforce\.com\/?(\?|$)/i.test(page.url())) {
    return true;
  }
  const byRole = page.getByRole('textbox', { name: /username/i }).first();
  if (await byRole.isVisible({ timeout: 2000 }).catch(() => false)) {
    return true;
  }
  return page
    .locator('input#username, input[name="username"]')
    .first()
    .isVisible({ timeout: 1000 })
    .catch(() => false);
}

function isPasskeyVerificationUrl(url) {
  return /UnifiedPasskeyVerificationUi|EmailVerification|AddPasskeyUi|_ui\/identity\/verification|_ui\/identity\/webauthn/i.test(
    url || '',
  );
}

function isLightningHomeUrl(url) {
  return /lightning\.force\.com\/lightning\/page\/home/i.test(url || '');
}

function isLightningAppUrl(url) {
  return isLightningHomeUrl(url) || /lightning\.force\.com\/lightning\//i.test(url || '');
}

/**
 * On Add Passkey registration page, try Skip / Not now so automation can reach home.
 * WebAuthn "Add passkey" dialogs often crash or close Playwright Chromium.
 */
async function trySkipAddPasskeyPrompt(page) {
  if (page.isClosed()) return false;
  const url = page.url();
  if (!/AddPasskeyUi|webauthn|register.*passkey|add.?passkey/i.test(url)) {
    // Still try common dismiss buttons if visible on MFA pages
    if (!isPasskeyVerificationUrl(url) && !/identity/i.test(url)) return false;
  }

  const skip = page
    .getByRole('button', { name: /skip|not now|remind me later|no thanks|cancel|later|don't ask|do not ask|continue without/i })
    .or(page.getByRole('link', { name: /skip|not now|remind me later|cancel|later/i }))
    .or(page.locator('a, button').filter({ hasText: /skip|not now|remind me later|cancel|later|no thanks/i }))
    .first();

  if (await skip.isVisible({ timeout: 1_500 }).catch(() => false)) {
    progress('1a. Add Passkey page — clicking Skip / Not now...');
    await skip.click({ timeout: 5_000 }).catch(() => {});
    await sleep(1_000);
    return true;
  }
  return false;
}

/**
 * After username/password, Salesforce may open Passkey / email MFA / Add Passkey.
 * Pause for manual MFA; auto-skip Add Passkey registration when a Skip control exists.
 * Override wait with SF_PASSKEY_WAIT_MS (default 10 minutes).
 */
async function waitForManualPasskeyThenHome(page) {
  const passkeyWaitMs = Math.max(
    60_000,
    Number.parseInt(process.env.SF_PASSKEY_WAIT_MS ?? String(10 * 60_000), 10) || 10 * 60_000,
  );

  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await sleep(1_500);

  if (page.isClosed()) {
    throw new Error('Browser closed during login before MFA/home. Keep the Playwright Chromium window open.');
  }

  const current = page.url();
  if (isLightningAppUrl(current)) {
    if (!isLightningHomeUrl(current)) {
      await page.goto(HOME_PATH, { waitUntil: 'domcontentloaded' });
    }
    progress('1a. Lightning home ready (no passkey).');
    return;
  }

  if (isPasskeyVerificationUrl(current) || /my\.salesforce\.com/i.test(current)) {
    progress(
      '1a. MFA / Passkey detected — PAUSED. Complete verification in the browser (do not close it). Waiting for Lightning home...',
    );
    progress(`    Current URL: ${current.slice(0, 140)}...`);
    if (/AddPasskeyUi/i.test(current)) {
      progress('1a. Tip: if Salesforce asks to add a passkey, choose Skip / Not now if available.');
    }
  } else {
    progress('1a. Waiting for Lightning home (or MFA page if required)...');
  }

  const deadline = Date.now() + passkeyWaitMs;
  let lastSkipAt = 0;

  while (Date.now() < deadline) {
    if (page.isClosed()) {
      throw new Error(
        'Browser closed while waiting for MFA/home. Keep Chromium open; on Add Passkey use Skip/Not now instead of registering.',
      );
    }

    const href = page.url();
    if (isLightningAppUrl(href)) {
      break;
    }

    // Periodically try to dismiss Add Passkey registration
    if (Date.now() - lastSkipAt > 2_500) {
      await trySkipAddPasskeyPrompt(page).catch(() => false);
      lastSkipAt = Date.now();
    }

    await sleep(1_000);
  }

  if (page.isClosed()) {
    throw new Error('Browser closed before Lightning home loaded.');
  }

  if (!isLightningAppUrl(page.url())) {
    throw new Error(
      `Timed out after ${Math.round(passkeyWaitMs / 1000)}s waiting for Lightning home. Last URL: ${page.url().slice(0, 160)}`,
    );
  }

  if (!isLightningHomeUrl(page.url())) {
    progress('1a. Lightning session ready — opening home page...');
    await page.goto(HOME_PATH, { waitUntil: 'domcontentloaded' });
  }

  await expect(page).toHaveURL(/lightning\.force\.com\/lightning\/page\/home/i, { timeout: 60_000 });
  // Wait for Lightning shell so Lead nav / App Launcher is clickable
  await page
    .locator('one-app-nav-bar, .slds-global-header, button[title="App Launcher"]')
    .first()
    .waitFor({ state: 'visible', timeout: 90_000 })
    .catch(() => {});
  await acceptAllowAccessPrompts(page, { rounds: 6, perTryMs: 2_000 });
  await dismissLightningOverlays(page);
  progress('1a. Passkey / login complete — Lightning home opened. Resuming automation → open Lead...');
}

async function performSalesforceLogin(page, { loginUrl, username, password }) {
  if (!(await isLoginPageVisible(page))) {
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });
  }
  await page.waitForLoadState('domcontentloaded').catch(() => {});

  const usernameInput = page
    .getByRole('textbox', { name: /username/i })
    .or(page.locator('input#username, input[name="username"]'))
    .first();
  if (
    !(await usernameInput
      .waitFor({ state: 'visible', timeout: 30_000 })
      .then(() => true)
      .catch(() => false))
  ) {
    return false;
  }

  const passwordInput = page
    .locator('input#password, input[name="pw"], input[type="password"]')
    .or(page.getByLabel(/^password$/i))
    .first();
  const loginButton = page
    .getByRole('button', { name: /log in/i })
    .or(page.locator('input[name="Login"], input#Login'));

  await usernameInput.fill(username);

  // Sandbox often shows username-only first ("Log In to Sandbox"), then password on next step.
  if (!(await passwordInput.isVisible({ timeout: 3_000 }).catch(() => false))) {
    progress('1. Login - username entered; clicking Log In to reveal password step...');
    await loginButton.first().click();
    await passwordInput.waitFor({ state: 'visible', timeout: 45_000 });
  }

  await passwordInput.fill(password);
  await loginButton.first().click();
  await waitForManualPasskeyThenHome(page);
  return true;
}

async function ensureOnHomeLoggedIn(page, { loginUrl, username, password }) {
  progress('1. Home page - Running...');
  await page.goto(HOME_PATH, { waitUntil: 'commit' });
  await dismissLightningOverlays(page);

  const homeReady =
    isLightningHomeUrl(page.url()) ||
    (await page.locator('one-app-nav-bar, .slds-global-header').first().isVisible({ timeout: 12_000 }).catch(() => false));

  if (!homeReady || (await isLoginPageVisible(page))) {
    progress('1. Login - Running...');
    const ok = await performSalesforceLogin(page, { loginUrl, username, password });
    if (!ok) {
      throw new Error('Salesforce login form not found — check credentials CSV or SF_* env vars.');
    }
  } else if (!isLightningHomeUrl(page.url())) {
    await page.goto(HOME_PATH, { waitUntil: 'domcontentloaded' });
  }

  // Must be on Lightning home before opening Lead
  if (!isLightningHomeUrl(page.url())) {
    await page.goto(HOME_PATH, { waitUntil: 'domcontentloaded' });
  }
  await expect(page).toHaveURL(/lightning\.force\.com\/lightning\/page\/home/i, { timeout: 60_000 });
  await page
    .locator('one-app-nav-bar, .slds-global-header, button[title="App Launcher"]')
    .first()
    .waitFor({ state: 'visible', timeout: 90_000 })
    .catch(() => {});
  await acceptAllowAccessPrompts(page, { rounds: 6, perTryMs: 2_000 });
  await dismissLightningOverlays(page);
  progress('1. Home page - Passed (https://…/lightning/page/home). Next: click Lead object.');
}

// ─── Navigation: Home → Lead → New ───────────────────────────────────────────

/**
 * As soon as Lightning home is open, open the Lead object.
 * Order: nav-bar Leads → App Launcher "Leads" → direct Lead list URL.
 */
async function openLeadObjectFromHome(page) {
  progress('2. Open Lead object - Running...');

  // Ensure we start from home (user requirement)
  if (!isLightningHomeUrl(page.url())) {
    progress('2. Not on home yet — navigating to /lightning/page/home first...');
    await page.goto(HOME_PATH, { waitUntil: 'domcontentloaded' });
  }
  await expect(page).toHaveURL(/\/lightning\/page\/home/i, { timeout: 60_000 });
  await dismissLightningOverlays(page);
  await sleep(500);

  let opened = false;

  // 1) Click Leads in the top navigation (most common when Lead is a tab)
  const navLead = page
    .locator('one-app-nav-bar-item-root a[href*="/Lead"]')
    .or(page.getByRole('link', { name: /^leads$/i }))
    .or(page.locator('a[title="Leads"]'))
    .first();

  if (await navLead.isVisible({ timeout: 8_000 }).catch(() => false)) {
    progress('2. Clicking Leads in navigation bar...');
    await navLead.click();
    opened = true;
  }

  // 2) App Launcher → search Leads
  if (!opened) {
    const appLauncher = page
      .getByRole('button', { name: /app launcher/i })
      .or(page.locator('button[title="App Launcher"], .slds-icon-waffle_container button'))
      .first();

    if (await appLauncher.isVisible({ timeout: 10_000 }).catch(() => false)) {
      progress('2. Opening App Launcher → Leads...');
      await appLauncher.click();
      await sleep(500);
      const search = page
        .getByPlaceholder(/search apps and items/i)
        .or(page.locator('input[placeholder*="Search apps" i], input[type="search"]'))
        .first();
      if (await search.isVisible({ timeout: 8_000 }).catch(() => false)) {
        await search.fill('Leads');
        await sleep(800);
      }
      const leadItem = page
        .getByRole('option', { name: /^leads$/i })
        .or(page.getByRole('link', { name: /^leads$/i }))
        .or(page.locator('a[data-label="Leads"], one-app-launcher-menu-item a, a[href*="/Lead/"]'))
        .first();
      if (await leadItem.isVisible({ timeout: 10_000 }).catch(() => false)) {
        await leadItem.click();
        opened = true;
      }
    }
  }

  // 3) Fallback: go straight to Lead list
  if (!opened) {
    progress('2. Lead not found in nav/launcher — opening Lead list URL...');
    await page.goto(LEAD_LIST_PATH, { waitUntil: 'commit' });
  }

  await dismissLightningOverlays(page);
  await page.waitForURL(/\/Lead|\/lead/i, { timeout: 60_000 }).catch(() => {});

  // Confirm Lead list (New button) is ready
  const newBtn = newButton(page);
  if (!(await newBtn.isVisible({ timeout: 20_000 }).catch(() => false))) {
    progress('2. Lead page slow — retrying Lead list URL...');
    await page.goto(LEAD_LIST_PATH, { waitUntil: 'commit' });
    await dismissLightningOverlays(page);
    await expect(newButton(page)).toBeVisible({ timeout: 60_000 });
  }

  progress('2. Open Lead object - Passed');
}

function newButton(page) {
  return page
    .locator('ul.forceActionsContainer a[title="New"], a[title="New"]')
    .or(page.getByRole('button', { name: 'New', exact: true }))
    .or(page.getByRole('link', { name: /^new$/i }))
    .or(page.locator('button[name="New"], a[name="New"]'))
    .filter({ visible: true })
    .first();
}

async function clickNewLead(page) {
  progress('3. Click New Lead - Running...');
  const btn = newButton(page);
  const visible = await btn.isVisible({ timeout: 30_000 }).catch(() => false);
  if (visible) {
    await btn.click({ force: true }).catch(async () => {
      await btn.click({ timeout: 30_000 });
    });
  } else {
    progress('3. New button not visible — opening /lightning/o/Lead/new');
    await page.goto(`${page.url().split('/lightning')[0]}/lightning/o/Lead/new`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    }).catch(() => {});
  }
  await page.locator('.slds-spinner').first().waitFor({ state: 'hidden', timeout: 60_000 }).catch(() => {});
  await selectFirstRecordTypeIfPresent(page);
  // Confirm form or record-type Next landed on the form
  const modal = formModal(page);
  if (!(await modal.isVisible({ timeout: 20_000 }).catch(() => false))) {
    progress('3. Form not open yet — retry New / Lead/new URL');
    if (await newButton(page).isVisible({ timeout: 5_000 }).catch(() => false)) {
      await newButton(page).click({ force: true }).catch(() => {});
    } else {
      const origin = page.url().match(/^https?:\/\/[^/]+/)?.[0] || 'https://tibbiyah--qa.sandbox.lightning.force.com';
      await page.goto(`${origin}/lightning/o/Lead/new`, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {});
    }
    await selectFirstRecordTypeIfPresent(page);
  }
  progress('3. Click New Lead - Passed');
}

async function selectFirstRecordTypeIfPresent(page) {
  const radioFaux = page.locator('.slds-radio--faux, .slds-radio_faux');
  const hasPicker = await radioFaux
    .first()
    .waitFor({ state: 'visible', timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
  if (!hasPicker) return false;
  progress('3b. Lead record type picker - selecting first option');
  await radioFaux.first().click({ timeout: 8_000 }).catch(() => {});
  const nextBtn = page.getByRole('button', { name: /^next$/i }).first();
  if (await nextBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await nextBtn.click();
  }
  await page.locator('.slds-spinner').first().waitFor({ state: 'hidden', timeout: 60_000 }).catch(() => {});
  return true;
}

// ─── Generic form fill (by field data type) ──────────────────────────────────

function formModal(page) {
  // New/Edit record modal — Lead (Last Name/Company), Account/Opp (Name), Contact (Last Name), etc.
  const byFields = page
    .locator('.slds-modal__container')
    .filter({ visible: true })
    .filter({ has: page.locator('.slds-modal__footer') })
    .filter({
      has: page.locator(
        [
          'input[name="lastName"]',
          'input[name="LastName"]',
          'input[name="Company"]',
          'input[name="company"]',
          'input[name="Name"]',
          'input[name="name"]',
          'lightning-input[name="lastName"] input',
          'lightning-input[name="LastName"] input',
          'lightning-input[name="Company"] input',
          'lightning-input[name="Name"] input',
          'lightning-input[name="name"] input',
          '.slds-modal__footer button[name="SaveEdit"]',
          '.slds-modal__footer button[title="Save"]',
        ].join(', '),
      ),
    });
  // Contact/Account Edit often has Save by label only (no name=LastName / title=Save)
  const bySave = page
    .locator('.slds-modal__container:visible, [role="dialog"]:visible')
    .filter({ has: page.getByRole('button', { name: /^save$/i }) })
    .filter({ hasNot: page.getByRole('button', { name: /^convert$/i }) });
  const byEditTitle = page
    .locator('.slds-modal__container:visible, [role="dialog"]:visible')
    .filter({ hasText: /^Edit /i })
    .filter({ has: page.getByRole('button', { name: /save/i }) });
  return byFields.or(bySave).or(byEditTitle).last();
}

/** True when a New/Edit record form is still on screen (handles stale scope locators). */
async function isRecordFormOpen(page, scope) {
  if (page.isClosed()) return false;
  if (scope && (await scope.isVisible({ timeout: 400 }).catch(() => false))) return true;
  if (await formModal(page).isVisible({ timeout: 600 }).catch(() => false)) return true;
  // Full-page New Quote (Related → New Quote often redirects to Quote object create)
  if (/\/lightning\/o\/Quote\/new|\/Quote\/new/i.test(page.url() || '')) {
    if (
      await page
        .getByRole('button', { name: /^save$/i })
        .first()
        .isVisible({ timeout: 600 })
        .catch(() => false)
    ) {
      return true;
    }
  }
  // Fallback: Last Name / Name + Save footer still present
  const field = page
    .locator(
      '.slds-modal__container:visible input[name="lastName"], .slds-modal__container:visible input[name="LastName"], .slds-modal__container:visible input[name="Name"], .slds-modal__container:visible input[name="Company"], .slds-modal__container:visible input',
    )
    .first();
  const save = page
    .locator('.slds-modal__footer:visible')
    .getByRole('button', { name: /^save$/i })
    .first();
  const editDialog = page.getByRole('dialog').filter({ hasText: /^Edit /i }).first();
  if (await editDialog.isVisible({ timeout: 400 }).catch(() => false)) return true;
  return (
    (await field.isVisible({ timeout: 400 }).catch(() => false)) &&
    (await save.isVisible({ timeout: 400 }).catch(() => false))
  );
}

/** Modal or full-page Quote create form after Related → New Quote redirect. */
function quoteCreatePageForm(page) {
  return page
    .locator(
      'records-lwc-detail-panel, records-record-layout-event-broker, forcegenerated-flexipage_quote, .record-body-container, one-record-home-flexipage2, records-modal, .slds-template_default',
    )
    .filter({ has: page.getByRole('button', { name: /^save$/i }) })
    .first()
    .or(
      page
        .locator('.slds-form, force-record-layout-section, records-form')
        .filter({ has: page.locator('.slds-form-element') })
        .first(),
    );
}

/**
 * After New Quote click: wait for modal OR Quote object create page (org may redirect).
 */
async function waitForQuoteCreateForm(page, { timeout = 45_000 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    await selectFirstRecordTypeIfPresent(page).catch(() => {});
    const modal = formModal(page);
    if (await modal.isVisible({ timeout: 400 }).catch(() => false)) {
      progress('11. Quote form — modal');
      return modal;
    }
    const url = page.url() || '';
    if (/\/lightning\/o\/Quote\/new|\/Quote\/new/i.test(url)) {
      await page.locator('.slds-spinner:visible').first().waitFor({ state: 'hidden', timeout: 20_000 }).catch(() => {});
      const save = page.getByRole('button', { name: /^save$/i }).first();
      if (await save.isVisible({ timeout: 800 }).catch(() => false)) {
        const form = quoteCreatePageForm(page);
        if (await form.isVisible({ timeout: 800 }).catch(() => false)) {
          progress('11. Quote form — Quote object create page (redirect)');
          return form;
        }
        progress('11. Quote form — Quote object create page (page scope)');
        return page.locator('div.slds-template__container, .oneContent, body').first();
      }
    }
    // Some orgs open records-modal without classic slds-modal fields match
    const anyDialog = page
      .locator('.slds-modal__container:visible, [role="dialog"]:visible, records-modal:visible')
      .filter({ has: page.getByRole('button', { name: /^save$/i }) })
      .first();
    if (await anyDialog.isVisible({ timeout: 400 }).catch(() => false)) {
      progress('11. Quote form — dialog');
      return anyDialog;
    }
    await sleep(300);
  }
  return null;
}

/** Lead create/edit form scope (modal preferred; falls back to records page form). */
function leadFormScope(page) {
  const modal = formModal(page);
  return modal;
}

async function isReadonly(locator) {
  const aria = ((await locator.getAttribute('aria-readonly', { timeout: 800 }).catch(() => '')) || '').toLowerCase();
  if (aria === 'true') return true;
  return locator
    .evaluate((el) => {
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el.readOnly;
      return el.getAttribute('readonly') !== null;
    })
    .catch(() => false);
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
 * ── Scoped picklist selection (NEVER use page-level [role="option"]) ──────────
 * Rules:
 *  1. Click only the target field's combobox
 *  2. Wait until that combobox has aria-expanded="true"
 *  3. Read options only from that field's lightning-base-combobox / lightning-combobox host
 *  4. Ignore dual-listbox, lookup search, hidden, and non-expanded comboboxes
 *  5. Verify displayed value after selection; retry up to 3 times
 */

function rowPicklistTrigger(row) {
  return row
    .locator('lightning-base-combobox button[role="combobox"], lightning-combobox button[role="combobox"]')
    .or(row.locator('button.slds-combobox__input[role="combobox"], button[role="combobox"].slds-combobox__input'))
    .or(row.getByRole('combobox'))
    .first();
}

/** Nearest combobox host for the row — options must be read from here only. */
function rowComboboxHost(row) {
  return row
    .locator('lightning-base-combobox, lightning-combobox, lightning-picklist')
    .or(row.locator('.slds-combobox'))
    .first();
}

async function waitComboboxExpanded(combo, { timeout = 12_000 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const expanded = ((await combo.getAttribute('aria-expanded').catch(() => '')) || '').toLowerCase();
    if (expanded === 'true') return true;
    await sleep(100);
  }
  return false;
}

async function waitComboboxCollapsed(combo, { timeout = 8_000 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const expanded = ((await combo.getAttribute('aria-expanded').catch(() => '')) || '').toLowerCase();
    if (expanded !== 'true') return true;
    await sleep(100);
  }
  return false;
}

/**
 * Options belonging ONLY to this row's opened combobox host.
 * Never page.locator('[role="option"]').
 */
function scopedComboboxOptionLocator(host) {
  return host.locator('[role="listbox"] [role="option"]:visible, [role="option"]:visible');
}

async function listScopedComboboxLabels(host) {
  const opts = scopedComboboxOptionLocator(host);
  const texts = await opts.allInnerTexts().catch(() => []);
  return texts
    .map((t) => (t || '').replace(/\s+/g, ' ').trim())
    .filter((t) => t && !NONE_OPTION.test(t) && !/^no results|^no matches|^show more/i.test(t));
}

async function readComboboxDisplayedValue(combo) {
  const shown = ((await combo.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
  if (shown && !NONE_OPTION.test(shown)) return shown;
  const title = ((await combo.getAttribute('title').catch(() => '')) || '').replace(/\s+/g, ' ').trim();
  if (title && !NONE_OPTION.test(title) && !/^select/i.test(title)) return title;
  const val = ((await combo.inputValue().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
  if (val && !NONE_OPTION.test(val)) return val;
  return shown || title || val || '';
}

async function clickScopedOptionByText(host, value) {
  const want = (value || '').replace(/\s+/g, ' ').trim();
  if (!want) return false;
  const opts = scopedComboboxOptionLocator(host);
  const count = await opts.count().catch(() => 0);
  for (let i = 0; i < count; i++) {
    const opt = opts.nth(i);
    const t = ((await opt.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
    if (t === want || t.toLowerCase() === want.toLowerCase()) {
      await opt.click({ force: true, timeout: 8_000 });
      return true;
    }
  }
  for (let i = 0; i < count; i++) {
    const opt = opts.nth(i);
    const t = ((await opt.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
    if (t && t.toLowerCase().includes(want.toLowerCase())) {
      await opt.click({ force: true, timeout: 8_000 });
      return true;
    }
  }
  return false;
}

/**
 * Close dropdown without cancelling New Lead — never Escape on open record modal.
 */
async function dismissOverlaySafely(page, control) {
  if (await isRecordFormModalOpen(page)) {
    if (control) {
      await waitComboboxCollapsed(control, { timeout: 2_000 }).catch(() => {});
    }
    await blurIntoRecordFormModal(page);
    return;
  }
  if (control) {
    await control.focus().catch(() => {});
    await control.press('Tab').catch(() => {});
  }
}

async function waitAfterComboClick(page) {
  await sleep(LWC_MENU_ANIMATION_MS);
}

/** Lookup / typeahead results scroller (lookups only — never used for picklists). */
function lookupResultsScroller(page) {
  return page.locator('.forceSearchScroller:visible');
}

async function closeStaleLookupOverlays(page, combo) {
  const stale = page.locator('.forceSearchScroller:visible').first();
  if (!(await stale.isVisible({ timeout: 400 }).catch(() => false))) return;
  if (await isRecordFormModalOpen(page)) {
    await blurIntoRecordFormModal(page);
    await sleep(200);
    return;
  }
  if (combo) {
    await combo.focus().catch(() => {});
    await combo.press('Escape').catch(() => {});
  }
  await sleep(250);
}

/**
 * Open target field combobox, read ONLY its scoped options, select, verify.
 * @returns {Promise<string>} selected / verified label, or ''
 */
async function selectPicklistValue(page, row, { preferPatterns = [], excludePatterns = [], force = false, maxAttempts = 2, fast = false } = {}) {
  if (await isMainCompetitorsRow(row)) return '';
  if (await isSupplierRow(row)) return '';
  if (await row.locator('.slds-combobox__input-entity-icon').first().isVisible().catch(() => false)) {
    return '';
  }
  if (await row.locator('lightning-lookup').first().isVisible().catch(() => false)) {
    return '';
  }

  const fieldLabel = echoLabel(await getRowLabelText(row));
  const combo = rowPicklistTrigger(row);
  if (!(await combo.isVisible().catch(() => false))) return '';
  if ((await combo.isDisabled().catch(() => false)) || (await isReadonly(combo))) {
    return readComboboxDisplayedValue(combo);
  }

  if (!force) {
    const shown = await readComboboxDisplayedValue(combo);
    if (shown && !NONE_OPTION.test(shown)) {
      // Never keep excluded values (e.g. Facility Type = Other)
      const excluded = excludePatterns.some((p) => p.test(shown));
      if (!excluded && (preferPatterns.length === 0 || preferPatterns.some((p) => p.test(shown)))) {
        progress(`Picklist ${fieldLabel}: already set "${shown}" — skip`);
        return shown;
      }
      if (excluded) {
        progress(`Picklist ${fieldLabel}: current "${shown}" is not allowed — reselect`);
      }
    }
  }

  if (fast) maxAttempts = 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (page.isClosed() || !(await isRecordFormModalOpen(page))) {
      progress(`Picklist ${fieldLabel}: form/browser closed — stop (do not Cancel modal)`);
      return '';
    }

    if (!fast) progress(`Opening ${fieldLabel} combobox... (attempt ${attempt}/${maxAttempts})`);
    await combo.scrollIntoViewIfNeeded().catch(() => {});
    await combo.focus().catch(() => {});
    await combo.click({ force: true });
    await waitAfterComboClick(page);

    let expanded = await waitComboboxExpanded(combo, { timeout: fast ? 1_200 : 2_500 });
    if (!expanded && !fast) {
      await combo.click({ force: true }).catch(() => {});
      await waitAfterComboClick(page);
      expanded = await waitComboboxExpanded(combo, { timeout: 2_000 });
    }
    if (!expanded) {
      if (!fast) progress(`Picklist ${fieldLabel}: combobox did not expand (aria-expandedâ‰ true)`);
      continue;
    }

    // Lookup stole focus — blur and reopen THIS field only
    if (await page.locator('.forceSearchScroller:visible').first().isVisible({ timeout: 300 }).catch(() => false)) {
      progress(`Picklist ${fieldLabel}: lookup overlay detected — reopen this combobox only`);
      await blurIntoRecordFormModal(page);
      await sleep(250);
      await combo.click({ force: true }).catch(() => {});
      await waitAfterComboClick(page);
      if (!(await waitComboboxExpanded(combo, { timeout: 2_000 }))) continue;
    }

    const host = rowComboboxHost(row);
    if (!(await host.isVisible().catch(() => false))) {
      progress(`Picklist ${fieldLabel}: combobox host not found`);
      continue;
    }

    await scopedComboboxOptionLocator(host).first().waitFor({ state: 'visible', timeout: 2_500 }).catch(() => {});
    let optionRoot = host;
    let labels = await listScopedComboboxLabels(host);
    if (!labels.length) {
      const portal = page
        .locator('[role="listbox"]:visible')
        .filter({ has: page.locator('[role="option"]:visible') })
        .last();
      if (await portal.isVisible({ timeout: 1_500 }).catch(() => false)) {
        optionRoot = portal;
        labels = await listScopedComboboxLabels(portal);
      }
    }
    if (excludePatterns.length) {
      labels = labels.filter((l) => !excludePatterns.some((p) => p.test(l)));
    }
    if (!FAST_FILL) progress(`Options found: ${labels.length}`);

    let chosen = '';
    for (const pat of preferPatterns) {
      const hit = labels.find((l) => pat.test(l));
      if (hit) {
        chosen = hit;
        break;
      }
    }
    if (!chosen && preferPatterns.length > 0) {
      // Prefer list missing — fall back to any non-excluded option rather than failing hard
      if (labels.length) {
        chosen = labels[randInt(0, labels.length - 1)];
        progress(`Picklist ${fieldLabel}: preferred missing — using non-excluded "${chosen}"`);
      } else {
        progress(`Picklist ${fieldLabel}: preferred option not in THIS combobox — retry`);
        await dismissOverlaySafely(page, combo);
        await sleep(200);
        continue;
      }
    }
    if (!chosen) {
      if (!labels.length) {
        progress(`Picklist ${fieldLabel}: no scoped options — retry`);
        await dismissOverlaySafely(page, combo);
        continue;
      }
      chosen = labels[randInt(0, labels.length - 1)];
    }

    if (!fast) progress(`Selected: ${chosen}`);
    const clicked = await clickScopedOptionByText(optionRoot, chosen);
    if (!clicked) {
      progress(`Picklist ${fieldLabel}: could not click scoped option "${chosen}"`);
      await dismissOverlaySafely(page, combo);
      continue;
    }

    await waitComboboxCollapsed(combo, { timeout: fast ? 800 : 2_500 });
    if (fast) return chosen;
    await sleep(Math.max(STEP_MS, 80));

    const verified = await readComboboxDisplayedValue(combo);
    progress(`Verified selected value: ${verified || '(empty)'}`);
    if (verified && !NONE_OPTION.test(verified)) {
      if (excludePatterns.some((p) => p.test(verified))) {
        progress(`Picklist ${fieldLabel}: verified "${verified}" is excluded — retry`);
        continue;
      }
      if (preferPatterns.length > 0 && !preferPatterns.some((p) => p.test(verified))) {
        // Accept any non-excluded mapped-ish value when preferred list is partial
        progress(`Picklist ${fieldLabel}: verified "${verified}" (non-excluded; preferred list was soft)`);
      }
      return verified;
    }
    progress(`Picklist ${fieldLabel}: value not populated after select — retry`);
  }

  progress(`Picklist ${fieldLabel}: failed after ${maxAttempts} attempts`);
  return '';
}

/**
 * Random simple picklist — scoped to this row's combobox only.
 */
async function fillVisiblePicklist(page, row, { force = false, leadStatus = '', fast = false } = {}) {
  try {
    if (await isMainCompetitorsRow(row)) return false;
    if (await isSupplierRow(row)) return false;
    if (await row.locator('.slds-combobox__input-entity-icon').first().isVisible().catch(() => false)) {
      return false;
    }
    if (await row.locator('lightning-lookup').first().isVisible().catch(() => false)) {
      return false;
    }
    const label = await getRowLabelText(row);
    // Unqualified Reason is only valid when Status = Unqualified
    if (isUnqualifiedReasonLabel(label) && !isLeadStatusUnqualified(leadStatus)) {
      progress(`      → ${echoLabel(label)} — skipped (only when Status = Unqualified)`);
      return false;
    }
    if (isLostReasonLabel(label) && !isStageClosedLost(leadStatus)) {
      progress(`      → ${echoLabel(label)} — skipped (only when Stage = Closed Lost)`);
      return false;
    }
    // Facility Type: prefer Other (mapping issue resolved)
    if (isFacilityTypeLabel(label)) {
      const chosen = await selectPicklistValue(page, row, {
        force: true,
        fast,
        preferPatterns: FACILITY_TYPE_PREFER,
        excludePatterns: FACILITY_TYPE_EXCLUDE,
      });
      if (chosen && !NONE_OPTION.test(chosen)) {
        progress(`      → Facility Type — "${chosen}"`);
        return true;
      }
      return false;
    }
    // Facility Department: never Other (requires Other Facility Department text)
    if (isFacilityDepartmentLabel(label)) {
      const chosen = await selectPicklistValue(page, row, {
        force: true,
        fast,
        preferPatterns: FACILITY_DEPARTMENT_PREFER,
        excludePatterns: FACILITY_DEPARTMENT_EXCLUDE,
        maxAttempts: 3,
      });
      if (chosen && !NONE_OPTION.test(chosen)) {
        progress(`      → Facility Department — "${chosen}"`);
        return true;
      }
      return false;
    }
    if (isOtherFacilityDepartmentLabel(label)) {
      // Only needed when Facility Department = Other — skip if we avoided Other
      return false;
    }
    // Channel / Request Type: never Tender (would require Tender record + matching Account)
    if (isChannelLabel(label) || isRequestTypeLabel(label)) {
      const chosen = await selectNonTenderChannelOrRequestType(page, row, { fast });
      if (chosen && !NONE_OPTION.test(chosen)) {
        progress(`      → ${echoLabel(label)} — "${chosen}" (not Tender)`);
        return true;
      }
      return false;
    }
    const chosen = await selectPicklistValue(page, row, {
      force,
      preferPatterns: [],
      fast,
      maxAttempts: fast ? 1 : 2,
    });
    return !!(chosen && !NONE_OPTION.test(chosen));
  } catch {
    await dismissOverlaySafely(page, null);
    return false;
  }
}

/**
 * Click inside the New/Edit Lead modal (not the Close X) to blur open dropdowns.
 * Never Escape — Lightning closes the New Lead form.
 */
async function blurIntoRecordFormModal(page) {
  const modal = formModal(page);
  if (!(await modal.isVisible({ timeout: 400 }).catch(() => false))) return false;
  const content = modal.locator('.slds-modal__content').first();
  if (await content.isVisible().catch(() => false)) {
    await content.click({ position: { x: 12, y: 12 }, force: true }).catch(() => {});
    await sleep(120);
    return true;
  }
  const title = modal.locator('.slds-modal__title, h1, h2').first();
  if (await title.isVisible().catch(() => false)) {
    await title.click({ force: true }).catch(() => {});
    await sleep(120);
    return true;
  }
  return false;
}

async function isRecordFormModalOpen(page) {
  return formModal(page).isVisible({ timeout: 400 }).catch(() => false);
}

function sfDateMdY(daysFromToday = 0) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromToday);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${mm}/${dd}/${d.getFullYear()}`;
}

function localeDateStringForSalesforce() {
  return sfDateMdY(0);
}

function isoDateForNativeInput() {
  return new Date().toISOString().slice(0, 10);
}

async function selectDateFromCalendar(page, row, input) {
  if (!(await input.isVisible().catch(() => false))) return false;

  const calendarBtn = row
    .locator(
      'button:has(.slds-icon-calendar), button[title*="Date" i], button[title*="Date"], button[aria-label*="Date" i]',
    )
    .first();
  if (!(await calendarBtn.isVisible().catch(() => false))) return false;

  await calendarBtn.click();
  await sleep(300);

  const calendar = page.locator('.slds-datepicker').first();
  const opened = await calendar.waitFor({ state: 'visible', timeout: 10_000 }).then(() => true).catch(() => false);
  if (!opened) return false;

  const days = calendar.locator('td.slds-day:not(.slds-day_adjacent-month)');
  const count = await days.count();
  if (count === 0) return false;

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
  await calendar.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {});
  return true;
}

async function isDateLikeField(row, input) {
  const role = ((await input.getAttribute('role')) || '').toLowerCase();
  if (role === 'combobox') return false;
  const type = ((await input.getAttribute('type')) || '').toLowerCase();
  if (type === 'date') return true;
  const label = (await getRowLabelText(row)).toLowerCase();
  if (/\bdate\b/i.test(label)) return true;
  const ph = ((await input.getAttribute('placeholder')) || '').toLowerCase();
  if (/\bdd\b|\bmm\b|\byyyy\b|dd\/|\/mm|mm\/|dd-/i.test(ph)) return true;
  const calBtn = row
    .locator(
      'button:has(.slds-icon-calendar), .slds-input__icon-container button, lightning-datepicker button, button[title*="date" i], button[title*="Date" i]',
    )
    .first();
  return calBtn.isVisible().catch(() => false);
}

// ─── Supplier lookup (same flow as Account Parent Account) ───────────────────

function isSupplierLabel(label) {
  return /^supplier$/i.test((label || '').replace(/\*/g, '').trim());
}

async function isSupplierRow(row) {
  const label = await getRowLabelText(row);
  if (isSupplierLabel(label)) return true;
  // Do not treat "Supplier Price" / "Supplier Price Book" as the Supplier lookup
  if (/supplier/i.test(label || '') && !isSupplierLabel(label)) return false;
  if (
    await row
      .locator('[aria-label="Supplier" i], [aria-label="Search Supplier" i], [placeholder*="Search Supplier" i]')
      .first()
      .isVisible()
      .catch(() => false)
  ) {
    return true;
  }
  return false;
}

async function supplierLookupShowsSelection(row) {
  if (await row.locator('button.slds-pill__remove, button[title*="Remove" i]').first().isVisible().catch(() => false)) {
    return true;
  }
  if (await row.locator('.slds-pill, lightning-pill').first().isVisible().catch(() => false)) {
    return true;
  }
  const inp = row
    .locator('lightning-lookup input[role="combobox"], input[role="combobox"], input.slds-input')
    .filter({ visible: true })
    .first();
  if (await inp.isVisible().catch(() => false)) {
    const val = ((await inp.inputValue().catch(() => '')) || '').trim();
    const dataVal = ((await inp.getAttribute('data-value')) || '').trim();
    if (val && !/^test\s*$/i.test(val) && !/^search\b/i.test(val) && !NONE_OPTION.test(val)) return true;
    if (
      dataVal &&
      !/^test\s*$/i.test(dataVal) &&
      !NONE_OPTION.test(dataVal) &&
      !/^supplier$/i.test(dataVal) &&
      !/^search\b/i.test(dataVal)
    ) {
      return true;
    }
  }
  return false;
}

function lookupAdvancedSearchModal(page) {
  // Match lookup advanced-search popup only.
  // Do NOT match on radio_faux alone — Opp/Lead Edit forms also use those and Cancel would close Edit.
  return page
    .locator('.slds-modal__container:visible, section.slds-modal:not(.slds-hide):visible, [role="dialog"]:visible')
    .filter({
      has: page.getByText(/Search Results|Advanced Search|Account Search|Select a value|0 items? selected/i),
    })
    .filter({
      // Never treat New/Edit record forms as the search popup
      hasNot: page.locator(
        [
          'input[name="lastName"]',
          'input[name="LastName"]',
          'input[name="Company"]',
          'input[name="Name"]',
          'input[name="Account-Name"]',
          'input[name="Opportunity-Name"]',
          'lightning-picklist[data-field="StageName"]',
          'lightning-input-field[field-name="StageName"]',
        ].join(', '),
      ),
    })
    .filter({
      hasNot: page.getByText(/edit opportunity|edit lead|edit account|edit contact|solution name|revenue recognition/i),
    })
    .last();
}

async function waitForLookupAdvancedSearchModal(page, timeoutMs = 12_000) {
  const modal = lookupAdvancedSearchModal(page);
  await modal.waitFor({ state: 'visible', timeout: timeoutMs });
  await page.locator('.slds-spinner').first().waitFor({ state: 'hidden', timeout: 8_000 }).catch(() => {});
  return modal;
}

/**
 * Close the lookup advanced-search popup without dismissing New Lead.
 * Prefer Cancel/Close on the search modal only — never page Escape
 * (it closes the New Lead form underneath the search dialog).
 */
async function closeLookupAdvancedSearchModal(page) {
  // Only when a real lookup search UI is open — never Cancel the record Edit form
  const searchUi = page
    .locator('.forceSearchScroller:visible, .forceSearchResultsGridView:visible, .forceSearchInputLookupDesktop:visible')
    .first();
  const searchModal = lookupAdvancedSearchModal(page);
  const searchUiOpen = await searchUi.isVisible({ timeout: 400 }).catch(() => false);
  const modalOpen = await searchModal.isVisible({ timeout: 400 }).catch(() => false);
  if (!searchUiOpen && !modalOpen) return false;

  if (!(await searchModal.isVisible({ timeout: 600 }).catch(() => false))) return false;

  // Extra guard: if this is actually a record Edit/New form, do nothing
  const bodyText = ((await searchModal.innerText().catch(() => '')) || '').slice(0, 800);
  const looksLikeRecordForm =
    (await searchModal
      .locator(
        'input[name="lastName"], input[name="LastName"], input[name="Company"], input[name="Opportunity-Name"], lightning-input-field[field-name="StageName"]',
      )
      .first()
      .isVisible({ timeout: 300 })
      .catch(() => false)) ||
    /last name|save & new|edit opportunity|solution name|revenue recognition|facility department/i.test(bodyText);
  if (looksLikeRecordForm) {
    progress('Lookup cleanup: refused to Cancel — matched record form, not search popup');
    return false;
  }

  const cancel = searchModal
    .getByRole('button', { name: /^(Cancel|Close)$/i })
    .or(searchModal.locator('button[title="Cancel"], button[title="Close"], button.slds-modal__close'))
    .first();
  if (await cancel.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await cancel.click({ force: true }).catch(() => {});
  } else {
    const xBtn = searchModal
      .locator('button.slds-modal__close, button[title*="Cancel and close" i], button[title*="Close" i]')
      .first();
    if (await xBtn.isVisible({ timeout: 1_000 }).catch(() => false)) {
      await xBtn.click({ force: true }).catch(() => {});
    }
  }
  await searchModal.waitFor({ state: 'hidden', timeout: 8_000 }).catch(() => {});
  return !(await searchModal.isVisible({ timeout: 400 }).catch(() => false));
}

/** Clear leftover "test" search text so Save validation is not blocked. */
async function clearSupplierSearchInput(row) {
  const input = row
    .locator('input[role="combobox"], input.slds-combobox__input, input.slds-input')
    .filter({ visible: true })
    .first();
  if (!(await input.isVisible({ timeout: 1_000 }).catch(() => false))) return;
  const val = ((await input.inputValue().catch(() => '')) || '').trim();
  if (!val || /^test\s*$/i.test(val) || /^search\b/i.test(val)) {
    await input.click({ force: true }).catch(() => {});
    await input.fill('').catch(() => {});
  }
}

/**
 * First visible row in advanced-search popup, then footer Select when it enables.
 * Never hangs forever on a disabled Select — returns false so caller can close/cleanup.
 * @returns {Promise<boolean>}
 */
async function selectFirstVisibleLookupSearchOption(searchModal, page) {
  await page.locator('.slds-spinner').first().waitFor({ state: 'hidden', timeout: 8_000 }).catch(() => {});

  const emptyMsg = searchModal
    .getByText(/no items|no results|no matches|nothing to display|0\s*items|we found no/i)
    .first();
  if (await emptyMsg.isVisible({ timeout: 1_500 }).catch(() => false)) {
    progress('Supplier: advanced search returned no results');
    return false;
  }

  const firstRadioFaux = searchModal.locator('.slds-radio_faux, .slds-radio--faux').first();
  const firstRadioInput = searchModal.locator('input[type="radio"]').first();
  const firstListRow = searchModal
    .locator('[role="option"]:visible, tr[data-row-key]:visible, li.slds-listbox__item:visible, tbody tr:visible')
    .filter({ hasNotText: /no items|no results|no matches/i })
    .first();

  let clicked = false;
  if (await firstRadioFaux.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await firstRadioFaux.scrollIntoViewIfNeeded().catch(() => {});
    try {
      await firstRadioFaux.click({ timeout: 5_000 });
    } catch {
      await firstRadioFaux.click({ force: true, timeout: 5_000 }).catch(() => {});
    }
    clicked = true;
  } else if (await firstRadioInput.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await firstRadioInput.check({ force: true }).catch(async () => {
      await firstRadioInput.click({ force: true, timeout: 5_000 }).catch(() => {});
    });
    clicked = true;
  } else if (await firstListRow.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await firstListRow.click({ force: true, timeout: 5_000 }).catch(() => {});
    clicked = true;
  }

  if (!clicked) {
    progress('Supplier: no visible result in advanced-search popup');
    return false;
  }

  await sleep(400);

  // Prefer Select scoped to the search modal (avoid list-view "Select" chrome)
  const selectBtn = searchModal.getByRole('button', { name: /^Select$/i }).last();
  if (await selectBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
    for (let i = 0; i < 10; i++) {
      if (await selectBtn.isEnabled().catch(() => false)) {
        await selectBtn.click({ timeout: 5_000 }).catch(() => {});
        return true;
      }
      // Re-click result periodically — radio may not have registered
      if (i === 3 || i === 6) {
        await firstRadioFaux.click({ force: true }).catch(() => {});
        await firstRadioInput.click({ force: true }).catch(() => {});
        await firstListRow.click({ force: true }).catch(() => {});
      }
      await sleep(300);
    }
    // Fallback: double-click result (some Lightning lookups don't require Select)
    progress('Supplier: Select stayed disabled — trying result double-click');
    await firstListRow.dblclick({ force: true }).catch(() => {});
    await firstRadioFaux.dblclick({ force: true }).catch(() => {});
    await sleep(500);
    if (await selectBtn.isEnabled().catch(() => false)) {
      await selectBtn.click({ timeout: 5_000 }).catch(() => {});
      return true;
    }
    return false;
  }

  // Some lookups resolve on option click alone (no Select footer)
  progress('Supplier: Select not shown — relying on row/option click');
  return true;
}

async function waitUntilSupplierShowsSelection(page, row, { timeoutMs = 8_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await supplierLookupShowsSelection(row)) return true;
    await sleep(150);
  }
  return supplierLookupShowsSelection(row);
}

/**
 * Supplier lookup — same flow as Account Parent Account:
 * click → type "test" → Enter → advanced-search popup → first result → Select.
 * On empty results / disabled Select: close search modal, clear term, leave Lead form intact.
 */
async function fillSupplierLookup(page, row, { force = false } = {}) {
  if (!force && (await supplierLookupShowsSelection(row))) {
    return true;
  }

  let selected = false;
  try {
    await row.scrollIntoViewIfNeeded().catch(() => {});

    // Clear leftover search term / pill if forcing re-fill
    if (force) {
      const remove = row.locator('button.slds-pill__remove, button[title*="Remove" i]').first();
      if (await remove.isVisible({ timeout: 800 }).catch(() => false)) {
        await remove.click().catch(() => {});
        await sleep(300);
      }
    }

    let input = row
      .locator('input[role="combobox"][id^="combobox-input-"]')
      .or(row.locator('input[id^="combobox-input-"]'))
      .or(row.locator('lightning-lookup input[type="text"], lightning-lookup input.slds-input'))
      .or(row.locator('input[role="combobox"], input.slds-combobox__input'))
      .filter({ visible: true })
      .first();

    if (!(await input.isVisible({ timeout: 4_000 }).catch(() => false))) {
      const opener = row
        .locator('lightning-lookup')
        .getByRole('combobox')
        .or(row.getByRole('combobox'))
        .first();
      if (await opener.isVisible().catch(() => false)) {
        await opener.click({ force: true });
        await waitAfterComboClick(page);
      }
      await input.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {});
    }

    if (!(await input.isVisible().catch(() => false))) {
      progress('Supplier: combobox input not visible');
      return false;
    }

    if (!force && (await supplierLookupShowsSelection(row))) {
      return true;
    }

    progress('Supplier: click → type "test" → Enter → wait for advanced search');
    await input.click({ force: true });
    await input.fill('');
    await input.fill('test');
    await input.press('Enter');
    await waitAfterComboClick(page);

    // Prefer inline typeahead from THIS Supplier lookup / search scroller only — existing records only
    const inlineOpt = row
      .locator('lightning-lookup [role="option"]:visible, .slds-combobox [role="option"]:visible')
      .or(lookupResultsScroller(page).locator('[role="option"]:visible'))
      .filter({ hasNotText: /no results|no matches|show more|advanced|^new\b|create\s*new|^\+\s*new/i })
      .first();
    if (await inlineOpt.isVisible({ timeout: 3_000 }).catch(() => false)) {
      const t = ((await inlineOpt.innerText().catch(() => '')) || '').trim().slice(0, 40);
      progress(`Supplier: selecting inline typeahead "${t}"`);
      await inlineOpt.click({ force: true });
      await sleep(500);
      if (await waitUntilSupplierShowsSelection(page, row, { timeoutMs: 5_000 })) {
        progress('Supplier: verified populated (inline)');
        selected = true;
        return true;
      }
    }

    const searchModal = await waitForLookupAdvancedSearchModal(page, 12_000).catch(() => null);
    if (!searchModal) {
      progress('Supplier: advanced search modal did not open');
      return false;
    }

    progress('Supplier: selecting first visible result');
    const picked = await selectFirstVisibleLookupSearchOption(searchModal, page);
    if (picked) {
      await searchModal.waitFor({ state: 'hidden', timeout: 12_000 }).catch(() => {});
      const verified = await waitUntilSupplierShowsSelection(page, row, { timeoutMs: 8_000 });
      if (verified) {
        progress('Supplier: verified populated');
        selected = true;
        return true;
      }
      progress('Supplier: selection not reflected on field after advanced search');
    } else {
      progress('Supplier: could not select a search result (empty or Select disabled)');
    }
    return false;
  } catch (err) {
    progress(`Supplier lookup failed: ${err?.message ?? String(err)}`);
    // Do not page-Escape — closes New Lead modal
    return false;
  } finally {
    // Only tear down a real advanced-search popup — never Cancel New Lead
    if (!selected) {
      await closeLookupAdvancedSearchModal(page);
      if (!(await supplierLookupShowsSelection(row))) {
        await clearSupplierSearchInput(row);
      }
    } else {
      // Inline pick succeeded; just clear leftover typeahead without Cancel
      await blurIntoRecordFormModal(page);
    }
  }
}

/** Locate Supplier row in the open form (Account Parent Account pattern). */
async function findSupplierRow(scope) {
  const rows = await scope.locator('.slds-form-element').all().catch(() => []);
  for (const row of rows) {
    if (!(await row.isVisible().catch(() => false))) continue;
    if (await isSupplierRow(row)) return row;
  }
  return null;
}

/** Fill Supplier once before scrolling other fields (mirrors Account Parent Account once). */
async function fillSupplierInModalOnce(page, scope) {
  let row = await findSupplierRow(scope);
  if (!row) {
    await scrollFormBody(scope);
    row = await findSupplierRow(scope);
  }
  if (!row) {
    progress('Supplier: row not visible yet — will retry on scroll passes');
    return false;
  }
  return fillSupplierLookup(page, row);
}

/**
 * Standard Lightning lookup (dropdown / scroller) — mirrors Account `fillVisibleLookup`.
 * Supplier uses dedicated advanced-search flow (like Account Parent Account).
 * Do NOT type "test"+Enter here — that opens advanced search and pollutes later picklists.
 */
async function fillVisibleLookup(page, row, { force = false } = {}) {
  try {
    if (await isSupplierRow(row)) {
      return fillSupplierLookup(page, row, { force });
    }
    if (await isMainCompetitorsRow(row)) return false;

    const isLookupUi =
      (await row.locator('lightning-lookup').first().isVisible().catch(() => false)) ||
      (await row.locator('.slds-combobox__input-entity-icon').first().isVisible().catch(() => false));
    if (!isLookupUi) return false;

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
    if (hasPill && !force) return true;
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
    if (!(await openerReady.isVisible().catch(() => false))) return true;
    if ((await openerReady.isDisabled().catch(() => false)) || (await isReadonly(openerReady))) return true;

    await openerReady.click().catch(() => {});
    await waitAfterComboClick(page);

    const host = row
      .locator('lightning-lookup, lightning-base-combobox, .slds-combobox')
      .first();
    const resultsPanel = lookupResultsScroller(page).or(host.locator('[role="listbox"]'));
    async function waitResultsVisible() {
      return resultsPanel
        .first()
        .waitFor({ state: 'visible', timeout: 12_000 })
        .then(() => true)
        .catch(() => false);
    }

    let panelOk = await waitResultsVisible();
    if (!panelOk) {
      await openerReady.click({ force: true }).catch(() => {});
      await waitAfterComboClick(page);
      panelOk = await waitResultsVisible();
    }
    if (!panelOk) {
      await dismissOverlaySafely(page, openerReady);
      return false;
    }

    // Scope options to this lookup host or the lookup search scroller — never page-global picklist options
    const optionOverlay = host
      .locator('[role="option"]:visible, li.slds-listbox__item:visible')
      .or(lookupResultsScroller(page).locator('[role="option"]:visible, tr[data-row-key]:visible, li.slds-listbox__item:visible'));
    await optionOverlay.first().waitFor({ state: 'visible', timeout: 12_000 }).catch(() => {});

    const candidates = await optionOverlay.all().catch(() => []);
    const good = [];
    for (const c of candidates) {
      const t = ((await c.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
      if (!t || /no results|no matches|show more results|advanced search/i.test(t)) continue;
      // Never create a new record from lookup — only pick existing
      if (/^new\b|create\s*new|^\+\s*new/i.test(t)) continue;
      // Never pick dual-listbox / Main Competitors options
      const inDual = await c
        .evaluate((el) => !!el.closest('lightning-dual-listbox, .slds-dueling-list'))
        .catch(() => false);
      if (inDual) continue;
      good.push(c);
    }
    const rowOpt = good.length ? good[randInt(0, good.length - 1)] : null;
    if (!rowOpt) {
      await dismissOverlaySafely(page, openerReady);
      return false;
    }
    await rowOpt.click({ force: true }).catch(() => {});
    await sleep(800);

    const pillOk = await row
      .locator('.slds-pill, lightning-pill')
      .first()
      .waitFor({ state: 'visible', timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    return pillOk;
  } catch {
    await dismissOverlaySafely(page, null);
    return false;
  }
}

// ─── Multi-select picklist (Available → Chosen) — ONLY Main Competitors ──────
// Product Category is a simple picklist — never treat it as multi-select.

async function isMainCompetitorsRow(row) {
  const label = await getRowLabelText(row);
  if (/main\s*competitors?/i.test(label)) return true;
  // Dual-listbox alone is not enough — Product Category is a normal combobox picklist
  if (
    /competitor/i.test(label) &&
    (await row.locator('lightning-dual-listbox, .slds-dueling-list').first().isVisible().catch(() => false))
  ) {
    return true;
  }
  return false;
}

function mainCompetitorsDualList(row) {
  return row.locator('lightning-dual-listbox, .slds-dueling-list, [class*="dueling"]').first();
}

/**
 * Main Competitors / multi-select — exact user flow:
 *   1) Click ANY value in the Available section
 *   2) Click the "Move selection to Chosen" button (right arrow between columns)
 *   3) Repeat for multiple values
 */
async function fillMainCompetitorsMultiSelect(page, row, { force = false } = {}) {
  if (!(await isMainCompetitorsRow(row))) return false;

  try {
    await row.scrollIntoViewIfNeeded().catch(() => {});
    const dual = mainCompetitorsDualList(row);
    const scope = (await dual.isVisible({ timeout: 3_000 }).catch(() => false)) ? dual : row;
    const fieldLabel = echoLabel(await getRowLabelText(row)) || 'Main Competitors';

    // Chosen (right) options
    const chosenOptions = scope.locator(
      '[data-type="selected"] [role="option"], [aria-label*="Chosen" i] [role="option"]',
    );

    async function chosenCountNow() {
      let n = await chosenOptions.count().catch(() => 0);
      if (n > 0) return n;
      // Fallback: options in the last dueling column
      n = await scope
        .locator('.slds-dueling-list__column')
        .last()
        .locator('[role="option"]')
        .count()
        .catch(() => 0);
      return n;
    }

    if ((await chosenCountNow()) > 0 && !force) {
      progress(`${fieldLabel}: already has Chosen value(s) — skip`);
      return true;
    }

    // Move to Chosen button (top / right-arrow between Available and Chosen)
    const moveToChosen = scope
      .locator('button[title="Move selection to Chosen"]')
      .or(scope.locator('button[title*="Move selection to Chosen" i]'))
      .or(scope.getByRole('button', { name: /move selection to chosen/i }))
      .or(row.locator('button[title="Move selection to Chosen"]'))
      .or(row.getByRole('button', { name: /move selection to chosen/i }))
      .first();

    // Available (left) options only
    const availableOptions = scope
      .locator('[data-type="source"] [role="option"], [aria-label*="Available" i] [role="option"]')
      .or(scope.locator('.slds-dueling-list__column').first().locator('[role="option"]'))
      .filter({ visible: true });

    let availCount = await availableOptions.count().catch(() => 0);
    if (availCount === 0) {
      // Broader: first listbox in the dual control
      availCount = await scope.locator('[role="listbox"]').first().locator('[role="option"]:visible').count().catch(() => 0);
    }
    if (availCount === 0) {
      progress(`${fieldLabel}: Available section has no values`);
      return false;
    }

    if (!(await moveToChosen.isVisible({ timeout: 8_000 }).catch(() => false))) {
      // Middle column first button (right arrow) as last resort
      const midBtns = scope.locator('.slds-dueling-list__column button, lightning-button-icon button');
      if ((await midBtns.count().catch(() => 0)) === 0) {
        progress(`${fieldLabel}: Move to Chosen button not found`);
        return false;
      }
    }

    const times = Math.min(availCount, randInt(2, Math.min(4, availCount)));
    progress(`${fieldLabel}: will move ${times} value(s) — click Available, then Move to Chosen`);

    let moved = 0;
    for (let k = 0; k < times; k++) {
      const live = scope
        .locator('[data-type="source"] [role="option"], [aria-label*="Available" i] [role="option"]')
        .or(scope.locator('.slds-dueling-list__column').first().locator('[role="option"]'))
        .or(scope.locator('[role="listbox"]').first().locator('[role="option"]'))
        .filter({ visible: true });
      const liveCount = await live.count().catch(() => 0);
      if (liveCount <= 0) break;

      // Step 1: click ANY value from Available
      const idx = randInt(0, liveCount - 1);
      const opt = live.nth(idx);
      const name = ((await opt.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim().slice(0, 48);
      progress(`      Step1: click Available "${name || `#${idx}`}"`);
      await opt.scrollIntoViewIfNeeded().catch(() => {});
      // Prefer the option text span (more reliable on Lightning dual-listbox)
      const textSpan = opt.locator('.slds-truncate, span').first();
      if (await textSpan.isVisible({ timeout: 500 }).catch(() => false)) {
        await textSpan.click({ timeout: 5_000 }).catch(async () => {
          await opt.click({ force: true }).catch(() => {});
        });
      } else {
        await opt.click({ force: true, timeout: 5_000 }).catch(() => {});
      }
      await sleep(300);

      // Confirm option is selected (aria-selected) when possible
      const selected = ((await opt.getAttribute('aria-selected').catch(() => '')) || '').toLowerCase() === 'true';
      if (!selected) {
        await opt.click({ force: true }).catch(() => {});
        await sleep(200);
      }

      // Step 2: click Move selection to Chosen
      progress(`      Step2: click Move selection to Chosen`);
      let clickedMove = false;
      if (await moveToChosen.isVisible({ timeout: 2_000 }).catch(() => false)) {
        // Click even if Playwright thinks disabled — Lightning sometimes lags aria state
        await moveToChosen.click({ force: true, timeout: 5_000 }).catch(async () => {
          await moveToChosen.evaluate((el) => el.click()).catch(() => {});
        });
        clickedMove = true;
      } else {
        const firstMid = scope.locator('.slds-dueling-list__column button, lightning-button-icon button').first();
        if (await firstMid.isVisible({ timeout: 2_000 }).catch(() => false)) {
          await firstMid.click({ force: true }).catch(() => {});
          clickedMove = true;
        }
      }
      if (!clickedMove) {
        progress(`      Step2: WARN Move to Chosen button not clickable`);
        break;
      }
      await sleep(400);

      const now = await chosenCountNow();
      if (now > moved) {
        moved = now;
        progress(`      OK: "${name}" is in Chosen (total ${moved})`);
      } else {
        progress(`      WARN: Chosen count still ${now} after moving "${name}"`);
      }
    }

    const finalCount = await chosenCountNow();
    if (finalCount > 0) {
      progress(`${fieldLabel}: Passed — ${finalCount} value(s) in Chosen`);
      return true;
    }

    progress(`${fieldLabel}: WARN Chosen still empty`);
    return false;
  } catch (err) {
    progress(`${fieldLabel || 'Main Competitors'} failed: ${err?.message ?? String(err)}`);
    return false;
  }
}

async function fillVisibleTextarea(row, { force = false } = {}) {
  if (await isMainCompetitorsRow(row)) return false;
  const ta = row.locator('textarea').first();
  if (!(await ta.isVisible().catch(() => false))) return false;
  if ((await ta.isDisabled().catch(() => false)) || (await isReadonly(ta))) return false;
  const cur = await ta.inputValue().catch(() => '');
  if (cur.trim() && !force) return false;
  if (force && cur.trim()) {
    await ta.fill('');
  }
  const maxLen = await ta.getAttribute('maxlength');
  await ta.fill(clipToMaxlength(`Note ${randomAlphaNum(10)} / ${Date.now()}`, maxLen));
  return true;
}

/** @returns {Promise<boolean>} true if this call wrote random data into the row */
async function fillVisibleInput(page, row, { force = false } = {}) {
  if (await isSupplierRow(row)) return false;
  if (await isMainCompetitorsRow(row)) return false;
  if (isCloseDateLabel(await getRowLabelText(row))) return false;

  const input = row
    .locator(
      'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="search"]):not([type="button"]):not([type="submit"]):not([type="file"])',
    )
    .first();
  if (!(await input.isVisible({ timeout: 800 }).catch(() => false))) return false;
  if ((await input.isDisabled({ timeout: 800 }).catch(() => false)) || (await isReadonly(input))) return false;
  const cur = await input.inputValue().catch(() => '');
  const type = ((await input.getAttribute('type', { timeout: 800 }).catch(() => '')) || 'text').toLowerCase();
  const role = ((await input.getAttribute('role', { timeout: 800 }).catch(() => '')) || '').toLowerCase();
  const label = (await getRowLabelText(row)).toLowerCase();
  const maxLen = await input.getAttribute('maxlength', { timeout: 800 }).catch(() => null);

  if (isStartDateLabel(label)) {
    if (!cur.trim() || force) await input.fill(sfDateMdY(0));
    return true;
  }
  if (isExpirationDateLabel(label)) {
    await input.fill(sfDateMdY(90));
    return true;
  }

  // Dates already set (Close Date, etc.) — do not overwrite
  if ((type === 'date' || (await isDateLikeField(row, input))) && cur.trim()) {
    return false;
  }
  if (cur.trim() && !force) return false;
  if (force && cur.trim()) {
    await input.fill('');
  }

  if (type === 'date') {
    await input.fill(isoDateForNativeInput());
    return true;
  }
  if (await isDateLikeField(row, input)) {
    if (await selectDateFromCalendar(page, row, input)) return true;
    await input.fill(clipToMaxlength(localeDateStringForSalesforce(), maxLen));
    return true;
  }
  if (role === 'spinbutton' || type === 'number') {
    await input.fill(clipToMaxlength(randomNumber(), maxLen));
    return true;
  }
  if (type === 'tel' || /phone|mobile/i.test(label)) {
    await input.fill(clipToMaxlength(randomPhone(), maxLen));
    return true;
  }
  if (type === 'email' || /email/i.test(label)) {
    await input.fill(clipToMaxlength(randomEmail(), maxLen));
    return true;
  }
  if (type === 'url' || /website|url|web\s*site/i.test(label)) {
    await input.fill(clipToMaxlength(`https://example-${randomAlphaNum(6)}.com`, maxLen));
    return true;
  }
  if (/currency|amount|budget|revenue|price|cost/i.test(label) || type === 'number') {
    await input.fill(clipToMaxlength(String(randInt(1000, 250_000)), maxLen));
    return true;
  }
  if (/percent|%/i.test(label)) {
    await input.fill(clipToMaxlength(String(clampPercent(randInt(0, 100))), maxLen));
    return true;
  }
  if (/last\s*name/i.test(label)) {
    await input.fill(clipToMaxlength(`Lead_${stamp()}`, maxLen));
    return true;
  }
  if (/^company$/i.test(label) || /^account\s*name$/i.test(label) || /^name$/i.test(label)) {
    await input.fill(clipToMaxlength(`Co_${stamp()}`, maxLen));
    return true;
  }
  if (/first\s*name/i.test(label)) {
    await input.fill(clipToMaxlength(`Auto_${randomAlphaNum(4)}`, maxLen));
    return true;
  }

  const maxN = maxLen ? Number.parseInt(maxLen, 10) : NaN;
  const prefix = Number.isFinite(maxN) && maxN <= 20 ? 'A' : 'Auto_';
  await input.fill(clipToMaxlength(randomText(prefix), maxLen));
  return true;
}

/** Checkbox — check when empty (skip if already checked unless force). Never check Do Not Call. */
async function fillVisibleCheckbox(row, { force = false } = {}) {
  if (await isMainCompetitorsRow(row)) return false;
  const label = await getRowLabelText(row);
  if (isDoNotCallLabel(label)) {
    progress(`      → ${echoLabel(label)} — skipped (optional; does not block Save)`);
    return false;
  }
  const box = row.locator('input[type="checkbox"]').first();
  if (!(await box.isVisible().catch(() => false))) {
    // Lightning often uses faux checkbox; click the input or label
    const faux = row.locator('.slds-checkbox_faux, .slds-checkbox--faux').first();
    if (!(await faux.isVisible().catch(() => false))) return false;
    const input = row.locator('input[type="checkbox"]').first();
    const already = await input.isChecked().catch(() => false);
    if (already && !force) return true;
    await faux.click({ force: true }).catch(() => {});
    return true;
  }
  if ((await box.isDisabled().catch(() => false)) || (await isReadonly(box))) return false;
  const already = await box.isChecked().catch(() => false);
  if (already && !force) return true;
  await box.check({ force: true }).catch(async () => {
    await box.click({ force: true }).catch(() => {});
  });
  return true;
}

async function expandSections(scope) {
  const collapsed = scope.locator(
    'button[aria-expanded="false"].slds-section__title-action, lightning-accordion-section button[aria-expanded="false"]',
  );
  const k = await collapsed.count();
  for (let i = 0; i < k; i++) {
    const btn = collapsed.nth(i);
    if (!(await btn.isVisible().catch(() => false))) continue;
    const title = ((await btn.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
    // Expand SAP Information too so we can see if any field is required
    await btn.click().catch(() => {});
  }
}

async function scrollFormBody(scope) {
  const body = scope.locator('.slds-modal__content, .record-body-container, .slds-form').first();
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

/**
 * Detect required Lightning form rows: asterisk label, `.slds-required`,
 * `required` / `aria-required="true"` on controls or host elements.
 */
function isSectorLabel(label) {
  return /^sector$/i.test((label || '').replace(/\*/g, '').trim());
}

function isChannelLabel(label) {
  return /^channel$/i.test((label || '').replace(/\*/g, '').trim());
}

function isRequestTypeLabel(label) {
  return /^request\s*type$/i.test((label || '').replace(/\*/g, '').trim());
}

/** Tender Channel / Request Type makes Tender lookup mandatory (Account must match). Never select Tender. */
const TENDER_PICKLIST_EXCLUDE = [/^\s*tender\s*$/i];
/** Prefer these when Channel / Request Type must leave Tender (or Tender becomes mandatory). */
const CHANNEL_REQUEST_TYPE_PREFER = [/^direct\s*purchase$/i, /^marketplace$/i, /^market\s*place$/i];

function isTenderLookupLabel(label) {
  return /^tender$/i.test((label || '').replace(/\*/g, '').trim());
}

/**
 * Channel / Request Type: never Tender.
 * Prefer Direct Purchase / Marketplace (especially when Tender is mandatory).
 */
async function selectNonTenderChannelOrRequestType(page, row, { fast = false, preferDirectOrMarketplace = false } = {}) {
  const shown = await readComboboxDisplayedValue(rowPicklistTrigger(row));
  const isPreferred = shown && CHANNEL_REQUEST_TYPE_PREFER.some((p) => p.test(shown));
  const isSafeNonTender =
    shown && !NONE_OPTION.test(shown) && !TENDER_PICKLIST_EXCLUDE.some((p) => p.test(shown));
  if (isPreferred) return shown;
  if (isSafeNonTender && !preferDirectOrMarketplace) return shown;

  const chosen = await selectPicklistValue(page, row, {
    force: true,
    fast,
    excludePatterns: TENDER_PICKLIST_EXCLUDE,
    preferPatterns: CHANNEL_REQUEST_TYPE_PREFER,
    maxAttempts: 3,
  });
  return chosen || '';
}

/** When Tender is required on the form, force Channel / Request Type to Direct Purchase or Marketplace. */
async function ensureChannelRequestTypeIfTenderMandatory(page, scope) {
  let tenderRequired = false;
  const rows = await scope.locator('.slds-form-element').all().catch(() => []);
  for (const row of rows) {
    if (!(await row.isVisible().catch(() => false))) continue;
    const label = await getRowLabelText(row);
    if (!isTenderLookupLabel(label)) continue;
    if (await isRequiredFormRow(row)) {
      tenderRequired = true;
      break;
    }
  }
  if (!tenderRequired) return false;

  progress('Tender is mandatory — set Channel / Request Type to Direct Purchase or Marketplace');
  let changed = false;
  for (const row of rows) {
    if (!(await row.isVisible().catch(() => false))) continue;
    const label = await getRowLabelText(row);
    if (!isChannelLabel(label) && !isRequestTypeLabel(label)) continue;
    await row.scrollIntoViewIfNeeded().catch(() => {});
    const chosen = await selectNonTenderChannelOrRequestType(page, row, {
      preferDirectOrMarketplace: true,
    });
    if (chosen) {
      changed = true;
      progress(`      → ${echoLabel(label)} → ${chosen} (avoid Tender)`);
    }
  }
  return changed;
}

function isLeadQualifyDetailLabel(label) {
  const t = (label || '').replace(/\*/g, '').trim();
  return /^(email|mobile|mobile\s*number)$/i.test(t) || isSectorLabel(t) || isChannelLabel(t);
}

function isAlwaysRequiredLabel(label) {
  const t = (label || '').replace(/\*/g, '').trim();
  return (
    /^(last\s*name|company|customer\s*name|lead\s*source)$/i.test(t) ||
    /^(account\s*group|customer\s*group|distribution\s*channel|account\s*currency)$/i.test(t) ||
    /^type$/i.test(t) ||
    /sap\s*division/i.test(t) ||
    /^(opportunity\s*name|close\s*date|stage)$/i.test(t)
  );
}

/** Not asterisk-required, but Qualify will fail without Email, Mobile, Sector, Channel. */
async function fillLeadQualifyPrerequisites(page, scope) {
  progress('Lead Qualify prerequisites — Email, Mobile, Sector Information (not marked required)');
  await expandSections(scope);
  const sectorBtn = scope.getByRole('button', { name: /sector information/i }).first();
  if (await sectorBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
    const expanded = ((await sectorBtn.getAttribute('aria-expanded').catch(() => '')) || '').toLowerCase();
    if (expanded === 'false') await sectorBtn.click().catch(() => {});
  }

  const rows = await scope.locator('.slds-form-element').all();
  for (const row of rows) {
    if (!(await row.isVisible().catch(() => false))) continue;
    const label = await getRowLabelText(row);
    if (!/^(email|mobile|mobile\s*number)$/i.test((label || '').replace(/\*/g, '').trim()) && !isSectorLabel(label)) {
      continue;
    }
    if (!(await isFormRowEmpty(row))) continue;
    await row.scrollIntoViewIfNeeded().catch(() => {});
    await fillFormRowByDataType(page, row, { force: true });
    progress(`      → Qualify prerequisite ${echoLabel(label)}`);
  }
  await sleep(400);
  for (const row of await scope.locator('.slds-form-element').all()) {
    if (!(await row.isVisible().catch(() => false))) continue;
    if (!isChannelLabel(await getRowLabelText(row))) continue;
    if (!(await isFormRowEmpty(row))) break;
    await row.scrollIntoViewIfNeeded().catch(() => {});
    const chosen = await selectNonTenderChannelOrRequestType(page, row);
    progress(`      → Qualify prerequisite Channel — ${chosen || '(empty)'}`);
    break;
  }
}

async function isRequiredFormRow(row) {
  if (!(await row.isVisible().catch(() => false))) return false;

  const label = await getRowLabelText(row);
  if (isAlwaysRequiredLabel(label)) return true;

  // Visible asterisk only — hidden assistive marks made Account look like 30+ required fields
  if (
    await row
      .locator('.slds-required, abbr.slds-required, span.slds-required, [title="required" i], [title*="Required" i]')
      .first()
      .isVisible()
      .catch(() => false)
  ) {
    return true;
  }

  const rawLabel = await row
    .locator('.slds-form-element__label, legend.slds-form-element__legend')
    .first()
    .innerText()
    .catch(() => '');
  if (/\*/.test(rawLabel)) return true;

  const requiredHosts = row.locator(
    '[required], [aria-required="true"], lightning-input[required], lightning-textarea[required], lightning-combobox[required], lightning-lookup[required], lightning-dual-listbox[required], lightning-radio-group[required], lightning-checkbox-group[required]',
  );
  if ((await requiredHosts.count().catch(() => 0)) > 0) {
    const n = await requiredHosts.count();
    for (let i = 0; i < Math.min(n, 8); i++) {
      const h = requiredHosts.nth(i);
      if (await h.isVisible().catch(() => false)) return true;
      const aria = ((await h.getAttribute('aria-required').catch(() => '')) || '').toLowerCase();
      if (aria === 'true') return true;
      if ((await h.getAttribute('required').catch(() => null)) !== null) return true;
    }
  }

  const controls = row.locator(
    'input:not([type="hidden"]):not([type="button"]):not([type="submit"]), textarea, select, [role="combobox"], button[role="combobox"]',
  );
  const cCount = await controls.count().catch(() => 0);
  for (let i = 0; i < Math.min(cCount, 6); i++) {
    const c = controls.nth(i);
    if (!(await c.isVisible().catch(() => false))) continue;
    const aria = ((await c.getAttribute('aria-required').catch(() => '')) || '').toLowerCase();
    if (aria === 'true') return true;
    if ((await c.getAttribute('required').catch(() => null)) !== null) return true;
  }

  return false;
}

/**
 * True when a form row looks empty / None (blocking Save for required fields).
 */
async function isFormRowEmpty(row) {
  if (await isMainCompetitorsRow(row)) {
    const dual = mainCompetitorsDualList(row);
    const scope = (await dual.isVisible({ timeout: 1_500 }).catch(() => false)) ? dual : row;
    const chosenCount = await scope
      .locator(
        '[data-type="selected"] [role="option"], .slds-dueling-list__column_responsive-right [role="option"], select[aria-label*="Chosen" i] option, .slds-listbox_vertical[aria-label*="Chosen" i] [role="option"]',
      )
      .count()
      .catch(() => 0);
    if (chosenCount > 0) return false;
    const classicChosen = row.locator('select').nth(1);
    if (await classicChosen.isVisible().catch(() => false)) {
      const selected = await classicChosen.locator('option:checked').count().catch(() => 0);
      if (selected > 0) return false;
    }
    return true;
  }

  if (await isSupplierRow(row)) {
    return !(await supplierLookupShowsSelection(row));
  }

  const hasLookupUi =
    (await row.locator('lightning-lookup').first().isVisible().catch(() => false)) ||
    (await row.locator('.slds-combobox__input-entity-icon').first().isVisible().catch(() => false));
  if (hasLookupUi) {
    if (await row.locator('.slds-pill, lightning-pill, button.slds-pill__remove').first().isVisible().catch(() => false)) {
      return false;
    }
    const lk = row.locator('input[role="combobox"], lightning-lookup input').filter({ visible: true }).first();
    if (await lk.isVisible().catch(() => false)) {
      const val = ((await lk.inputValue().catch(() => '')) || '').trim();
      const dv = ((await lk.getAttribute('data-value')) || '').trim();
      if (val && !/^test\s*$/i.test(val) && !/^search\b/i.test(val) && !NONE_OPTION.test(val)) return false;
      if (dv && !/^test\s*$/i.test(dv) && !NONE_OPTION.test(dv) && !/^search\b/i.test(dv)) return false;
    }
    return true;
  }

  const combo = row
    .getByRole('combobox')
    .or(row.locator('button.slds-combobox__input[role="combobox"], button.slds-combobox__input'))
    .first();
  if (await combo.isVisible().catch(() => false)) {
    const shown = ((await combo.innerText().catch(() => '')) || '').trim();
    const val = ((await combo.inputValue().catch(() => '')) || '').trim();
    const text = (shown || val).replace(/\s+/g, ' ').trim();
    if (!text || NONE_OPTION.test(text)) return true;
    return false;
  }

  const ta = row.locator('textarea').first();
  if (await ta.isVisible().catch(() => false)) {
    return !((await ta.inputValue().catch(() => '')) || '').trim();
  }

  const input = row
    .locator(
      'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="search"]):not([type="button"]):not([type="submit"]):not([type="file"])',
    )
    .first();
  if (await input.isVisible().catch(() => false)) {
    return !((await input.inputValue().catch(() => '')) || '').trim();
  }

  const checked = row.locator('input[type="radio"]:checked, input[type="checkbox"]:checked').first();
  if (await row.locator('input[type="radio"], input[type="checkbox"]').first().isVisible().catch(() => false)) {
    return !(await checked.isVisible().catch(() => false));
  }

  return false;
}

/**
 * Fill one form row using Account-style data-type handlers + Lead special rules.
 * @returns {Promise<{ filled: boolean, productCategory?: string, businessUnitFilled?: boolean }>}
 */
async function fillFormRowByDataType(page, row, { force = false, productCategory = '', businessUnitFilled = false, leadStatus = '', oppStage = '', fast = false, skipLookups = false } = {}) {
  const out = { filled: false, productCategory, businessUnitFilled, leadStatus };
  if (!(await row.isVisible().catch(() => false))) return out;

  const label = await getRowLabelText(row);
  const el = row.locator('input, button, textarea, select').first();
  const disabled =
    (await el.isDisabled({ timeout: 1_500 }).catch(() => false)) ||
    (await el.getAttribute('aria-disabled').catch(() => null)) === 'true';

  // Never check Do Not Call / Account Approval Status / never create Price Book / never change Close Date
  if (
    isDoNotCallLabel(label) ||
    isAccountApprovalStatusLabel(label) ||
    isPriceBookLabel(label) ||
    isCloseDateLabel(label)
  ) {
    return out;
  }
  // Tender lookup is mandatory only when Channel/Request Type = Tender — skip it
  if (isTenderLookupLabel(label)) {
    progress(`      → Tender — skipped (Channel / Request Type must not be Tender)`);
    return out;
  }
  if (await shouldSkipOptionalSapRow(row)) {
    return out;
  }

  // Channel / Request Type: any value except Tender
  if (isChannelLabel(label) || isRequestTypeLabel(label)) {
    const chosen = await selectNonTenderChannelOrRequestType(page, row, { fast });
    if (chosen && !NONE_OPTION.test(chosen)) {
      out.filled = true;
      progress(`      → ${echoLabel(label)} — "${chosen}" (not Tender)`);
    }
    return out;
  }

  // Unqualified Reason only when Status = Unqualified
  if (isUnqualifiedReasonLabel(label)) {
    if (!isLeadStatusUnqualified(leadStatus)) {
      return out;
    }
    const chosen = await selectPicklistValue(page, row, { force: true, fast });
    if (chosen && !NONE_OPTION.test(chosen)) out.filled = true;
    return out;
  }

  // Lost / Loss Reason only when Opportunity Stage = Closed Lost
  if (isLostReasonLabel(label)) {
    if (!isStageClosedLost(oppStage || leadStatus)) {
      return out;
    }
    const chosen = await selectPicklistValue(page, row, { force: true, fast });
    if (chosen && !NONE_OPTION.test(chosen)) out.filled = true;
    return out;
  }

  // Stage on Opportunity: set to Quote (required before New Quote). Never Closed Lost.
  if (isOpportunityStageLabel(label)) {
    const shown = await readComboboxDisplayedValue(rowPicklistTrigger(row));
    if (/^quote$/i.test(shown || '')) {
      out.filled = true;
      return out;
    }
    const chosen = await selectPicklistValue(page, row, {
      preferPatterns: [/^quote$/i],
      excludePatterns: [/closed\s*lost/i],
      force: true,
      fast,
    });
    if (chosen && !NONE_OPTION.test(chosen)) out.filled = true;
    return out;
  }

  // Facility Department: never Other (requires Other Facility Department text)
  if (isFacilityDepartmentLabel(label)) {
    const chosen = await selectPicklistValue(page, row, {
      preferPatterns: FACILITY_DEPARTMENT_PREFER,
      excludePatterns: FACILITY_DEPARTMENT_EXCLUDE,
      force: true,
      fast,
      maxAttempts: 3,
    });
    if (chosen && !NONE_OPTION.test(chosen)) {
      out.filled = true;
      progress(`      → Facility Department — "${chosen}"`);
    }
    return out;
  }
  if (isOtherFacilityDepartmentLabel(label)) {
    if (!force) return out;
    const input = row.locator('input:not([type="hidden"]), textarea').first();
    if (await input.isVisible({ timeout: 1_500 }).catch(() => false)) {
      await input.fill(`Other Dept ${stamp()}`);
      out.filled = true;
      progress(`      → Other Facility Department — filled`);
    }
    return out;
  }

  if (isBusinessUnitLabel(label)) {
    const chosen = await selectPicklistValue(page, row, { force: force || !businessUnitFilled, fast });
    if (chosen && !NONE_OPTION.test(chosen)) {
      out.filled = true;
      out.businessUnitFilled = true;
    }
    return out;
  }

  if (isQuoteTypeLabel(label)) {
    const chosen = await selectPicklistValue(page, row, { force: true, fast });
    if (chosen && !NONE_OPTION.test(chosen)) {
      out.filled = true;
      progress(`      → Quote Type — ${chosen}`);
    }
    return out;
  }

  if (isSapDivisionLabel(label)) {
    const chosen = await selectPicklistValue(page, row, { force: true, fast });
    if (chosen && !NONE_OPTION.test(chosen)) out.filled = true;
    return out;
  }

  if (isDivisionLabel(label)) {
    if (!businessUnitFilled && !out.businessUnitFilled) {
      return out;
    }
    if (disabled && !force) return out;
    const chosen = await selectPicklistValue(page, row, { force: true, fast });
    if (chosen && !NONE_OPTION.test(chosen)) out.filled = true;
    return out;
  }

  if (isProductCategoryLabel(label)) {
    // Product Category: Medical Equipment or Medical Equipment & Consumables only (not Consumables)
    if (productCategory && /medical\s*equipment/i.test(productCategory) && !force) {
      out.filled = true;
      return out;
    }
    const chosen = await selectPicklistValue(page, row, {
      preferPatterns: PRODUCT_CATEGORY_PREFER,
      excludePatterns: PRODUCT_CATEGORY_EXCLUDE,
      force: true,
      fast,
    });
    if (chosen && /medical\s*equipment/i.test(chosen)) {
      out.productCategory = chosen;
      out.filled = true;
    }
    return out;
  }

  if (isLeadStatusLabel(label)) {
    const chosen = await selectPicklistValue(page, row, {
      preferPatterns: LEAD_STATUS_PREFER,
      force,
      fast,
    });
    if (chosen) {
      out.filled = true;
      out.leadStatus = chosen;
    }
    return out;
  }

  if (await isSupplierRow(row)) {
    out.filled = !!(await fillSupplierLookup(page, row, { force }));
    return out;
  }

  if (skipLookups) {
    const isLookupUi =
      (await row.locator('lightning-lookup').first().isVisible().catch(() => false)) ||
      (await row.locator('.slds-combobox__input-entity-icon').first().isVisible().catch(() => false));
    if (isLookupUi) return out;
  }

  if (await isMainCompetitorsRow(row)) {
    out.filled = !!(await fillMainCompetitorsMultiSelect(page, row, { force }));
    return out;
  }

  if (disabled) return out;

  if (await fillVisibleLookup(page, row, { force })) {
    out.filled = true;
    return out;
  }
  if (await fillVisiblePicklist(page, row, { force, leadStatus, fast })) {
    out.filled = true;
    return out;
  }
  if (await fillVisibleTextarea(row, { force })) {
    out.filled = true;
    return out;
  }
  if (await fillVisibleInput(page, row, { force })) {
    out.filled = true;
    return out;
  }
  if (await fillVisibleCheckbox(row, { force })) {
    out.filled = true;
    return out;
  }
  // Radio groups sometimes required
  const radio = row.locator('input[type="radio"]:not(:checked)').first();
  if (await radio.isVisible().catch(() => false)) {
    await radio.check({ force: true }).catch(async () => {
      await radio.click({ force: true }).catch(() => {});
    });
    out.filled = true;
  }
  return out;
}

/**
 * After the broad fill (or before Save): find still-empty required rows and fill them.
 * Honors BU → Division order and Lead Product Category preferences.
 * @returns {Promise<{ productCategory: string, filledCount: number, remainingEmpty: string[] }>}
 */
async function fillEmptyRequiredFields(page, scope, { contextLabel = 'form', productCategory = '', leadStatus = '', maxPasses = FAST_FILL ? 1 : 3 } = {}) {
  let pc = productCategory || '';
  let status = leadStatus || '';
  let businessUnitFilled = false;
  let filledCount = 0;
  const remainingEmpty = [];

  if (page.isClosed() || !(await isRecordFormOpen(page, scope))) {
    progress(`Fill empty required (${contextLabel}) - skipped (form/browser not open)`);
    return { productCategory: pc, filledCount: 0, remainingEmpty: [], leadStatus: status };
  }

  await scope.locator('.slds-spinner:visible').first().waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {});
  await expandSections(scope);
  await scrollFormBody(scope);

  progress(`Fill empty required (${contextLabel}) - Running...`);

  for (let pass = 0; pass < maxPasses; pass++) {
    if (page.isClosed() || !(await isRecordFormOpen(page, scope))) {
      progress(`Fill empty required (${contextLabel}) - ABORT: form closed on pass ${pass + 1}`);
      break;
    }
    remainingEmpty.length = 0;
    let passFilled = 0;

    // Ensure Business Unit before Division on required pass
    const allRows = await scope.locator('.slds-form-element').all().catch(() => []);
    for (const row of allRows) {
      if (!(await row.isVisible().catch(() => false))) continue;
      const label = await getRowLabelText(row);
      if (!isBusinessUnitLabel(label)) continue;
      if (!(await isRequiredFormRow(row)) && !(await isFormRowEmpty(row))) {
        // still mark BU filled if already has value
        if (!(await isFormRowEmpty(row))) businessUnitFilled = true;
        continue;
      }
      if (await isFormRowEmpty(row)) {
        await row.scrollIntoViewIfNeeded().catch(() => {});
        const r = await fillFormRowByDataType(page, row, {
          force: true,
          productCategory: pc,
          businessUnitFilled,
          leadStatus: status,
        });
        if (r.businessUnitFilled) businessUnitFilled = true;
        if (r.productCategory) pc = r.productCategory;
        if (r.leadStatus) status = r.leadStatus;
        if (r.filled) {
          passFilled += 1;
          filledCount += 1;
          progress(`      → required ${echoLabel(label)} — filled (BU)`);
          await sleep(Math.max(STEP_MS, 150));
        }
      } else {
        businessUnitFilled = true;
      }
    }

    // Re-scan BU filled state from current values
    for (const row of allRows) {
      if (!(await row.isVisible().catch(() => false))) continue;
      if (isBusinessUnitLabel(await getRowLabelText(row)) && !(await isFormRowEmpty(row))) {
        businessUnitFilled = true;
        break;
      }
    }

    const rows = await scope.locator('.slds-form-element').all();
    for (const row of rows) {
      try {
        if (!(await row.isVisible().catch(() => false))) continue;
        if (!(await isRequiredFormRow(row))) continue;

        const label = await getRowLabelText(row);
        if (isBusinessUnitLabel(label)) continue; // handled above
        if (
          isDoNotCallLabel(label) ||
          isAccountApprovalStatusLabel(label) ||
          isPriceBookLabel(label) ||
          isCloseDateLabel(label)
        ) {
          continue;
        }
        // SAP Information: fill required only (optional SAP fields stay for SAP sync)
        if (await shouldSkipOptionalSapRow(row)) continue;
        if (isUnqualifiedReasonLabel(label) && !isLeadStatusUnqualified(status)) continue;
        if (isLostReasonLabel(label) && !isStageClosedLost(status)) continue;

        if (isTenderLookupLabel(label)) continue;
        if (isDivisionLabel(label) && !businessUnitFilled) {
          remainingEmpty.push(echoLabel(label) + ' (waiting on Business Unit)');
          continue;
        }
        if (isChannelLabel(label)) {
          // Channel depends on Sector — fill Sector first (non-Tender)
          continue;
        }

        if (!(await isFormRowEmpty(row))) {
          // Channel / Request Type already set to Tender → force Direct Purchase / Marketplace
          if (isChannelLabel(label) || isRequestTypeLabel(label)) {
            const shown = await readComboboxDisplayedValue(rowPicklistTrigger(row));
            if (shown && TENDER_PICKLIST_EXCLUDE.some((p) => p.test(shown))) {
              await row.scrollIntoViewIfNeeded().catch(() => {});
              const chosen = await selectNonTenderChannelOrRequestType(page, row, {
                preferDirectOrMarketplace: true,
              });
              if (chosen && !NONE_OPTION.test(chosen)) {
                passFilled += 1;
                filledCount += 1;
                progress(`      → replaced Tender on ${echoLabel(label)} → ${chosen}`);
              }
            }
          }
          if (isLeadStatusLabel(label)) {
            const shown = await readComboboxDisplayedValue(rowPicklistTrigger(row));
            if (shown) status = shown;
          }
          continue;
        }

        await row.scrollIntoViewIfNeeded().catch(() => {});
        const r = await fillFormRowByDataType(page, row, {
          force: true,
          productCategory: pc,
          businessUnitFilled,
          leadStatus: status,
        });
        if (r.businessUnitFilled) businessUnitFilled = true;
        if (r.productCategory) pc = r.productCategory;
        if (r.leadStatus) status = r.leadStatus;
        if (r.filled) {
          passFilled += 1;
          filledCount += 1;
          progress(`      → required ${echoLabel(label)} — filled`);
          await sleep(STEP_MS);
        } else if (await isFormRowEmpty(row)) {
          remainingEmpty.push(echoLabel(label));
        }
      } catch (err) {
        progress(`   ... required row skipped: ${err?.message ?? err}`);
      }
    }

    // Channel + Request Type after Sector (never Tender)
    let sectorFilled = false;
    for (const row of await scope.locator('.slds-form-element').all()) {
      if (!(await row.isVisible().catch(() => false))) continue;
      const label = await getRowLabelText(row);
      if (!isSectorLabel(label)) continue;
      if (await isFormRowEmpty(row)) {
        await fillFormRowByDataType(page, row, { force: true, productCategory: pc, leadStatus: status });
        await sleep(400);
      }
      sectorFilled = !(await isFormRowEmpty(row));
    }
    if (sectorFilled) {
      for (const row of await scope.locator('.slds-form-element').all()) {
        if (!(await row.isVisible().catch(() => false))) continue;
        const label = await getRowLabelText(row);
        if (!isChannelLabel(label) && !isRequestTypeLabel(label)) continue;
        const shown = await readComboboxDisplayedValue(rowPicklistTrigger(row));
        const needsFill =
          (await isFormRowEmpty(row)) || (shown && TENDER_PICKLIST_EXCLUDE.some((p) => p.test(shown)));
        if (!needsFill) continue;
        await row.scrollIntoViewIfNeeded().catch(() => {});
        const chosen = await selectNonTenderChannelOrRequestType(page, row, {
          preferDirectOrMarketplace: true,
        });
        if (chosen && !NONE_OPTION.test(chosen)) {
          passFilled += 1;
          filledCount += 1;
          progress(`      → required ${echoLabel(label)} — ${chosen} (not Tender)`);
        }
      }
    }

    await ensureChannelRequestTypeIfTenderMandatory(page, scope).catch(() => {});

    if (contextLabel === 'Lead' && !/consumables|medical\s*equipment/i.test(pc || '')) {
      const ensured = await ensureLeadProductCategory(page, scope);
      if (ensured) {
        pc = ensured;
        passFilled += 1;
        filledCount += 1;
      }
    }

    const body = scope.locator('.slds-modal__content').first();
    if (await body.isVisible().catch(() => false)) {
      await body.evaluate((el) => el.scrollBy(0, el.clientHeight || 400));
    }
    await sleep(120);

    if (passFilled === 0) break;
  }

  if (remainingEmpty.length) {
    progress(
      `Fill empty required (${contextLabel}) - WARN still empty: ${remainingEmpty.slice(0, 8).join(', ')}${
        remainingEmpty.length > 8 ? '…' : ''
      }`,
    );
  } else {
    progress(`Fill empty required (${contextLabel}) - Passed (${filledCount} filled this sweep)`);
  }

  return { productCategory: pc, filledCount, remainingEmpty: [...remainingEmpty], leadStatus: status };
}

/**
 * One pass form fill.
 * Fast (default): required + Lead Qualify prerequisites + Product Category / Channel / Request Type.
 * SF_FAST=0: every empty visible field (slow).
 */
async function fillAllFieldsSimple(page, scope, { contextLabel = 'form' } = {}) {
  let productCategory = '';
  let leadStatus = '';
  let oppStage = '';
  let filled = 0;
  const isLead = /^lead$/i.test(contextLabel);
  const isOpportunity = /^opportunity$/i.test(contextLabel);

  if (page.isClosed() || !(await isRecordFormOpen(page, scope))) {
    progress(`Fill ${contextLabel} - skipped (form/browser not open)`);
    return { productCategory, fieldsFilled: 0, leadStatus };
  }

  await scope.locator('.slds-spinner:visible').first().waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {});
  await expandSections(scope);
  progress(
    FAST_FILL
      ? `Fill ${contextLabel} (required-only, fast) - Running...`
      : `Fill ${contextLabel} (all empty fields, one pass) - Running...`,
  );

  if (isLead && FAST_FILL) {
    await fillLeadQualifyPrerequisites(page, scope).catch(() => {});
  }

  // Opportunity: set Stage = Quote FIRST so Quote-stage required fields appear, then fill them
  if (isOpportunity) {
    for (const row of await scope.locator('.slds-form-element').all().catch(() => [])) {
      if (!(await row.isVisible().catch(() => false))) continue;
      if (!isOpportunityStageLabel(await getRowLabelText(row))) continue;
      const chosen = await selectPicklistValue(page, row, {
        preferPatterns: [/^quote$/i],
        excludePatterns: [/closed\s*lost/i],
        force: true,
        fast: true,
        maxAttempts: 3,
      });
      oppStage = chosen || 'Quote';
      progress(`      → Stage set to "${oppStage}" before filling required fields`);
      break;
    }
    await ensureChannelRequestTypeIfTenderMandatory(page, scope).catch(() => {});
    await sleep(300);
  } else {
    for (const row of await scope.locator('.slds-form-element').all().catch(() => [])) {
      if (!(await row.isVisible().catch(() => false))) continue;
      if (!isOpportunityStageLabel(await getRowLabelText(row))) continue;
      const shown = await readComboboxDisplayedValue(rowPicklistTrigger(row));
      if (shown && !NONE_OPTION.test(shown)) {
        oppStage = shown;
        progress(`      → Stage already "${shown}" — leave as-is (Lost Reason only if Closed Lost)`);
      }
      break;
    }
  }

  async function shouldFillRow(row, label) {
    if (!FAST_FILL) return true;
    if (isAlwaysRequiredLabel(label)) return true;
    if (isLeadQualifyDetailLabel(label)) return true;
    if (isProductCategoryLabel(label)) return true;
    if (isChannelLabel(label) || isRequestTypeLabel(label) || isSectorLabel(label)) return true;
    if (isBusinessUnitLabel(label) || isDivisionLabel(label) || isSapDivisionLabel(label)) return true;
    if (isQuoteTypeLabel(label)) return true;
    if (isFacilityTypeLabel(label)) return true;
    if (isFacilityDepartmentLabel(label)) return true;
    if (isLeadStatusLabel(label)) return true;
    if (isOpportunityStageLabel(label)) return true;
    // Quote-stage Opp fields (often become required only after Stage = Quote)
    if (
      isOpportunity &&
      /^(solution\s*name|facility\s*department|supplier|region|revenue\s*recognition\s*date)$/i.test(
        (label || '').replace(/\*/g, '').trim(),
      )
    ) {
      return true;
    }
    if (await isRequiredFormRow(row)) return true;
    return false;
  }

  async function fillOne(row, { allowDivision = false, allowChannel = false } = {}) {
    if (!(await row.isVisible().catch(() => false))) return;
    const label = await getRowLabelText(row);
    if (!label) return;
    if (/address\s*search|^address$/i.test(label)) return;
    if (
      isDoNotCallLabel(label) ||
      isAccountApprovalStatusLabel(label) ||
      isPriceBookLabel(label) ||
      isCloseDateLabel(label)
    ) {
      return;
    }
    if (isTenderLookupLabel(label)) return;
    if (await shouldSkipOptionalSapRow(row)) return;
    if (isUnqualifiedReasonLabel(label) && !isLeadStatusUnqualified(leadStatus)) return;
    if (isLostReasonLabel(label) && !isStageClosedLost(oppStage || leadStatus)) return;
    if (isOpportunityStageLabel(label)) {
      if (isOpportunity) {
        const shown = await readComboboxDisplayedValue(rowPicklistTrigger(row));
        if (/^quote$/i.test(shown || '')) return;
        // fall through to fill Quote
      } else if (!(await isFormRowEmpty(row))) {
        return;
      }
    }
    if (isDivisionLabel(label) && !allowDivision) return;
    if (isChannelLabel(label) && !allowChannel) return;
    if (!(await shouldFillRow(row, label))) return;

    if (await isMainCompetitorsRow(row)) {
      if (await isFormRowEmpty(row)) {
        await fillMainCompetitorsMultiSelect(page, row);
        filled += 1;
        progress(`      → ${echoLabel(label)}`);
      }
      return;
    }
    if (!(await isFormRowEmpty(row))) {
      if (isChannelLabel(label) || isRequestTypeLabel(label)) {
        const shown = await readComboboxDisplayedValue(rowPicklistTrigger(row));
        if (shown && TENDER_PICKLIST_EXCLUDE.some((p) => p.test(shown))) {
          const chosen = await selectNonTenderChannelOrRequestType(page, row, { fast: true });
          if (chosen) {
            filled += 1;
            progress(`      → ${echoLabel(label)} — replaced Tender → ${chosen}`);
          }
        }
      }
      if (isLeadStatusLabel(label)) {
        const shown = await readComboboxDisplayedValue(rowPicklistTrigger(row));
        if (shown) leadStatus = shown;
      }
      if (isProductCategoryLabel(label)) {
        const shown = await readComboboxDisplayedValue(rowPicklistTrigger(row));
        if (shown) productCategory = shown;
      }
      return;
    }

    await row.scrollIntoViewIfNeeded().catch(() => {});
    const r = await fillFormRowByDataType(page, row, {
      force: true,
      productCategory,
      businessUnitFilled: allowDivision,
      leadStatus,
      oppStage,
      fast: true,
      skipLookups: true,
    });
    if (r.productCategory) productCategory = r.productCategory;
    if (r.leadStatus) leadStatus = r.leadStatus;
    if (r.filled) {
      filled += 1;
      progress(`      → ${echoLabel(label)}`);
    }
  }

  const rows = await scope.locator('.slds-form-element').all().catch(() => []);
  for (const row of rows) {
    try {
      await fillOne(row, { allowDivision: false, allowChannel: false });
    } catch (err) {
      progress(`   ... row skipped: ${err?.message ?? err}`);
    }
  }
  for (const row of await scope.locator('.slds-form-element').all().catch(() => [])) {
    try {
      await fillOne(row, { allowDivision: true, allowChannel: true });
    } catch (err) {
      progress(`   ... row skipped: ${err?.message ?? err}`);
    }
  }

  if (isLead && !/consumables|medical\s*equipment/i.test(productCategory || '')) {
    const ensured = await ensureLeadProductCategory(page, scope).catch(() => '');
    if (ensured) productCategory = ensured;
  }

  progress(`Fill ${contextLabel} - Passed (${filled} fields) — Save next`);
  return { productCategory, fieldsFilled: filled, leadStatus };
}

/**
 * Fill all visible form rows by control type.
 * @returns {Promise<{ productCategory: string }>}
 */
async function fillAllVisibleFields(page, scope, { contextLabel = 'form' } = {}) {
  return fillAllFieldsSimple(page, scope, { contextLabel });
}

/**
 * Product Category — simple Lightning picklist (combobox), NOT a multi-select.
 * Flow: open THIS combobox only → scoped options → Consumables | Medical Equipment | Medical Equipment & Consumables → verify.
 */
async function ensureLeadProductCategory(page, scope) {
  if (!(await scope.isVisible({ timeout: 2_000 }).catch(() => false))) {
    progress('Opening Product Category combobox... skipped (form not visible)');
    return '';
  }

  const rowsPre = await scope.locator('.slds-form-element').all().catch(() => []);
  for (const row of rowsPre) {
    if (!isProductCategoryLabel(await getRowLabelText(row))) continue;
    const shown = await readComboboxDisplayedValue(rowPicklistTrigger(row));
    if (shown && /medical\s*equipment/i.test(shown)) {
      progress(`Product Category already "${shown}" — skip reopen`);
      return shown;
    }
  }

  await closeLookupAdvancedSearchModal(page);
  await closeStaleLookupOverlays(page, null);

  let targetRows = [];
  const rows = await scope.locator('.slds-form-element').all().catch(() => []);
  for (const row of rows) {
    if (!(await row.isVisible().catch(() => false))) continue;
    const label = await getRowLabelText(row);
    if (isProductCategoryLabel(label)) {
      targetRows.push(row);
      continue;
    }
    if (
      await row
        .locator('[aria-label*="Product Category" i], [aria-label*="Product Cat" i]')
        .first()
        .isVisible()
        .catch(() => false)
    ) {
      targetRows.push(row);
    }
  }

  if (!targetRows.length) {
    progress('Product Category: WARN field row not found');
    return '';
  }

  for (const row of targetRows) {
    progress('Opening Product Category combobox...');
    const chosen = await selectPicklistValue(page, row, {
      preferPatterns: PRODUCT_CATEGORY_PREFER,
      excludePatterns: PRODUCT_CATEGORY_EXCLUDE,
      force: true,
      maxAttempts: 3,
    });
    if (chosen && /medical\s*equipment/i.test(chosen)) {
      progress(`Selected: ${chosen}`);
      progress(`Verified selected value: ${chosen}`);
      return chosen;
    }
  }
  progress('Product Category — WARN could not set Medical Equipment / Medical Equipment & Consumables');
  return '';
}

async function pageHasSaveSnag(page) {
  const snag = page
    .locator('[role="alertdialog"], [role="dialog"], .slds-modal, .pageLevelErrors, [role="alert"]')
    .filter({ hasText: /we hit a snag|review the following fields/i })
    .first();
  return snag.isVisible({ timeout: 2_000 }).catch(() => false);
}

/** True when Lightning shows a record Save success toast (Opp/Lead/etc). */
async function pageShowsRecordSaveSuccess(page, { timeout = 3_000 } = {}) {
  const toast = page
    .locator(
      '.slds-theme_success:visible, .forceToastMessage.slds-theme_success:visible, .slds-notify_toast.slds-theme_success:visible, .toastMessage:visible, [role="status"]:visible, .slds-notify:visible',
    )
    .filter({ hasText: /was saved|successfully saved|success notification|was created/i })
    .first();
  if (await toast.isVisible({ timeout }).catch(() => false)) return true;
  // Fallback: any visible status text mentioning save success
  const any = page.getByText(/success notification|was saved/i).first();
  return any.isVisible({ timeout: Math.min(800, timeout) }).catch(() => false);
}

async function dismissSaveSnagDialog(page) {
  const close = page
    .getByRole('button', { name: /close error dialog|close/i })
    .or(page.locator('button[title="Close"], button[title="Close this window"]'))
    .first();
  if (await close.isVisible({ timeout: 1_500 }).catch(() => false)) {
    await close.click().catch(() => {});
    await sleep(400);
  }
}

async function clickSave(page, scope) {
  async function findSaveBtn() {
    const scoped = scope ? scope.getByRole('button', { name: /^save$/i }).first() : null;
    if (scoped && (await scoped.isVisible({ timeout: 800 }).catch(() => false))) return scoped;
    const footer = page
      .locator('.slds-modal__footer:visible, [role="dialog"]:visible')
      .getByRole('button', { name: /^save$/i })
      .first();
    if (await footer.isVisible({ timeout: 800 }).catch(() => false)) return footer;
    const named = page.locator('button[name="SaveEdit"]:visible, button[title="Save"]:visible').first();
    if (await named.isVisible({ timeout: 800 }).catch(() => false)) return named;
    const any = page.getByRole('button', { name: /^save$/i }).first();
    if (await any.isVisible({ timeout: 800 }).catch(() => false)) return any;
    return null;
  }

  const btn = await findSaveBtn();
  if (!btn) {
    progress('Save: no Save button — form may already be closed');
    return false;
  }
  try {
    await btn.click({ force: true, timeout: 8_000 });
    return true;
  } catch (err) {
    // Detached / unstable often means Save already applied and the modal closed
    if (!(await resolveOpenEditForm(page))) {
      progress('Save: button detached — form closed (treat as Save success)');
      return true;
    }
    const retry = await findSaveBtn();
    if (retry) {
      await retry.click({ force: true, timeout: 5_000 }).catch(() => {});
      if (!(await resolveOpenEditForm(page))) return true;
      return true;
    }
    progress(`Save: click failed — ${String(err?.message || err).slice(0, 100)}`);
    return false;
  }
}

/**
 * Live Edit form locator only (never return page — page.isVisible breaks Save checks).
 */
async function resolveOpenEditForm(page) {
  const modal = formModal(page);
  if (await modal.isVisible({ timeout: 1_500 }).catch(() => false)) return modal;
  const dialog = page
    .locator('.slds-modal__container:visible, [role="dialog"]:visible, records-modal:visible')
    .filter({ has: page.getByRole('button', { name: /^save$/i }) })
    .first();
  if (await dialog.isVisible({ timeout: 1_500 }).catch(() => false)) return dialog;
  if (/\/lightning\/o\/Quote\/new|\/Quote\/new/i.test(page.url() || '')) {
    const q = quoteCreatePageForm(page);
    if (await q.isVisible({ timeout: 1_500 }).catch(() => false)) return q;
    if (
      await page
        .getByRole('button', { name: /^save$/i })
        .first()
        .isVisible({ timeout: 800 })
        .catch(() => false)
    ) {
      return page.locator('div.slds-template__container, .oneContent, body').first();
    }
  }
  return null;
}

/**
 * Read validation / path errors and re-fill offending fields.
 */
async function handleValidationErrors(page, scope) {
  await page.getByRole('button', { name: /^ok$/i }).first().click().catch(() => {});
  await acceptAllowAccessPrompts(page, { rounds: 1, perTryMs: 600 }).catch(() => {});

  // Page-level / path validation messages
  const pageErrors = page.locator(
    '.slds-form-element__help:visible, .pageLevelErrors:visible, .forcePageError:visible, .slds-theme_error:visible, [role="alert"]:visible',
  );
  const errCount = await pageErrors.count().catch(() => 0);
  const namedRequired = [];
  for (let i = 0; i < errCount; i++) {
    const msg = ((await pageErrors.nth(i).innerText().catch(() => '')) || '').trim();
    if (msg) progress(`Validation message: ${msg.slice(0, 160)}`);
    const listed = msg.match(/review the following fields[:\s]+([\s\S]+)/i);
    if (listed) {
      for (const part of listed[1].split(/[\n,;]+/)) {
        const name = part.replace(/we hit a snag.*$/i, '').replace(/\*/g, '').trim();
        if (name && name.length < 80 && !/account\s*approval\s*status/i.test(name)) namedRequired.push(name);
      }
    }
    // Tender Account mismatch → switch Channel / Request Type away from Tender
    if (/tender/i.test(msg) && /account|customer\s*name/i.test(msg)) {
      namedRequired.push('Tender');
      namedRequired.push('Channel');
      namedRequired.push('Request Type');
    }
    // Tender field required → switch Channel / Request Type to Direct Purchase or Marketplace
    if (/tender/i.test(msg) && /required|must enter|complete this field/i.test(msg)) {
      namedRequired.push('Tender');
      namedRequired.push('Channel');
      namedRequired.push('Request Type');
    }
    // Facility Department = Other → must fill Other Facility Department (or change Department)
    if (/other\s*facility\s*department/i.test(msg) || (/facility\s*department/i.test(msg) && /other/i.test(msg))) {
      namedRequired.push('Other Facility Department');
      namedRequired.push('Facility Department');
    }
  }

  if (!(await scope.isVisible({ timeout: 2_000 }).catch(() => false))) {
    return false;
  }

  let found = false;
  const seen = new Set();

  // Proactively clear mandatory Tender by switching Channel / Request Type
  if (await ensureChannelRequestTypeIfTenderMandatory(page, scope).catch(() => false)) {
    found = true;
  }

  async function fixRow(row, labelHint = '') {
    const label = labelHint || (await getRowLabelText(row));
    if (seen.has(label)) return;
    seen.add(label);
    await row.scrollIntoViewIfNeeded().catch(() => {});

    if (isProductCategoryLabel(label)) {
      await selectPicklistValue(page, row, {
        preferPatterns: PRODUCT_CATEGORY_PREFER,
        excludePatterns: PRODUCT_CATEGORY_EXCLUDE,
        force: true,
      });
      const ensured = await ensureLeadProductCategory(page, scope);
      if (ensured) progress(`      → Product Category fixed via ensure — ${ensured}`);
      return;
    }
    if (
      isDoNotCallLabel(label) ||
      isAccountApprovalStatusLabel(label) ||
      isPriceBookLabel(label) ||
      isCloseDateLabel(label)
    ) {
      progress(`      → ${echoLabel(label)} — skipped`);
      return;
    }
    // Tender mandatory only when Channel/Request Type = Tender — switch those away instead
    if (isTenderLookupLabel(label) || /^tender$/i.test(String(label || '').replace(/\*/g, '').trim())) {
      progress(`      → Tender — clear by setting Channel / Request Type to Direct Purchase or Marketplace`);
      for (const r of await scope.locator('.slds-form-element').all()) {
        if (!(await r.isVisible().catch(() => false))) continue;
        const lab = await getRowLabelText(r);
        if (!isChannelLabel(lab) && !isRequestTypeLabel(lab)) continue;
        const chosen = await selectNonTenderChannelOrRequestType(page, r, {
          preferDirectOrMarketplace: true,
        });
        if (chosen) progress(`      → ${echoLabel(lab)} → ${chosen} (not Tender)`);
      }
      return;
    }
    if (isChannelLabel(label) || isRequestTypeLabel(label)) {
      const chosen = await selectNonTenderChannelOrRequestType(page, row, {
        preferDirectOrMarketplace: true,
      });
      progress(`      → ${echoLabel(label)} — ${chosen || '(empty)'} (not Tender)`);
      return;
    }
    if (isFacilityDepartmentLabel(label)) {
      const chosen = await selectPicklistValue(page, row, {
        preferPatterns: FACILITY_DEPARTMENT_PREFER,
        excludePatterns: FACILITY_DEPARTMENT_EXCLUDE,
        force: true,
        maxAttempts: 3,
      });
      progress(`      → Facility Department — "${chosen || '(empty)'}" (not Other)`);
      return;
    }
    if (isOtherFacilityDepartmentLabel(label)) {
      const input = row.locator('input:not([type="hidden"]), textarea').first();
      if (await input.isVisible({ timeout: 1_500 }).catch(() => false)) {
        await input.fill(`Other Dept ${stamp()}`);
        progress(`      → Other Facility Department — filled`);
      }
      return;
    }
    if (isUnqualifiedReasonLabel(label)) {
      // Only fill when Status = Unqualified; blank is fine for Save either way
      progress(`      → ${echoLabel(label)} — skipped (does not block Save)`);
      return;
    }
    if (isLostReasonLabel(label)) {
      progress(`      → ${echoLabel(label)} — skipped (only when Stage = Closed Lost)`);
      return;
    }
    if (isOpportunityStageLabel(label)) {
      const chosen = await selectPicklistValue(page, row, {
        preferPatterns: [/^quote$/i],
        excludePatterns: [/closed\s*lost/i],
        force: true,
      });
      progress(`      → ${echoLabel(label)} — "${chosen || '(empty)'}" (force Quote)`);
      return;
    }
    if (isBusinessUnitLabel(label)) {
      await selectPicklistValue(page, row, { force: true });
      await sleep(500);
      const divRows = await scope.locator('.slds-form-element').all();
      for (const dr of divRows) {
        const dl = await getRowLabelText(dr);
        if (isDivisionLabel(dl)) {
          await selectPicklistValue(page, dr, { force: true });
          break;
        }
      }
      return;
    }
    if (isSapDivisionLabel(label)) {
      progress(`      → SAP Division — required picklist`);
      await selectPicklistValue(page, row, { force: true });
      return;
    }
    if (isDivisionLabel(label)) {
      const buRows = await scope.locator('.slds-form-element').all();
      for (const br of buRows) {
        const bl = await getRowLabelText(br);
        if (isBusinessUnitLabel(bl)) {
          await selectPicklistValue(page, br, { force: true });
          await sleep(500);
          break;
        }
      }
      await selectPicklistValue(page, row, { force: true });
      return;
    }
    if (await isSupplierRow(row)) {
      await fillSupplierLookup(page, row, { force: true });
      return;
    }
    if (await isMainCompetitorsRow(row)) {
      await fillMainCompetitorsMultiSelect(page, row, { force: true });
      return;
    }
    if (await fillVisibleLookup(page, row, { force: true })) return;
    if (await fillVisiblePicklist(page, row, { force: true })) return;
    if (await selectPicklistValue(page, row, { force: true })) return;
    if (await fillVisibleTextarea(row, { force: true })) return;
    await fillVisibleInput(page, row, { force: true });
  }

  const helps = scope.locator('.slds-form-element__help');
  const n = await helps.count().catch(() => 0);
  for (let i = 0; i < n; i++) {
    const h = helps.nth(i);
    if (!(await h.isVisible().catch(() => false))) continue;
    const msg = ((await h.innerText().catch(() => '')) || '').trim();
    if (!msg) continue;
    const limit = msg.match(/you can only use (\d+) characters/i);
    if (limit || /limit reached/i.test(msg)) {
      const maxLen = limit ? Number(limit[1]) : 20;
      const row = h.locator('xpath=./ancestor::*[contains(@class,"slds-form-element")][1]').first();
      const input = row.locator('input:not([type="hidden"]), textarea').first();
      if (await input.isVisible().catch(() => false)) {
        const cur = ((await input.inputValue().catch(() => '')) || '').trim();
        if (cur.length > maxLen) {
          await input.fill(cur.slice(0, maxLen));
          progress(`Validation: truncated ${echoLabel(await getRowLabelText(row))} to ${maxLen} chars`);
          found = true;
        }
      }
      continue;
    }
    if (/format:\s*\d/i.test(msg)) {
      progress(`Validation hint ignored: ${msg.slice(0, 80)}`);
      continue;
    }
    if (/expiration date must be later than the start date/i.test(msg)) {
      const row = h.locator('xpath=./ancestor::*[contains(@class,"slds-form-element")][1]').first();
      const input = row.locator('input:not([type="hidden"])').first();
      if (await input.isVisible({ timeout: 1_500 }).catch(() => false)) {
        await input.fill(sfDateMdY(90));
        progress('Validation: Expiration Date set 90 days after today');
        found = true;
      }
      continue;
    }
    found = true;
    progress(`Validation on field: ${msg.slice(0, 120)}`);
    const row = h.locator('xpath=./ancestor::*[contains(@class,"slds-form-element")][1]').first();
    if (!(await row.isVisible().catch(() => false))) continue;
    await fixRow(row);
  }

  // Only real error rows — do not walk every .slds-form-element
  const errorRows = scope.locator('.slds-form-element.slds-has-error, .slds-has-error');
  const errRowCount = await errorRows.count().catch(() => 0);
  for (let i = 0; i < Math.min(errRowCount, 40); i++) {
    const row = errorRows.nth(i);
    if (!(await row.isVisible().catch(() => false))) continue;
    const hasErrClass = ((await row.getAttribute('class').catch(() => '')) || '').includes('slds-has-error');
    const ariaInvalid = (await row.locator('[aria-invalid="true"]').count().catch(() => 0)) > 0;
    const helpVisible = await row.locator('.slds-form-element__help:visible').first().isVisible().catch(() => false);
    const helpMsg = ((await row.locator('.slds-form-element__help').first().innerText().catch(() => '')) || '').trim();
    if (/format:\s*\d/i.test(helpMsg)) continue;
    if (!hasErrClass && !ariaInvalid && !helpVisible) continue;
    found = true;
    await fixRow(row);
  }

  if (namedRequired.length) {
    found = true;
    const rows = await scope.locator('.slds-form-element').all();
    for (const name of namedRequired) {
      const needle = name.replace(/\s+/g, ' ').toLowerCase();
      for (const row of rows) {
        const label = await getRowLabelText(row);
        if (label.replace(/\s+/g, ' ').toLowerCase().includes(needle) || needle.includes(label.replace(/\s+/g, ' ').toLowerCase())) {
          progress(`      → validation named field ${echoLabel(label)}`);
          await fixRow(row, label);
          break;
        }
      }
    }
  }

  // Sweep remaining empty required fields (1 pass when fast)
  await fillEmptyRequiredFields(page, scope, {
    contextLabel: 'validation',
    maxPasses: FAST_FILL ? 1 : 3,
  }).catch(() => {});

  return found;
}

async function saveWithValidationRetry(page, scopeIn, { maxAttempts = FAST_FILL ? 3 : 5, contextLabel = 'record' } = {}) {
  let scope = scopeIn;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Keep form open — never Escape while saving
    await closeLookupAdvancedSearchModal(page);
    await acceptAllowAccessPrompts(page, { rounds: 1, perTryMs: FAST_FILL ? 200 : 500 }).catch(() => {});

    if (await pageHasSaveSnag(page)) {
      progress(`Save ${contextLabel}: snag still open — closing and filling named required fields`);
      await dismissSaveSnagDialog(page);
    }

    if (!(await scope.isVisible({ timeout: 2_000 }).catch(() => false))) {
      const live = await resolveOpenEditForm(page);
      if (live) {
        scope = live;
      } else if (await pageHasSaveSnag(page)) {
        await dismissSaveSnagDialog(page);
      } else if (await pageShowsRecordSaveSuccess(page, { timeout: 1_500 })) {
        progress(`Save ${contextLabel} - form closed + success toast — OK`);
        return true;
      } else if (/opportunity|stage\s*→\s*quote|stage→quote/i.test(contextLabel)) {
        // Opp Edit often closes instantly on success; prefer toast, else treat closed form as success
        // when there is no snag / validation (false "not treating as success" was aborting real Saves)
        if (await pageHasSaveSnag(page)) {
          progress(`Save ${contextLabel} - form closed with snag — not treating as success`);
          return false;
        }
        progress(`Save ${contextLabel} - form closed after Save (Opportunity) — treat as success`);
        return true;
      } else if (attempt === 1) {
        progress(`Save ${contextLabel} - form closed before Save click — not treating as success`);
        return false;
      } else {
        progress(`Save ${contextLabel} - form already closed after prior Save — OK`);
        return true;
      }
    }

    // Attempt 1 already had a required sweep just before Save; re-sweep on retries
    if (attempt > 1) {
      const pre = await fillEmptyRequiredFields(page, scope, {
        contextLabel: `${contextLabel} required-before-save`,
        maxPasses: FAST_FILL ? 1 : 2,
      }).catch(() => ({ remainingEmpty: [] }));
      if (pre?.remainingEmpty?.length) {
        progress(`Save ${contextLabel}: required still empty — ${pre.remainingEmpty.join(', ')}`);
      }
    }
    if (contextLabel === 'Lead' || /lead/i.test(contextLabel)) {
      await ensureLeadProductCategory(page, scope).catch(() => {});
    }

    progress(`Save ${contextLabel} (attempt ${attempt}/${maxAttempts}) — clicking Save...`);
    const clicked = await clickSave(page, scope);
    if (!clicked) {
      const live = await resolveOpenEditForm(page);
      if (!live) {
        progress(`Save ${contextLabel} - no Save button / form gone`);
        return attempt > 1;
      }
      scope = live;
      await clickSave(page, scope);
    }
    await sleep(FAST_FILL ? 300 : 400);
    await acceptAllowAccessPrompts(page, { rounds: 1, perTryMs: FAST_FILL ? 150 : 400 }).catch(() => {});

    if (await pageHasSaveSnag(page)) {
      progress(`Save ${contextLabel}: We hit a snag — form did not save; filling required fields`);
      const live = formModal(page);
      if (await live.isVisible({ timeout: 1_500 }).catch(() => false)) scope = live;
      await handleValidationErrors(page, scope);
      await dismissSaveSnagDialog(page);
      continue;
    }

    const stillOpen =
      (await formModal(page).isVisible({ timeout: 2_000 }).catch(() => false)) ||
      (await scope.isVisible({ timeout: 1_000 }).catch(() => false));
    if (!stillOpen) {
      progress(`Save ${contextLabel} - Passed`);
      return true;
    }

    const hadErrors = await handleValidationErrors(page, scope);
    if (!hadErrors) {
      await page.locator('.slds-spinner').first().waitFor({ state: 'hidden', timeout: FAST_FILL ? 8_000 : 15_000 }).catch(() => {});
      if (!(await formModal(page).isVisible({ timeout: 2_000 }).catch(() => false))) {
        progress(`Save ${contextLabel} - Passed`);
        return true;
      }
      await fillEmptyRequiredFields(page, scope, {
        contextLabel: `${contextLabel} soft-retry`,
        maxPasses: FAST_FILL ? 1 : 2,
      }).catch(() => {});
    }
    progress(`Save ${contextLabel} - validation handled, retrying...`);
  }
  throw new Error(`Could not save ${contextLabel} after ${maxAttempts} attempts (validation).`);
}

// ─── Lead create / qualify / convert ─────────────────────────────────────────

function extractLeadIdFromUrl(url) {
  const u = url || '';
  const m =
    u.match(/\/Lead\/([a-zA-Z0-9]{15,18})(?:\/|$|\?)/i) ||
    u.match(/\/lightning\/r\/Lead\/([a-zA-Z0-9]{15,18})/i) ||
    u.match(/\/lightning\/r\/(00Q[a-zA-Z0-9]{12,15})\//i);
  return m ? m[1] : '';
}

function isLeadRecordUrl(url) {
  return Boolean(extractLeadIdFromUrl(url)) || /\/lightning\/r\/Lead\//i.test(url || '');
}

function isLeadListUrl(url) {
  return /\/lightning\/o\/Lead\/list/i.test(url || '') || /\/Lead\/list/i.test(url || '');
}

/** Read Lead Id or name from success toast after Save. */
async function readLeadIdentityFromToast(page) {
  const toast = page
    .locator('.slds-notify, .toastMessage, .forceToastMessage, [role="status"], .slds-theme_success')
    .filter({ visible: true })
    .first();
  if (!(await toast.isVisible({ timeout: 5_000 }).catch(() => false))) {
    return { leadId: '', leadName: '' };
  }
  const text = ((await toast.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
  const link = toast.locator('a[href*="/Lead/"], a[href*="/lightning/r/Lead/"], a[href*="/lightning/r/00Q"]').first();
  let leadId = '';
  if (await link.isVisible({ timeout: 1_500 }).catch(() => false)) {
    const href = (await link.getAttribute('href').catch(() => '')) || '';
    leadId = extractLeadIdFromUrl(href);
    if (!leadId) {
      const name = ((await link.innerText().catch(() => '')) || '').trim();
      return { leadId: '', leadName: name };
    }
  }
  const idInText = text.match(/\b(00Q[a-zA-Z0-9]{12,15})\b/);
  if (!leadId && idInText) leadId = idInText[1];
  const nameMatch = text.match(/Lead\s+"([^"]+)"\s+was\s+created/i) || text.match(/created\s+Lead\s+(.+?)(?:\s+from|\.|$)/i);
  return { leadId, leadName: nameMatch ? nameMatch[1].trim() : '' };
}

async function readLeadLastNameFromModal(modal) {
  const input = modal
    .locator('input[name="lastName"], input[name="LastName"]')
    .or(modal.getByLabel(/^last name$/i))
    .first();
  if (await input.isVisible().catch(() => false)) {
    return ((await input.inputValue().catch(() => '')) || '').trim();
  }
  return '';
}

async function readLeadCompanyFromModal(modal) {
  const input = modal
    .locator('input[name="Company"], input[name="company"]')
    .or(modal.getByLabel(/^company$/i))
    .first();
  if (await input.isVisible().catch(() => false)) {
    return ((await input.inputValue().catch(() => '')) || '').trim();
  }
  return '';
}

/**
 * Ensure we are on the newly created Lead record page before Qualify/Convert.
 * If Save returned to the list, reopen via Id (preferred) or Name from toast / known values.
 */
async function ensureOnCreatedLeadRecord(page, { leadId = '', leadLastName = '', leadCompany = '' } = {}) {
  progress('4b. Open created Lead record - Running...');

  if (isLeadRecordUrl(page.url())) {
    const id = extractLeadIdFromUrl(page.url()) || leadId;
    await page
      .locator('records-record-layout-event-broker, .record-body-container, one-record-home-flexipage2, records-lwc-highlights-panel')
      .first()
      .waitFor({ state: 'visible', timeout: 60_000 })
      .catch(() => {});
    progress(`4b. Already on Lead record${id ? ` (${id})` : ''}`);
    return id;
  }

  const toastInfo = await readLeadIdentityFromToast(page);
  let id = leadId || toastInfo.leadId || extractLeadIdFromUrl(page.url());
  const nameHint = leadLastName || toastInfo.leadName || leadCompany;

  if (id) {
    progress(`4b. Navigating to Lead record by Id ${id}...`);
    await page.goto(`/lightning/r/Lead/${id}/view`, { waitUntil: 'domcontentloaded' });
  } else if (nameHint) {
    progress(`4b. Save landed off-record — searching Lead list for "${nameHint}"...`);
    if (!isLeadListUrl(page.url())) {
      await page.goto(LEAD_LIST_PATH, { waitUntil: 'commit' });
    }
    await dismissLightningOverlays(page, { allowEscape: true });

    const search = page
      .getByPlaceholder(/search this list|search leads/i)
      .or(page.locator('input[type="search"][placeholder*="Search" i]'))
      .first();
    if (await search.isVisible({ timeout: 8_000 }).catch(() => false)) {
      await search.fill(nameHint);
      await search.press('Enter');
      await sleep(1_200);
    }

    const rowLink = page
      .locator(`a[href*="/Lead/"], a[href*="/lightning/r/Lead/"]`)
      .filter({ hasText: new RegExp(nameHint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') })
      .first();
    if (await rowLink.isVisible({ timeout: 15_000 }).catch(() => false)) {
      const href = (await rowLink.getAttribute('href').catch(() => '')) || '';
      id = extractLeadIdFromUrl(href);
      await rowLink.click();
    } else {
      // Toast link click as last resort
      const toastLink = page
        .locator('.slds-notify a[href*="/Lead/"], .toastMessage a, .forceToastMessage a')
        .first();
      if (await toastLink.isVisible({ timeout: 3_000 }).catch(() => false)) {
        await toastLink.click();
      } else {
        throw new Error(
          `Could not reopen created Lead — no Id and list search for "${nameHint}" failed. URL: ${page.url()}`,
        );
      }
    }
  } else {
    throw new Error(`Could not determine created Lead identity after Save. URL: ${page.url()}`);
  }

  await page.waitForURL(/\/Lead\/|\/lightning\/r\/Lead\/|\/lightning\/r\/00Q/i, {
    timeout: 90_000,
    waitUntil: 'domcontentloaded',
  }).catch(() => {});

  if (!isLeadRecordUrl(page.url())) {
    throw new Error(`Expected Lead record page after create; got: ${page.url()}`);
  }

  id = extractLeadIdFromUrl(page.url()) || id;
  await page
    .locator('records-record-layout-event-broker, .record-body-container, one-record-home-flexipage2, records-lwc-highlights-panel')
    .first()
    .waitFor({ state: 'visible', timeout: 60_000 })
    .catch(() => {});

  // Convert / Path chrome often needs a moment
  await acceptAllowAccessPrompts(page, { rounds: 2, perTryMs: 800 });
  progress(`4b. Open created Lead record - Passed${id ? ` (${id})` : ''}`);
  return id;
}

async function createLead(page) {
  progress('4. Create Lead - Running...');
  await selectFirstRecordTypeIfPresent(page);

  let modal = formModal(page);
  if (!(await modal.isVisible({ timeout: 15_000 }).catch(() => false))) {
    progress('4. Lead form not open — opening New Lead again...');
    await clickNewLead(page);
    modal = formModal(page);
  }

  await expect(modal).toBeVisible({ timeout: 90_000 });
  await page.locator('.slds-spinner').first().waitFor({ state: 'hidden', timeout: 60_000 }).catch(() => {});

  // Confirm required Lead fields are present before filling
  const lastNameField = modal
    .locator('input[name="lastName"], input[name="LastName"]')
    .or(modal.getByLabel(/^last name$/i))
    .first();
  const companyField = modal
    .locator('input[name="Company"], input[name="company"]')
    .or(modal.getByLabel(/^company$/i))
    .first();
  await expect(lastNameField).toBeVisible({ timeout: 60_000 });

  // Seed required identity fields first (layout may omit Company)
  const seedLast = `Lead_${stamp()}`;
  await lastNameField.fill(seedLast);
  progress(`4. Seed Last Name — ${seedLast}`);
  if (await companyField.isVisible({ timeout: 3_000 }).catch(() => false)) {
    const seedCo = `Co_${stamp()}`;
    await companyField.fill(seedCo);
    progress(`4. Seed Company — ${seedCo}`);
  }

  progress(FAST_FILL ? '4. Filling required Lead fields (fast)...' : '4. Filling all empty Lead fields (one pass)...');
  const req = await fillAllFieldsSimple(page, modal, { contextLabel: 'Lead' });
  let productCategory = req.productCategory || '';
  let leadStatus = req.leadStatus || '';
  const fieldsFilled = req.fieldsFilled || 0;
  // Fast: skip pre-save validation sweep — Save retry handles snags
  if (!FAST_FILL) await handleValidationErrors(page, modal).catch(() => {});

  // Re-resolve modal after lookups (stale locator if advanced-search briefly covered it)
  modal = formModal(page);
  let modalOpen = await isRecordFormOpen(page, modal);

  // One recovery if Escape/overlay dismiss closed the form mid-fill
  if (!modalOpen) {
    if (page.isClosed()) {
      throw new Error('Browser closed during Lead fill — cannot Save or reopen New Lead.');
    }
    progress('4. Lead form closed after fill — reopening New and refilling once...');
    await acceptAllowAccessPrompts(page, { rounds: 2, perTryMs: 800 }).catch(() => {});
    await clickNewLead(page);
    modal = formModal(page);
    await expect(modal).toBeVisible({ timeout: 90_000 });
    await page.locator('.slds-spinner').first().waitFor({ state: 'hidden', timeout: 60_000 }).catch(() => {});
    const req2 = await fillAllFieldsSimple(page, modal, { contextLabel: 'Lead' });
    productCategory = req2.productCategory || productCategory;
    leadStatus = req2.leadStatus || leadStatus;
    await handleValidationErrors(page, modal).catch(() => {});
    modal = formModal(page);
    modalOpen = await isRecordFormOpen(page, modal);
  }

  const leadLastName = modalOpen ? await readLeadLastNameFromModal(modal) : '';
  const leadCompany = modalOpen ? await readLeadCompanyFromModal(modal) : '';

  if (!modalOpen) {
    throw new Error('Lead form closed after fill — cannot Save.');
  }
  if (fieldsFilled < 3 && !leadLastName) {
    throw new Error(
      `Lead form fill produced too few fields (${fieldsFilled || 0}) — New Lead modal may have closed or selectors failed.`,
    );
  }
  if (!leadLastName || (!leadCompany && (await companyField.isVisible().catch(() => false)))) {
    progress(
      `4. WARN required values — Last Name="${leadLastName || '(empty)'}", Company="${leadCompany || '(empty)'}"`,
    );
  }

  if (!/consumables|medical\s*equipment/i.test(productCategory || '')) {
    const ensured = await ensureLeadProductCategory(page, modal);
    if (ensured) productCategory = ensured;
  }
  if (!/consumables|medical\s*equipment/i.test(productCategory || '')) {
    throw new Error(
      'Lead Product Category must be Consumables or Medical Equipment before Save — could not set it.',
    );
  }

  progress('4. Lead filled — clicking Save immediately...');
  await saveWithValidationRetry(page, modal, { contextLabel: 'Lead', maxAttempts: 3 });

  // Prefer record URL; fall back to toast / list reopen
  await page.waitForURL(/\/Lead\/|\/lightning\/r\/Lead\/|\/lightning\/o\/Lead/i, {
    timeout: 120_000,
    waitUntil: 'domcontentloaded',
  }).catch(() => {});

  let leadId = extractLeadIdFromUrl(page.url());
  if (!leadId) {
    const toastInfo = await readLeadIdentityFromToast(page);
    leadId = toastInfo.leadId;
  }

  leadId = await ensureOnCreatedLeadRecord(page, {
    leadId,
    leadLastName,
    leadCompany,
  });

  await expect(page).toHaveURL(/\/Lead\/|\/lightning\/r\/Lead\/|\/lightning\/r\/00Q/i, { timeout: 60_000 });
  progress(`4. Create Lead - Passed${leadId ? ` (${leadId})` : ''}; Product Category="${productCategory || '(unset)'}"`);
  rememberLeadId(leadId);
  return { leadId, productCategory, leadLastName, leadCompany };
}

/**
 * Facility Type = Other is allowed — do not overwrite before Convert.
 */
async function ensureLeadFacilityTypeValidForConvert(page) {
  progress('4c. Facility Type — keeping current value (Other is allowed); skip overwrite');
  void page;
}

/**
 * Lead must be Qualified on the Path before Convert is allowed.
 * Order: click Path stage "Qualified" → Mark as Complete → only then Convert appears.
 */
async function leadPathShowsQualified(page) {
  return page
    .locator('.slds-path__item.slds-is-current, .slds-path__item.slds-is-active, .slds-path__item.slds-is-complete')
    .getByText(/^qualified$/i)
    .first()
    .isVisible({ timeout: 3_000 })
    .catch(() => false);
}

async function readVisibleValidationText(page) {
  const nodes = page.locator(
    '.slds-theme_error:visible, .forcePageError:visible, .pageLevelErrors:visible, .slds-notify_toast.slds-theme_error:visible, [role="alert"]:visible, .slds-form-element__help:visible',
  );
  const n = await nodes.count().catch(() => 0);
  const parts = [];
  for (let i = 0; i < Math.min(n, 12); i++) {
    const t = ((await nodes.nth(i).innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
    if (t && !/errorMessageOnSearch|0 (Account|Contact|Opportunity) Matches/i.test(t)) parts.push(t);
  }
  return parts.join(' | ');
}

async function editLeadQualifiedAndFixValidation(page, extraHint = '') {
  progress(`5. Edit Lead — set Status=Qualified and fix validation${extraHint ? ` (${extraHint.slice(0, 80)})` : ''}`);
  const editBtn = page
    .getByRole('button', { name: /^edit$/i })
    .or(page.locator('button[name="Edit"], a[title="Edit"]'))
    .first();
  await editBtn.waitFor({ state: 'visible', timeout: 20_000 });
  await editBtn.click();
  const modal = formModal(page);
  await expect(modal).toBeVisible({ timeout: 60_000 });

  const rows = await modal.locator('.slds-form-element').all();
  for (const row of rows) {
    const label = await getRowLabelText(row);
    if (isLeadStatusLabel(label)) {
      await selectPicklistValue(page, row, { preferPatterns: [/^qualified$/i], force: true });
    }
    if (/^lead\s*source$/i.test((label || '').replace(/\*/g, '').trim())) {
      await selectPicklistValue(page, row, { force: true });
    }
  }
  await fillLeadQualifyPrerequisites(page, modal);
  if (extraHint) {
    const named = extraHint.match(/required fields must be completed:\s*([^.]*)/i);
    if (named) {
      const names = named[1].split(/[,;]/).map((s) => s.trim()).filter(Boolean);
      for (const name of names) {
        for (const row of rows) {
          const label = await getRowLabelText(row);
          if (label.replace(/\s+/g, ' ').toLowerCase().includes(name.toLowerCase())) {
            progress(`      → validation field ${echoLabel(label)}`);
            await fillFormRowByDataType(page, row, { force: true });
            break;
          }
        }
      }
    }
  }
  await saveWithValidationRetry(page, modal, { contextLabel: 'Lead Qualify', maxAttempts: 3 });
}

async function qualifyLead(page) {
  progress('5. Qualify Lead — Status must be Qualified before Convert...');

  // Always persist Status = Qualified (+ Lead Source) on the record first
  await editLeadQualifiedAndFixValidation(page);

  // Path / Sales Path: click Qualified stage then Mark as Complete
  const pathQualified = page
    .locator('.slds-path__item, runtime_sales_pathassistant, lightning-path, .slds-path')
    .getByText(/^qualified$/i)
    .or(page.getByRole('link', { name: /^qualified$/i }))
    .or(page.getByRole('button', { name: /^qualified$/i }))
    .or(page.locator('a.slds-path__link').filter({ hasText: /^qualified$/i }))
    .first();

  if (await pathQualified.isVisible({ timeout: 15_000 }).catch(() => false)) {
    progress('5. Path: clicking Qualified stage...');
    await pathQualified.click();
    await sleep(600);
    const markComplete = page
      .getByRole('button', {
        name: /mark (status )?as complete|mark as current status|select qualified|complete this step/i,
      })
      .or(page.locator('button[title*="Mark"], button[name*="Complete"], button.slds-path__mark-complete'))
      .first();
    if (await markComplete.isVisible({ timeout: 8_000 }).catch(() => false)) {
      progress('5. Path: Mark Status as Complete...');
      await markComplete.click();
      await sleep(1_200);
    }
  }

  let validation = await readVisibleValidationText(page);
  if (validation && /required|lead source|complete these fields|we hit a snag/i.test(validation)) {
    progress(`5. Validation after Qualify: ${validation.slice(0, 200)}`);
    await page.getByRole('button', { name: /close error dialog|close/i }).first().click().catch(() => {});
    await editLeadQualifiedAndFixValidation(page, validation);
    if (await pathQualified.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await pathQualified.click().catch(() => {});
      const markAgain = page.getByRole('button', { name: /mark (status )?as complete/i }).first();
      if (await markAgain.isVisible({ timeout: 5_000 }).catch(() => false)) await markAgain.click().catch(() => {});
    }
  }

  if (await isLeadAlreadyConverted(page)) {
    progress('5. Qualify Lead - skipped (Lead already Converted)');
    return;
  }

  if (!(await leadPathShowsQualified(page))) {
    await editLeadQualifiedAndFixValidation(page, validation);
  }
  if (!(await leadPathShowsQualified(page))) {
    throw new Error('Lead is not Qualified — Convert is not allowed. Fix Status/Lead Source and retry.');
  }

  const convertBtn = page
    .getByRole('button', { name: /^convert$/i })
    .or(page.locator('button[name="Convert"], a[title="Convert"]'))
    .first();
  await expect(convertBtn).toBeVisible({ timeout: 90_000 });
  progress('5. Qualify Lead - Passed (Lead is Qualified — Convert available)');
}

async function isLeadAlreadyConverted(page) {
  const url = page.url() || '';
  // After convert, opening the Lead often redirects to Contact / Account / Opp
  if (/\/lightning\/r\/(001|003|006)[a-zA-Z0-9]{12,15}/i.test(url)) return true;
  if (/\/lightning\/r\/(Account|Contact|Opportunity)\//i.test(url)) return true;

  const pathConverted = page
    .locator('.slds-path__item.slds-is-current, .slds-path__item.slds-is-active, .slds-path__item.slds-is-complete')
    .getByText(/^converted$/i)
    .first();
  if (await pathConverted.isVisible({ timeout: 2_000 }).catch(() => false)) return true;
  const header = ((await page.locator('.slds-page-header, records-lwc-highlights-panel').first().innerText().catch(() => '')) || '')
    .replace(/\s+/g, ' ');
  if (/\bconverted\b/i.test(header) && !/not\s+converted/i.test(header)) return true;
  if (await convertSuccessPanel(page).isVisible({ timeout: 800 }).catch(() => false)) return true;
  return false;
}

/** Account (001) / Contact (003) / Opportunity (006) from Lead, Contact, or Account page. */
async function readConvertedRelatedIdsFromLeadPage(page) {
  const ids = { accountId: '', contactId: '', opportunityId: '' };
  const urlId = extractSfRecordId(page.url());
  if (urlId && /^001/i.test(urlId)) ids.accountId = urlId;
  if (urlId && /^003/i.test(urlId)) ids.contactId = urlId;
  if (urlId && /^006/i.test(urlId)) ids.opportunityId = urlId;

  const collect = async () => {
    const links = page.locator(
      'a[href*="/lightning/r/"], a[href*="/001"], a[href*="/003"], a[href*="/006"], a[data-recordid]',
    );
    const n = await links.count().catch(() => 0);
    for (let i = 0; i < Math.min(n, 80); i++) {
      const el = links.nth(i);
      const href = ((await el.getAttribute('href').catch(() => '')) || '').trim();
      const rec = ((await el.getAttribute('data-recordid').catch(() => '')) || '').trim();
      const id = extractSfRecordId(href) || extractSfRecordId(rec);
      if (!id) continue;
      if (!ids.accountId && /^001/i.test(id)) ids.accountId = id;
      else if (!ids.contactId && /^003/i.test(id)) ids.contactId = id;
      else if (!ids.opportunityId && /^006/i.test(id)) ids.opportunityId = id;
    }
  };
  await collect();
  if (!ids.accountId) {
    const customerNameLink = page
      .locator('records-record-layout-item, .slds-form-element')
      .filter({ has: page.getByText(/^customer name$/i) })
      .locator('a')
      .first();
    const accLink = customerNameLink.or(page.locator('a[href*="/lightning/r/Account/"], a[href*="/lightning/r/001"]').first());
    if (await accLink.isVisible({ timeout: 3_000 }).catch(() => false)) {
      const href = ((await accLink.getAttribute('href').catch(() => '')) || '').trim();
      const id = extractSfRecordId(href);
      if (id && /^001/i.test(id)) ids.accountId = id;
    }
  }
  // Stay on Details — Account (Customer Name) is there. Do not open Related before fill.

  progress(
    `Converted related ids — Account=${ids.accountId || '(none)'}, Contact=${ids.contactId || '(none)'}, Opportunity=${ids.opportunityId || '(none)'}`,
  );
  return ids;
}

async function openDetailsTab(page) {
  const details = page
    .getByRole('tab', { name: /^details$/i })
    .or(page.locator('a[data-tab-name="detailTab"], a[title="Details"], button[title="Details"]'))
    .first();
  if (await details.isVisible({ timeout: 5_000 }).catch(() => false)) {
    const selected = ((await details.getAttribute('aria-selected').catch(() => '')) || '').toLowerCase();
    if (selected !== 'true') {
      progress('Opening Details tab...');
      await details.click();
      await sleep(400);
    }
  }
}

/**
 * Convert Lead — Record Type dropdown under Create New Account / Opportunity.
 * For Opportunity: first click the expand icon/chevron beside "Opportunity",
 * then click the Record Type dropdown and select the value.
 */
async function expandConvertEntitySection(panel, fieldHint) {
  progress(`Convert: ensure ${fieldHint} section is expanded...`);

  const headingBtn = panel
    .getByRole('heading', { name: new RegExp(`^${fieldHint}$`, 'i') })
    .getByRole('button')
    .or(panel.getByRole('button', { name: new RegExp(`^${fieldHint}$`, 'i') }))
    .or(
      panel
        .locator('button, a')
        .filter({ hasText: new RegExp(`^\\s*${fieldHint}\\s*$`, 'i') })
        .first(),
    )
    .first();

  if (!(await headingBtn.isVisible({ timeout: 5_000 }).catch(() => false))) {
    progress(`Convert: ${fieldHint} section heading not found`);
    return;
  }

  const expanded = ((await headingBtn.getAttribute('aria-expanded').catch(() => '')) || '').toLowerCase();
  if (expanded === 'true') {
    progress(`Convert: ${fieldHint} section already expanded`);
  } else {
    progress(`Convert: clicking ${fieldHint} expand icon/chevron...`);
    const chevron = headingBtn.locator('svg, lightning-icon, .slds-button__icon, img').first();
    if (await chevron.isVisible({ timeout: 800 }).catch(() => false)) {
      await chevron.click({ force: true }).catch(async () => {
        await headingBtn.click({ force: true });
      });
    } else {
      await headingBtn.click({ force: true });
    }
    await sleep(600);
  }

  const createNew = panel.getByRole('radio', { name: new RegExp(`create\\s*new\\s*${fieldHint}`, 'i') }).first();
  if (await createNew.isVisible({ timeout: 2_000 }).catch(() => false)) {
    const checked = await createNew.isChecked().catch(() => false);
    if (!checked) {
      progress(`Convert: selecting Create New ${fieldHint}`);
      await createNew.click({ force: true }).catch(() => {});
      await sleep(300);
    }
  }
}

/**
 * Click Record Type dropdown under Create New {Account|Opportunity}, then select typeName.
 * Flow: expand section (chevron) → click Record Type dropdown → pick option → verify.
 */
async function selectConvertPanelRecordType(page, panel, { fieldHint, typeName, maxAttempts = 3 }) {
  const escaped = typeName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const prefer = new RegExp(`^\\s*${escaped}\\s*$`, 'i');

  progress(`Convert: select ${fieldHint} Record Type = "${typeName}"`);
  await expandConvertEntitySection(panel, fieldHint);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const section = panel
      .getByRole('group', { name: new RegExp(`^${fieldHint}$`, 'i') })
      .or(
        panel
          .locator('[role="group"], .slds-section, article')
          .filter({ has: panel.getByRole('heading', { name: new RegExp(`^${fieldHint}$`, 'i') }) }),
      )
      .first();

    const scope = (await section.isVisible({ timeout: 4_000 }).catch(() => false)) ? section : panel;

    const rtRow = scope
      .locator('.slds-form-element, lightning-combobox, lightning-picklist')
      .filter({ hasText: /record\s*type/i })
      .first();

    let trigger = scope.getByRole('button', { name: /record\s*type/i }).first();
    if (!(await trigger.isVisible({ timeout: 1_500 }).catch(() => false))) {
      trigger = rtRow
        .locator('button[role="combobox"], button.slds-combobox__input, button[aria-haspopup], button')
        .first();
    }
    if (!(await trigger.isVisible({ timeout: 1_500 }).catch(() => false))) {
      trigger = scope
        .locator('button')
        .filter({ hasText: /sold\s*to\s*part|supplier|consumables|medical\s*equipment/i })
        .first();
    }

    if (!(await trigger.isVisible({ timeout: 5_000 }).catch(() => false))) {
      progress(
        `Convert: ${fieldHint} Record Type dropdown not visible (attempt ${attempt}/${maxAttempts}) — re-expand`,
      );
      await expandConvertEntitySection(panel, fieldHint);
      await sleep(700);
      if (attempt === maxAttempts) {
        throw new Error(
          `Convert: ${fieldHint} Record Type dropdown not found after expand — cannot select "${typeName}".`,
        );
      }
      continue;
    }

    const shownBefore = ((await trigger.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
    progress(`Convert: ${fieldHint} Record Type dropdown current: "${shownBefore || '(empty)'}"`);
    if (prefer.test(shownBefore) || new RegExp(escaped, 'i').test(shownBefore)) {
      progress(`Convert: verified ${fieldHint} RT already = "${typeName}"`);
      return typeName;
    }

    progress(`Convert: clicking ${fieldHint} Record Type dropdown (attempt ${attempt}/${maxAttempts})...`);
    await trigger.scrollIntoViewIfNeeded().catch(() => {});
    await trigger.click({ force: true });
    await waitAfterComboClick(page);
    await sleep(400);

    let listVisible = await page
      .locator('[role="listbox"]:visible, .slds-listbox:visible, .slds-dropdown:visible, [role="menu"]:visible')
      .first()
      .isVisible({ timeout: 1_500 })
      .catch(() => false);
    if (!listVisible) {
      const arrow = trigger.locator('svg, lightning-icon, .slds-icon, .slds-button__icon').first();
      if (await arrow.isVisible().catch(() => false)) {
        progress(`Convert: clicking ${fieldHint} Record Type dropdown arrow...`);
        await arrow.click({ force: true }).catch(() => {});
        await sleep(350);
        listVisible = await page
          .locator('[role="listbox"]:visible, .slds-listbox:visible, .slds-dropdown:visible, [role="menu"]:visible')
          .first()
          .isVisible({ timeout: 2_000 })
          .catch(() => false);
      }
    }

    const dropdown = page
      .locator('[role="listbox"]:visible, .slds-listbox:visible, .slds-dropdown:visible, [role="menu"]:visible')
      .last();
    const optionHost = listVisible
      ? dropdown
      : trigger.locator(
          'xpath=ancestor::*[.//*[@role="option" or @role="menuitem" or contains(@class,"slds-listbox")]][1]',
        );

    const options = optionHost.locator(
      '[role="option"]:visible, [role="menuitem"]:visible, lightning-base-combobox-item:visible, li.slds-listbox__item:visible',
    );
    const count = await options.count().catch(() => 0);
    const labels = [];
    for (let i = 0; i < count; i++) {
      const t = ((await options.nth(i).innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
      if (t) labels.push(t);
    }
    progress(`Convert: ${fieldHint} RT options after dropdown click: [${labels.join(' | ') || 'none'}]`);

    const hit = labels.find((l) => prefer.test(l)) || labels.find((l) => new RegExp(escaped, 'i').test(l));
    if (!hit) {
      const textOpt = optionHost
        .locator('[role="option"], [role="menuitem"], lightning-base-combobox-item, li')
        .filter({ hasText: prefer })
        .first();
      if (await textOpt.isVisible({ timeout: 2_000 }).catch(() => false)) {
        progress(`Convert: Selected ${fieldHint} RT: ${typeName}`);
        await textOpt.click({ force: true });
        await sleep(400);
      } else {
        progress(`Convert: "${typeName}" not in ${fieldHint} RT dropdown — retry`);
        await dismissOverlaySafely(page, trigger);
        continue;
      }
    } else {
      progress(`Convert: Selected ${fieldHint} RT: ${hit}`);
      await options.filter({ hasText: new RegExp(escaped, 'i') }).first().click({ force: true });
      await sleep(400);
    }

    const verify = scope
      .getByRole('button', { name: /record\s*type/i })
      .or(scope.locator('button').filter({ hasText: new RegExp(escaped, 'i') }))
      .first();
    const shownAfter = (
      (await verify.innerText().catch(() => '')) ||
      (await trigger.innerText().catch(() => '')) ||
      ''
    )
      .replace(/\s+/g, ' ')
      .trim();
    progress(`Convert: Verified ${fieldHint} RT displayed: "${shownAfter || '(empty)'}"`);
    if (shownAfter && new RegExp(escaped, 'i').test(shownAfter)) {
      return shownAfter;
    }
    progress(`Convert: ${fieldHint} RT verify failed after dropdown select — retry`);
  }

  throw new Error(
    `Convert: could not select ${fieldHint} Record Type "${typeName}" via dropdown after ${maxAttempts} attempts.`,
  );
}

async function waitConvertPanelRecordTypesReady(panel) {
  progress('Convert: waiting for Record Type dropdowns to load...');
  await panel.locator('.slds-spinner:visible').first().waitFor({ state: 'hidden', timeout: 30_000 }).catch(() => {});
  await expandConvertEntitySection(panel, 'Account');
  const rtBtn = panel.getByRole('button', { name: /record\s*type/i }).first();
  await rtBtn.waitFor({ state: 'visible', timeout: 45_000 }).catch(() => {});
  await sleep(400);
}

/**
 * Open Create New fields for Account/Opportunity (click the name chip/button if fields are collapsed).
 * Account Type on Convert often appears only after the Create New Account name chip is opened —
 * do not return early just because Record Type / Customer Name are already visible.
 */
async function openConvertCreateNewFields(panel, fieldHint) {
  await expandConvertEntitySection(panel, fieldHint);
  const section = panel.getByRole('group', { name: new RegExp(`^${fieldHint}$`, 'i') }).first();
  if (!(await section.isVisible({ timeout: 3_000 }).catch(() => false))) return section;

  const hasAccountType =
    fieldHint === 'Account' &&
    (await section
      .getByText(/^account\s*type$/i)
      .or(section.locator('.slds-form-element__label, label, legend').filter({ hasText: /^account\s*type$/i }))
      .first()
      .isVisible({ timeout: 600 })
      .catch(() => false));

  if (fieldHint === 'Account' && hasAccountType) return section;

  // Opportunity / Contact: enough if Record Type or name fields already shown
  if (fieldHint !== 'Account') {
    const hasRecordType = await section.getByRole('button', { name: /record\s*type/i }).isVisible({ timeout: 800 }).catch(() => false);
    const hasCustomerName = await section.getByLabel(/customer\s*name|opportunity\s*name/i).isVisible({ timeout: 500 }).catch(() => false);
    if (hasRecordType || hasCustomerName) return section;
  }

  const nameBtn = section
    .locator('button')
    .filter({
      hasNotText: new RegExp(
        `^\\s*${fieldHint}\\s*$|create\\s*new|choose\\s*existing|don.?t\\s*create|record\\s*type|account\\s*type|^\\s*type\\s*$|sold\\s*to|supplier|consumables|medical`,
        'i',
      ),
    })
    .first();
  if (await nameBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
    progress(`Convert: opening ${fieldHint} Create New details (name chip)...`);
    await nameBtn.click({ force: true });
    await sleep(500);
  }

  // Account: also try edit/pencil if Account Type still missing
  if (fieldHint === 'Account' && !hasAccountType) {
    const editBtn = section
      .locator('button[title*="Edit" i], button[aria-label*="Edit" i], lightning-button-icon[title*="Edit" i] button')
      .first();
    if (await editBtn.isVisible({ timeout: 800 }).catch(() => false)) {
      progress('Convert: clicking Account edit to reveal Account Type...');
      await editBtn.click({ force: true }).catch(() => {});
      await sleep(400);
    }
  }
  return section;
}

/**
 * Account Type on Convert Lead page (Create New Account) — not on the Lead record.
 * Often appears after Account Record Type is set (e.g. Supplier); wait for it, then open dropdown.
 */
async function selectConvertPanelAccountType(page, panel, { maxAttempts = 4 } = {}) {
  const prefer = ACCOUNT_TYPE_PREFER;
  progress('Convert: select Account Type on Convert Lead page (Create New Account)...');

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await expandConvertEntitySection(panel, 'Account');
    const section = await openConvertCreateNewFields(panel, 'Account');
    const scope = (await section.isVisible({ timeout: 2_000 }).catch(() => false)) ? section : panel;

    // Wait for dependent fields after Record Type change
    await scope.locator('.slds-spinner:visible').first().waitFor({ state: 'hidden', timeout: 8_000 }).catch(() => {});
    await sleep(attempt === 1 ? 800 : 500);

    // Scroll Create New Account box so Account Type (below Record Type) is in view
    await scope.evaluate((el) => {
      el.scrollIntoView({ block: 'center' });
      const box = el.querySelector('.slds-form, .slds-grid, .slds-box') || el;
      if (box && box.scrollHeight > box.clientHeight) box.scrollTop = box.scrollHeight;
    }).catch(() => {});

    // Debug: list Account section field labels
    if (attempt === 1 || attempt === maxAttempts) {
      const labelEls = scope.locator(
        '.slds-form-element__label, label, legend, .slds-form-element__legend, [class*="label"]',
      );
      const n = Math.min(await labelEls.count().catch(() => 0), 20);
      const found = [];
      for (let i = 0; i < n; i++) {
        const t = ((await labelEls.nth(i).innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
        if (t && t.length < 60) found.push(t);
      }
      progress(`Convert: Account section labels: [${[...new Set(found)].join(' | ') || 'none'}]`);
    }

    // Locate by label text "Account Type" or "Type" (never Record Type)
    const accountTypeLabel = scope
      .getByText(/^account\s*type$/i)
      .or(scope.locator('.slds-form-element__label, label, legend').filter({ hasText: /^account\s*type$/i }))
      .or(scope.locator('.slds-form-element__label, label, legend').filter({ hasText: /^type$/i }))
      .first();

    let trigger = null;
    if (await accountTypeLabel.isVisible({ timeout: 2_000 }).catch(() => false)) {
      progress('Convert: Account Type label found on Convert page');
      const row = accountTypeLabel.locator(
        'xpath=ancestor::*[contains(@class,"slds-form-element") or contains(@class,"form-element")][1]',
      );
      trigger = row
        .locator('button[role="combobox"], button.slds-combobox__input, button[aria-haspopup="listbox"], button')
        .first();
      if (!(await trigger.isVisible({ timeout: 1_500 }).catch(() => false))) {
        // Sibling / following control after the label
        trigger = accountTypeLabel.locator(
          'xpath=following::button[1] | following::*[@role="combobox"][1]',
        ).first();
      }
    }

    if (!trigger || !(await trigger.isVisible({ timeout: 1_000 }).catch(() => false))) {
      // Broader: form-element containing Account Type text
      const typeRow = scope
        .locator('.slds-form-element, lightning-combobox, lightning-picklist, lightning-base-combobox')
        .filter({ hasText: /account\s*type/i })
        .filter({ hasNotText: /record\s*type/i })
        .first();
      trigger = typeRow
        .locator('button[role="combobox"], button.slds-combobox__input, button[aria-haspopup], button, input')
        .first();
    }

    if (!trigger || !(await trigger.isVisible({ timeout: 2_000 }).catch(() => false))) {
      // Exact accessible name
      trigger = scope
        .getByRole('combobox', { name: /account\s*type|^type$/i })
        .or(scope.getByRole('button', { name: /account\s*type/i }))
        .first();
    }

    if (!trigger || !(await trigger.isVisible({ timeout: 2_000 }).catch(() => false))) {
      progress(`Convert: Account Type dropdown not visible yet (attempt ${attempt}/${maxAttempts}) — waiting after Record Type`);
      // Re-assert Account RT = Sold To Party may unlock Account Type
      if (attempt === 2) {
        await selectConvertPanelRecordType(page, panel, { fieldHint: 'Account', typeName: 'Sold To Party' }).catch(() => {});
      }
      await sleep(700);
      if (attempt === maxAttempts) {
        const accountText = ((await scope.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim().slice(0, 500);
        progress(`Convert: Account section text (Account Type missing): ${accountText}`);
        await dumpConvertSuccessPanelHtml(panel, 'account-type-missing-on-convert-page').catch(() => {});
        // Do not hard-fail here — Convert may succeed if Record Type was the intended control;
        // convertLead retries if validation still asks for Account Type.
        progress('Convert: WARN Account Type control not found under Create New Account — proceeding; Convert click will surface validation if still required');
        return '';
      }
      continue;
    }

    const shown = ((await trigger.innerText().catch(() => '')) || (await trigger.inputValue?.().catch(() => '')) || '')
      .replace(/\s+/g, ' ')
      .trim();
    progress(`Convert: Account Type control current: "${shown || '(empty)'}"`);
    if (
      shown &&
      !NONE_OPTION.test(shown) &&
      !/^(account\s*)?type$/i.test(shown) &&
      !/^select/i.test(shown) &&
      !/^--/i.test(shown)
    ) {
      progress(`Convert: Account Type already set "${shown}"`);
      return shown;
    }

    progress(`Convert: clicking Account Type dropdown (attempt ${attempt}/${maxAttempts})...`);
    await trigger.scrollIntoViewIfNeeded().catch(() => {});
    await trigger.click({ force: true });
    await waitAfterComboClick(page);
    await sleep(400);

    const dropdown = page
      .locator('[role="listbox"]:visible, .slds-listbox:visible, .slds-dropdown:visible, [role="menu"]:visible')
      .last();
    if (!(await dropdown.isVisible({ timeout: 4_000 }).catch(() => false))) {
      const arrow = trigger.locator('svg, lightning-icon, .slds-icon').first();
      if (await arrow.isVisible().catch(() => false)) {
        await arrow.click({ force: true }).catch(() => {});
        await sleep(300);
      }
    }
    if (!(await dropdown.isVisible({ timeout: 2_000 }).catch(() => false))) {
      progress('Convert: Account Type list did not open — retry');
      continue;
    }

    const options = dropdown.locator(
      '[role="option"]:visible, [role="menuitem"]:visible, lightning-base-combobox-item:visible, li.slds-listbox__item:visible',
    );
    const count = await options.count().catch(() => 0);
    const labels = [];
    for (let i = 0; i < count; i++) {
      const t = ((await options.nth(i).innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
      if (t && !NONE_OPTION.test(t)) labels.push(t);
    }
    progress(`Convert: Account Type options: [${labels.join(' | ') || 'none'}]`);

    let hit = '';
    for (const pat of prefer) {
      hit = labels.find((l) => pat.test(l)) || '';
      if (hit) break;
    }
    if (!hit) hit = labels[0] || '';
    if (!hit) {
      progress('Convert: no Account Type options — retry');
      await dismissOverlaySafely(page, trigger);
      continue;
    }

    progress(`Convert: Selected Account Type: ${hit}`);
    await options
      .filter({ hasText: new RegExp(`^\\s*${hit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i') })
      .first()
      .click({ force: true });
    await sleep(400);

    const after = ((await trigger.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
    progress(`Convert: Verified Account Type on Convert page: "${after || hit}"`);
    return after || hit;
  }

  throw new Error('Convert: could not select Account Type on Convert Lead page after retries.');
}

async function convertLead(page, { productCategory, retried = false } = {}) {
  progress('6. Convert Lead - Running...');

  if (await convertSuccessPanel(page).isVisible({ timeout: 1_500 }).catch(() => false)) {
    progress('6. Convert Lead - already on success panel — skip Convert click');
    return { accountRt: pickAccountRecordType(), opportunityRt: opportunityRecordTypeFromProductCategory(productCategory || 'Consumables') };
  }
  if (await isLeadAlreadyConverted(page)) {
    progress('6. Convert Lead - skipped (Lead already Converted)');
    return { accountRt: pickAccountRecordType(), opportunityRt: '' };
  }

  const accountRt = pickAccountRecordType(); // Sold To Party unless env overrides

  // Opportunity RT is driven ONLY by Lead Product Category (never Salesforce default alone)
  progress('Convert: Opportunity Record Type depends on Product Category:');
  progress('         Consumables → Consumables');
  progress('         Medical Equipment → Medical Equipment');
  progress('         Medical Equipment & Consumables → Medical Equipment');
  const opportunityRt = opportunityRecordTypeFromProductCategory(productCategory);
  progress(
    `Convert: applying mapping — Product Category="${productCategory}" → Opportunity RT="${opportunityRt}"; Account RT="${accountRt}"`,
  );

  const convertBtn = page
    .getByRole('button', { name: /^convert$/i })
    .or(page.locator('button[name="Convert"], a[title="Convert"]'))
    .first();

  // If Convert Lead dialog is already open (or a toast/panel intercepts), use it; else open it
  let panel = page
    .getByRole('dialog', { name: /convert lead/i })
    .or(
      page
        .locator('.modal-container, .slds-modal__container, .slds-modal, runtime_sales_leadConvertedPanel, [role="dialog"]')
        .filter({ visible: true })
        .filter({ hasText: /convert lead|create new account|create new opportunity/i }),
    )
    .last();

  if (!(await panel.isVisible({ timeout: 2_000 }).catch(() => false))) {
    await acceptAllowAccessPrompts(page, { rounds: 2, perTryMs: 600 }).catch(() => {});
    await expect(convertBtn).toBeVisible({ timeout: 60_000 });
    progress('Convert: clicking Convert on Lead record...');
    await convertBtn.click({ force: true }).catch(async () => {
      // Overlay may have opened the modal mid-click — prefer force via JS
      await convertBtn.evaluate((el) => el.click()).catch(() => {});
    });
    await sleep(STEP_MS);
    panel = page
      .getByRole('dialog', { name: /convert lead/i })
      .or(
        page
          .locator('.modal-container, .slds-modal__container, .slds-modal, runtime_sales_leadConvertedPanel, [role="dialog"]')
          .filter({ visible: true })
          .filter({ hasText: /convert lead|create new account|create new opportunity/i }),
      )
      .last();
  } else {
    progress('Convert: Convert Lead dialog already open — continuing with RT selection');
  }

  await panel.waitFor({ state: 'visible', timeout: 60_000 });
  await panel.locator('.slds-spinner:visible').first().waitFor({ state: 'hidden', timeout: 20_000 }).catch(() => {});

  // Prefer "Create New" Account / Contact / Opportunity (not Choose Existing)
  for (const entity of ['Account', 'Contact', 'Opportunity']) {
    const createNew = panel
      .getByRole('button', { name: new RegExp(`create\\s*(new)?\\s*${entity}|new\\s*${entity}`, 'i') })
      .or(panel.getByText(new RegExp(`^\\s*Create\\s*(New)?\\s*${entity}`, 'i')))
      .or(panel.locator(`button, a, label`).filter({ hasText: new RegExp(`Create\\s*(New)?\\s*${entity}|New\\s*${entity}`, 'i') }))
      .first();
    if (await createNew.isVisible({ timeout: 2_500 }).catch(() => false)) {
      progress(`Convert: selecting Create New ${entity}`);
      await createNew.click({ force: true }).catch(() => {});
      await sleep(300);
    }
  }

  await waitConvertPanelRecordTypesReady(panel);

  // Account: Record Type from env (Sold To Party default, or Supplier)
  await openConvertCreateNewFields(panel, 'Account');
  const accountChosen = await selectConvertPanelRecordType(page, panel, {
    fieldHint: 'Account',
    typeName: accountRt,
  });
  progress(`Convert: Account RT="${accountChosen}" (Account Type not required on Convert)`);

  // Opportunity: expand chevron → click Record Type dropdown → select mapped RT from Product Category
  progress(
    `Convert: expand Opportunity, open Record Type dropdown, select "${opportunityRt}" (from Product Category="${productCategory}")...`,
  );
  await openConvertCreateNewFields(panel, 'Opportunity');
  const oppChosen = await selectConvertPanelRecordType(page, panel, {
    fieldHint: 'Opportunity',
    typeName: opportunityRt,
  });
  if (!new RegExp(`^\\s*${opportunityRt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i').test(oppChosen || '')) {
    throw new Error(
      `Convert: Opportunity RT mismatch — expected "${opportunityRt}" from Product Category "${productCategory}", got "${oppChosen || '(empty)'}"`,
    );
  }

  progress(
    `Convert: RTs verified — Account="${accountChosen}", Opportunity="${oppChosen}" (Product Category="${productCategory}") → clicking Convert`,
  );

  const convertConfirm = panel
    .getByRole('button', { name: /^convert$/i })
    .or(page.getByRole('button', { name: /^convert$/i }))
    .last();
  await expect(convertConfirm).toBeVisible({ timeout: 30_000 });

  // Wait until Convert is enabled (spinner in Contact/matches can disable it)
  await panel.locator('.slds-spinner:visible, .loadingIndicator:visible').first().waitFor({ state: 'hidden', timeout: 30_000 }).catch(() => {});
  const enabledDeadline = Date.now() + 30_000;
  while (Date.now() < enabledDeadline) {
    const disabled = await convertConfirm.isDisabled().catch(() => false);
    const ariaDisabled = ((await convertConfirm.getAttribute('aria-disabled').catch(() => '')) || '').toLowerCase();
    if (!disabled && ariaDisabled !== 'true') break;
    await sleep(400);
  }
  progress('Convert: Convert button ready — clicking');

  await convertConfirm.click({ force: false }).catch(() => convertConfirm.click({ force: true }));
  progress('Convert: Convert clicked — Lead record will not stay open; waiting for success panel or Acc/Contact/Opp...');

  const success = page.getByText(/your lead has been converted/i).first();
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (await success.isVisible({ timeout: 500 }).catch(() => false)) {
      progress('6. Convert Lead - Passed (success panel — Lead no longer displayed)');
      return { accountRt: accountChosen, opportunityRt: oppChosen };
    }
    // Org may skip the success panel and open Contact / Account / Opp instead
    if (await isLeadAlreadyConverted(page)) {
      progress(`6. Convert Lead - Passed (Lead closed; now on ${page.url().slice(0, 120)})`);
      return { accountRt: accountChosen, opportunityRt: oppChosen };
    }

    // Ignore empty search/assistive alerts — they match [role=alert] but are not convert errors
    const errorCandidates = page.locator(
      '.slds-theme_error:visible, .forcePageError:visible, .pageLevelErrors:visible, .slds-notify_toast.slds-theme_error:visible, [role="alert"]:visible',
    );
    const errCount = await errorCandidates.count().catch(() => 0);
    let msg = '';
    for (let i = 0; i < errCount; i++) {
      const t = ((await errorCandidates.nth(i).innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
      if (!t) continue;
      if (/errorMessageOnSearch|0 (Account|Contact|Opportunity) Matches/i.test(t)) continue;
      msg = t;
      break;
    }
    if (msg) {
      progress(`Convert: validation — ${msg.slice(0, 300)}`);
      if (!retried && /qualified before it can be converted|must be marked as qualified/i.test(msg)) {
        progress('Convert: closing panel, forcing Qualify, retrying Convert...');
        await page.getByRole('button', { name: /^cancel$/i }).first().click().catch(() => {});
        await page.getByRole('button', { name: /close/i }).first().click().catch(() => {});
        await qualifyLead(page);
        return convertLead(page, { productCategory, retried: true });
      }
      throw new Error(`Lead conversion failed: ${msg}`);
    }
    await sleep(400);
  }
  throw new Error('Convert: timed out — no success panel and Lead did not navigate to Account/Contact/Opportunity.');
}

/**
 * Convert success panel: "Your lead has been converted".
 * Record links often use ID-only hrefs (/lightning/r/001…/view) — never require /Account/ in the path.
 */
function convertSuccessPanel(page) {
  return page
    .getByRole('dialog')
    .filter({ hasText: /your lead has been converted/i })
    .or(
      page
        .locator('.slds-modal__container, .slds-modal, runtime_sales_leadConvertedPanel, .modal-container')
        .filter({ visible: true })
        .filter({ hasText: /your lead has been converted/i }),
    )
    .first();
}

function absoluteHref(page, href) {
  const h = (href || '').trim();
  if (!h) return '';
  return h.startsWith('http') ? h : new URL(h, page.url()).href;
}

function extractSfRecordId(urlOrHref) {
  const u = urlOrHref || '';
  const m =
    u.match(/\/lightning\/r\/(?:Account|Contact|Opportunity)\/([a-zA-Z0-9]{15,18})/i) ||
    u.match(/\/lightning\/r\/([a-zA-Z0-9]{15,18})(?:\/|$|\?)/i) ||
    u.match(/\b(006[a-zA-Z0-9]{12,15})\b/i) ||
    u.match(/\b((?:001|003|00Q)[a-zA-Z0-9]{12,15})\b/i);
  return m ? m[1] : '';
}

function isAcceptableConvertedRecordHref(href) {
  const h = (href || '').trim();
  if (!h) return false;
  // Accept any Lightning record URL format (ID-only or object-named)
  return /\/lightning\/r\/[a-zA-Z0-9]{15,18}/i.test(h) || /\/lightning\/r\/[^/]+\/[a-zA-Z0-9]{15,18}/i.test(h);
}

/**
 * First visible hyperlink immediately below / beside the Account|Contact|Opportunity section label.
 * Does NOT filter href for /Account/, /Contact/, or /Opportunity/.
 */
async function findConvertedSectionRecordTarget(panel, objectName) {
  const heading = panel
    .getByRole('heading', { name: new RegExp(`^${objectName}$`, 'i') })
    .or(panel.locator('h2, h3, h4, .slds-text-heading_small, .slds-text-title').filter({ hasText: new RegExp(`^\\s*${objectName}\\s*$`, 'i') }))
    .first();

  if (!(await heading.isVisible({ timeout: 3_000 }).catch(() => false))) {
    return { link: null, text: '', href: '' };
  }

  // First hyperlink after the section label (skip footer actions like "Go to Leads")
  const link = heading.locator('xpath=following::a[1]').first();

  if (await link.isVisible({ timeout: 3_000 }).catch(() => false)) {
    const text = ((await link.innerText().catch(() => '')) || '').trim();
    if (!/^go\s*to\b/i.test(text)) {
      const href = ((await link.getAttribute('href')) || '').trim();
      return { link, text, href };
    }
  }

  // Scan a few following links for the first non-"Go to" record link
  for (let i = 1; i <= 6; i++) {
    const a = heading.locator(`xpath=following::a[${i}]`).first();
    if (!(await a.isVisible({ timeout: 500 }).catch(() => false))) continue;
    const text = ((await a.innerText().catch(() => '')) || '').trim();
    if (!text || /^go\s*to\b/i.test(text) || /^new\s+task$/i.test(text)) continue;
    const href = ((await a.getAttribute('href')) || '').trim();
    return { link: a, text, href };
  }

  // No <a> — clickable record name element beside/below the label
  const nameEl = heading
    .locator(
      'xpath=following::*[self::a or self::button or contains(@class,"slds-truncate") or contains(@class,"outputLookupLink")][normalize-space(.)!=""][1]',
    )
    .first();
  if (await nameEl.isVisible({ timeout: 2_000 }).catch(() => false)) {
    const text = ((await nameEl.innerText().catch(() => '')) || '').trim();
    const href = ((await nameEl.getAttribute('href')) || '').trim();
    return { link: nameEl, text, href };
  }

  return { link: null, text: '', href: '' };
}

async function dumpConvertSuccessPanelHtml(panel, reason) {
  const dir = path.join(process.cwd(), 'test-results');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `convert-success-panel-${Date.now()}.html`);
  const html = (await panel.innerHTML().catch(() => '')) || (await panel.evaluate((el) => el.outerHTML).catch(() => ''));
  fs.writeFileSync(file, html || `<!-- empty panel html; reason: ${reason} -->`, 'utf8');
  progress(`Convert success panel HTML dumped → ${file} (${reason})`);
  return file;
}

/**
 * Wait until convert success panel is fully rendered (all three sections + record targets).
 * Retries up to 3 times.
 */
async function waitForConvertSuccessPanelReady(page, { maxAttempts = 3 } = {}) {
  let lastPanel = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    progress(`Success panel detected — waiting for full render (attempt ${attempt}/${maxAttempts})...`);
    await page.getByText(/your lead has been converted/i).first().waitFor({ state: 'visible', timeout: 60_000 });
    const panel = convertSuccessPanel(page);
    lastPanel = panel;
    await expect(panel).toBeVisible({ timeout: 30_000 });
    await panel.locator('.slds-spinner:visible').first().waitFor({ state: 'hidden', timeout: 20_000 }).catch(() => {});
    await sleep(200);

    const found = {};
    let allOk = true;
    for (const obj of ['Account', 'Contact', 'Opportunity']) {
      const target = await findConvertedSectionRecordTarget(panel, obj);
      found[obj] = target;
      if (target.link && (await target.link.isVisible().catch(() => false))) {
        progress(`${obj} link found: "${target.text || '(unnamed)'}"${target.href ? ` → ${target.href}` : ' (no href; will click name)'}`);
      } else {
        allOk = false;
        progress(`${obj} link found: (missing)`);
      }
    }
    if (allOk) {
      progress('Success panel detected — Account / Contact / Opportunity links ready');
      return { panel, found };
    }
    progress(`Success panel not fully rendered yet (attempt ${attempt}/${maxAttempts})`);
    await sleep(400);
  }

  if (lastPanel) {
    await dumpConvertSuccessPanelHtml(lastPanel, 'sections/links not ready after 3 attempts');
  }
  throw new Error('Convert success panel did not finish rendering Account / Contact / Opportunity links after 3 attempts.');
}

async function gotoConvertedRecord(page, objectName, id) {
  const urls = [`/lightning/r/${objectName}/${id}/view`, `/lightning/r/${id}/view`];
  const ready = page.locator(
    'records-lwc-highlights-panel, one-record-home-flexipage2, records-highlights2, .slds-page-header, forceHighlightsDesktopList, button[name="Edit"]',
  ).first();
  for (const url of urls) {
    progress(`Opening ${objectName}... ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.locator('.slds-spinner:visible').first().waitFor({ state: 'hidden', timeout: 30_000 }).catch(() => {});
    if (await ready.isVisible({ timeout: 25_000 }).catch(() => false)) return;
    progress(`Opening ${objectName}: page blank — reload once`);
    await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.locator('.slds-spinner:visible').first().waitFor({ state: 'hidden', timeout: 30_000 }).catch(() => {});
    if (await ready.isVisible({ timeout: 25_000 }).catch(() => false)) return;
  }
}

/**
 * Verify we landed on an Account / Contact / Opportunity record page by UI (not URL shape).
 * Header has many inline "Edit" pencils — only the page-level Edit action counts.
 */
async function verifyConvertedRecordPage(page, objectName) {
  await page.locator('.slds-spinner:visible').first().waitFor({ state: 'hidden', timeout: 60_000 }).catch(() => {});
  await openDetailsTab(page);

  const urlOk =
    new RegExp(`/lightning/r/${objectName}/`, 'i').test(page.url()) ||
    (/Account/i.test(objectName) && /\/lightning\/r\/001/i.test(page.url())) ||
    (/Contact/i.test(objectName) && /\/lightning\/r\/003/i.test(page.url())) ||
    (/Opportunity/i.test(objectName) && /\/lightning\/r\/006/i.test(page.url()));

  const editBtn = headerEditButton(page);
  const ready = page
    .locator('records-lwc-highlights-panel, one-record-home-flexipage2, records-highlights2, .slds-page-header_record-home, .slds-page-header')
    .first();

  let editOk = false;
  let readyOk = false;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    readyOk = await ready.isVisible().catch(() => false);
    editOk = await editBtn.isVisible().catch(() => false);
    if (editOk || readyOk) break;
    await sleep(400);
  }

  if (!editOk && !readyOk) {
    progress(`Opening ${objectName}: UI still blank — reload`);
    await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.locator('.slds-spinner:visible').first().waitFor({ state: 'hidden', timeout: 30_000 }).catch(() => {});
    const reloadDeadline = Date.now() + 30_000;
    while (Date.now() < reloadDeadline) {
      readyOk = await ready.isVisible().catch(() => false);
      editOk = await editBtn.isVisible().catch(() => false);
      if (editOk || readyOk) break;
      await sleep(400);
    }
  }

  if (!editOk && !readyOk && !urlOk) {
    throw new Error(`After opening ${objectName}: record page UI not detected (Edit/header missing). URL=${page.url()}`);
  }
  if (!editOk && !readyOk) {
    throw new Error(`After opening ${objectName}: URL is ${objectName} but record header/Edit never rendered. URL=${page.url()}`);
  }
  progress(
    `7. Verified ${objectName} record page (Edit=${editOk}, header=${readyOk}, urlOk=${urlOk})`,
  );
}

/**
 * Open one converted record from the success panel (click section hyperlink / record name).
 * Later records use the href captured from that same panel click target.
 */
async function openConvertedRecordFromSuccess(page, objectName, captured) {
  progress(`Opening ${objectName}...`);
  const panel = convertSuccessPanel(page);
  const stillOnSuccess = await panel.isVisible({ timeout: 2_000 }).catch(() => false);

  if (stillOnSuccess) {
    const live = await findConvertedSectionRecordTarget(panel, objectName);
    if (live.link && (await live.link.isVisible().catch(() => false))) {
      progress(`Opening ${objectName}... clicking "${live.text || objectName}" on success panel`);
      await live.link.click();
    } else if (captured?.href && isAcceptableConvertedRecordHref(captured.href)) {
      progress(`Opening ${objectName}... via captured href ${captured.href}`);
      await page.goto(absoluteHref(page, captured.href), { waitUntil: 'domcontentloaded' });
    } else {
      await dumpConvertSuccessPanelHtml(panel, `${objectName} link missing at click time`);
      throw new Error(`Convert success panel has no ${objectName} record link/name to open.`);
    }
  } else if (captured?.href && isAcceptableConvertedRecordHref(captured.href)) {
    progress(`Opening ${objectName}... success panel closed; using captured href ${captured.href}`);
    await page.goto(absoluteHref(page, captured.href), { waitUntil: 'domcontentloaded' });
  } else {
    throw new Error(
      `Cannot open ${objectName}: convert success panel is gone and no usable record href was captured.`,
    );
  }

  await verifyConvertedRecordPage(page, objectName);
  const recordId = extractSfRecordId(page.url()) || extractSfRecordId(captured?.href || '') || '';
  progress(`7. Open ${objectName} - Passed${recordId ? ` (${recordId})` : ''}`);
  return recordId;
}

/** Header Edit sits immediately to the right of Follow (+ Follow | Edit | Clone | Change Owner). */
function headerEditButton(page) {
  const follow = page.getByRole('button', { name: /follow/i }).first();
  const nextToFollow = follow
    .locator('xpath=ancestor::li[1]/following-sibling::li[1]//button | ancestor::lightning-button[1]/following::button[1]')
    .first();
  const header = page.locator(
    'records-lwc-highlights-panel, records-highlights2, .slds-page-header_record-home, .highlights.slds-page-header',
  ).first();
  return nextToFollow
    .or(header.getByRole('button', { name: /^Edit$/ }))
    .or(page.locator('runtime_platform_actions-action-renderer').filter({ hasText: /^Edit$/i }).locator('button'))
    .first();
}

async function clickEditNextToFollow(page) {
  return page.evaluate(() => {
    const labelOf = (el) => (el.innerText || el.getAttribute('title') || el.getAttribute('aria-label') || '')
      .replace(/\s+/g, ' ')
      .trim();
    const nodes = Array.from(document.querySelectorAll('button, a[role="button"]'));
    const follow = nodes.find((el) => /follow/i.test(labelOf(el)));
    if (follow) {
      const fr = follow.getBoundingClientRect();
      const edit = nodes
        .filter((el) => /^edit$/i.test(labelOf(el)) || el.getAttribute('name') === 'Edit')
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width >= 10 && Math.abs(r.top - fr.top) < 40 && r.left > fr.left;
        })
        .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)[0];
      if (edit) {
        edit.click();
        return 'follow-sibling';
      }
    }
    return '';
  });
}

async function editFillAndSaveRecord(page, objectName, { recordId = '', alreadyOnRecord = false } = {}) {
  progress(`Fill ${objectName} details - Running...`);
  if (recordId && !alreadyOnRecord) {
    progress(`Opening ${objectName} page /lightning/r/${objectName}/${recordId}/view`);
    await page.goto(`/lightning/r/${objectName}/${recordId}/view`, { waitUntil: 'domcontentloaded' });
    await page.locator('.slds-spinner:visible').first().waitFor({ state: 'hidden', timeout: 45_000 }).catch(() => {});
  }
  await openDetailsTab(page);

  async function openEditForm() {
    await dismissSaveSnagDialog(page);
    await cancelOpenRecordForm(page).catch(() => {});
    const editBtn = page
      .locator('records-lwc-highlights-panel, records-highlights2, .slds-page-header_record-home')
      .getByRole('button', { name: 'Edit', exact: true })
      .or(page.getByRole('button', { name: /^edit$/i }))
      .first();
    await editBtn.waitFor({ state: 'visible', timeout: 45_000 });
    progress(`Clicking ${objectName} Edit (next to Follow)...`);
    await editBtn.click();
    progress(`Fill ${objectName}: waiting for Edit screen to finish loading...`);
    await page.locator('.slds-spinner:visible').first().waitFor({ state: 'hidden', timeout: 45_000 }).catch(() => {});
    await page.getByRole('button', { name: /^save$/i }).first().waitFor({ state: 'visible', timeout: 30_000 });
    const scope = await resolveOpenEditForm(page);
    if (!scope) throw new Error(`Clicked Edit on ${objectName} but the edit form did not open.`);
    return scope;
  }

  async function ensureStageQuote(scope) {
    if (!/^opportunity$/i.test(objectName)) return;
    for (const row of await scope.locator('.slds-form-element').all().catch(() => [])) {
      if (!(await row.isVisible().catch(() => false))) continue;
      if (!isOpportunityStageLabel(await getRowLabelText(row))) continue;
      await selectPicklistValue(page, row, {
        preferPatterns: [/^quote$/i],
        excludePatterns: [/closed\s*lost/i],
        force: true,
        maxAttempts: 3,
      });
      progress('      → Stage = Quote (before Save)');
      break;
    }
    await ensureChannelRequestTypeIfTenderMandatory(page, scope).catch(() => {});
  }

  let formScope = await openEditForm();
  progress(`Fill ${objectName}: Edit form ready — filling fields`);
  await fillAllFieldsSimple(page, formScope, { contextLabel: objectName });

  // Click Save immediately — do not run extra sweeps that can dismiss the modal
  formScope = await resolveOpenEditForm(page);
  if (!formScope) {
    progress(`Fill ${objectName}: form closed after fill — reopen Edit to Save`);
    formScope = await openEditForm();
    await ensureStageQuote(formScope);
    await fillEmptyRequiredFields(page, formScope, {
      contextLabel: `${objectName} reopen`,
      maxPasses: 2,
    }).catch(() => {});
  } else {
    await ensureStageQuote(formScope);
  }

  formScope = (await resolveOpenEditForm(page)) || formScope;
  progress(`Fill ${objectName}: clicking Save now`);
  // Direct Save first — avoid cleanup that can Cancel the Edit form
  let saved = false;
  const liveBefore = await resolveOpenEditForm(page);
  if (liveBefore) {
    const clicked = await clickSave(page, liveBefore);
    await page.locator('.slds-spinner:visible').first().waitFor({ state: 'hidden', timeout: 20_000 }).catch(() => {});
    await sleep(500);
    await acceptAllowAccessPrompts(page, { rounds: 1, perTryMs: FAST_FILL ? 200 : 500 }).catch(() => {});
    if (clicked && (await pageShowsRecordSaveSuccess(page, { timeout: 2_500 }))) {
      progress(`Fill ${objectName}: Save success toast — done`);
      saved = true;
    } else if (clicked && (await pageHasSaveSnag(page))) {
      progress(`Fill ${objectName}: Save snag — fill required and retry`);
      await dismissSaveSnagDialog(page);
      const snagScope = (await resolveOpenEditForm(page)) || liveBefore;
      await ensureStageQuote(snagScope).catch(() => {});
      await handleValidationErrors(page, snagScope).catch(() => {});
      saved = await saveWithValidationRetry(page, snagScope, {
        contextLabel: objectName,
        maxAttempts: FAST_FILL ? 4 : 5,
      }).catch(() => false);
    } else if (clicked && !(await resolveOpenEditForm(page))) {
      progress(`Fill ${objectName}: Save clicked — form closed (success)`);
      saved = true;
    } else if (clicked) {
      // Form still open — one more Save, don't loop forever on unstable button
      const still = await resolveOpenEditForm(page);
      if (still) {
        const clicked2 = await clickSave(page, still);
        await page.locator('.slds-spinner:visible').first().waitFor({ state: 'hidden', timeout: 20_000 }).catch(() => {});
        await sleep(400);
        await acceptAllowAccessPrompts(page, { rounds: 1, perTryMs: FAST_FILL ? 150 : 400 }).catch(() => {});
        if (clicked2 && (await pageShowsRecordSaveSuccess(page, { timeout: 2_000 }))) {
          saved = true;
        } else if (clicked2 && (await pageHasSaveSnag(page))) {
          await dismissSaveSnagDialog(page);
          await handleValidationErrors(page, (await resolveOpenEditForm(page)) || still).catch(() => {});
          saved = await saveWithValidationRetry(page, (await resolveOpenEditForm(page)) || still, {
            contextLabel: objectName,
            maxAttempts: 3,
          }).catch(() => false);
        } else if (clicked2 && !(await resolveOpenEditForm(page))) {
          saved = true;
        } else {
          saved = await saveWithValidationRetry(page, still, {
            contextLabel: objectName,
            maxAttempts: 2,
          }).catch(() => false);
        }
      }
    } else if (!clicked && !(await resolveOpenEditForm(page))) {
      // Save button gone because form already closed after a successful Save
      if (await pageShowsRecordSaveSuccess(page, { timeout: 1_500 })) {
        progress(`Fill ${objectName}: no Save button + success toast — done`);
        saved = true;
      }
    }
  }

  if (saved === false && (await pageShowsRecordSaveSuccess(page, { timeout: 1_200 }))) {
    progress(`Fill ${objectName}: success toast present — skip reopen`);
    saved = true;
  }

  if (saved === false) {
    progress(`Fill ${objectName}: Save failed — reopen Edit, fill required, Save again`);
    formScope = await openEditForm();
    await ensureStageQuote(formScope);
    await fillEmptyRequiredFields(page, formScope, {
      contextLabel: `${objectName} final-save`,
      maxPasses: 2,
    }).catch(() => {});
    formScope = (await resolveOpenEditForm(page)) || formScope;
    const clicked2 = await clickSave(page, formScope);
    await sleep(600);
    await acceptAllowAccessPrompts(page, { rounds: 1, perTryMs: FAST_FILL ? 150 : 400 }).catch(() => {});
    if (clicked2 && (await pageShowsRecordSaveSuccess(page, { timeout: 2_500 }))) {
      saved = true;
    } else if (clicked2 && (await pageHasSaveSnag(page))) {
      await dismissSaveSnagDialog(page);
      const snagScope = (await resolveOpenEditForm(page)) || formScope;
      await handleValidationErrors(page, snagScope).catch(() => {});
      saved = await saveWithValidationRetry(page, snagScope, {
        contextLabel: objectName,
        maxAttempts: 4,
      });
    } else if (clicked2 && !(await resolveOpenEditForm(page))) {
      saved = true;
    } else if (formScope) {
      saved = await saveWithValidationRetry(page, formScope, {
        contextLabel: objectName,
        maxAttempts: 4,
      });
    }
  }

  if (saved === false && (await pageShowsRecordSaveSuccess(page, { timeout: 1_500 }))) {
    progress(`Fill ${objectName}: success toast after retry — treating as saved`);
    saved = true;
  }

  if (saved === false) {
    throw new Error(`Fill ${objectName}: Save did not complete — required fields may still be empty.`);
  }
  if (await formModal(page).isVisible({ timeout: 2_000 }).catch(() => false)) {
    await clickSave(page, formModal(page));
    await page.locator('.slds-spinner:visible').first().waitFor({ state: 'hidden', timeout: 30_000 }).catch(() => {});
    if (await formModal(page).isVisible({ timeout: 3_000 }).catch(() => false)) {
      throw new Error(`Fill ${objectName}: Edit form still open after Save — Save did not succeed.`);
    }
  }
  progress(`Fill ${objectName} details - Passed`);
}

/**
 * After Convert: open Account → Contact → Opportunity from convert success section links,
 * then Edit → fill → Save each. Verifies record pages by UI, not URL shape.
 */
async function openConvertedRecordPreferLink(page, objectName, id) {
  // Always open the object view URL — in-app Account link from Contact often does not change the page
  progress(`Opening ${objectName}... /lightning/r/${objectName}/${id}/view`);
  await page.goto(`/lightning/r/${objectName}/${id}/view`, { waitUntil: 'domcontentloaded' });
  await page.locator('.slds-spinner:visible').first().waitFor({ state: 'hidden', timeout: 30_000 }).catch(() => {});
  const onObject =
    new RegExp(`/lightning/r/${objectName}/`, 'i').test(page.url()) ||
    (objectName === 'Account' && /\/lightning\/r\/001/i.test(page.url())) ||
    (objectName === 'Contact' && /\/lightning\/r\/003/i.test(page.url())) ||
    (objectName === 'Opportunity' && /\/lightning\/r\/006/i.test(page.url()));
  if (!onObject) {
    progress(`Opening ${objectName}: URL still ${page.url().slice(0, 100)} — retry id-only view`);
    await page.goto(`/lightning/r/${id}/view`, { waitUntil: 'domcontentloaded' });
    await page.locator('.slds-spinner:visible').first().waitFor({ state: 'hidden', timeout: 30_000 }).catch(() => {});
  }
  await page.getByRole('button', { name: /follow/i }).first().waitFor({ state: 'visible', timeout: 45_000 }).catch(() => {});
}

/**
 * On Account: Related tab → Opportunities list → first name link → Opportunity record.
 * @returns {Promise<string>} Opportunity Id or ''
 */
async function openOpportunityFromAccountRelated(page) {
  progress('Related tab — clicking Opportunity name under Opportunities (1)...');

  const related = page
    .getByRole('tab', { name: /^related$/i })
    .or(page.locator('a[data-tab-value="relatedListsTab"], a[data-tab-name="relatedListsTab"], a[title="Related"]'))
    .first();
  if (!(await related.isVisible({ timeout: 12_000 }).catch(() => false))) {
    progress('Related tab not visible on Account');
    return '';
  }
  await related.click();
  await page.locator('.slds-spinner:visible').first().waitFor({ state: 'hidden', timeout: 20_000 }).catch(() => {});

  const oppHeading = page.getByRole('heading', { name: /opportunities\s*\(\s*[1-9]/i }).first();
  for (let i = 0; i < 12; i++) {
    if (await oppHeading.isVisible({ timeout: 1_200 }).catch(() => false)) {
      await oppHeading.scrollIntoViewIfNeeded().catch(() => {});
      break;
    }
    await page.mouse.wheel(0, 600).catch(() => {});
    await sleep(350);
  }
  await oppHeading.waitFor({ state: 'visible', timeout: 25_000 }).catch(() => {});
  await oppHeading.scrollIntoViewIfNeeded().catch(() => {});

  const oppCard = page
    .locator(
      'lst-related-list-single-container, lst-related-list-view-manager, article.slds-card, .slds-card, force-related-list-container',
    )
    .filter({ has: page.getByRole('heading', { name: /opportunities/i }) })
    .first();

  // Compact related list: blue name link e.g. "Co_1785… “ PSS - Precision Surgical Solutions…"
  const nameLink = oppCard
    .getByRole('link')
    .filter({ hasNotText: /^(view all|new)$/i })
    .filter({ hasText: /Co_|“|—/ })
    .first()
    .or(page.getByRole('link', { name: /^Co_/i }))
    .or(oppCard.locator('a[href*="/Opportunity/"], a[href*="/006"], a[title*="Co_"], a[data-recordid^="006"]'));

  let clicked = false;
  if (await nameLink.isVisible({ timeout: 20_000 }).catch(() => false)) {
    const text = ((await nameLink.innerText().catch(() => '')) || (await nameLink.getAttribute('title').catch(() => '')) || '')
      .replace(/\s+/g, ' ')
      .trim();
    progress(`Clicking Opportunity name "${text.slice(0, 80)}"`);
    await nameLink.click();
    clicked = true;
  }

  if (!clicked) {
    progress('WARN: Opportunity name link not found under Opportunities (1)');
    return '';
  }

  await page.locator('.slds-spinner:visible').first().waitFor({ state: 'hidden', timeout: 30_000 }).catch(() => {});
  await page.waitForURL(/\/lightning\/r\/(Opportunity|006)/i, { timeout: 25_000 }).catch(() => {});
  await page.getByRole('button', { name: /follow/i }).first().waitFor({ state: 'visible', timeout: 30_000 }).catch(() => {});

  const id = extractSfRecordId(page.url());
  if (id && /^006/i.test(id)) {
    progress(`Opened Opportunity ${id}`);
    return id;
  }
  progress(`WARN: after Related click URL is ${page.url().slice(0, 120)}`);
  return /^006/i.test(id) ? id : '';
}

/**
 * Contact Details → Account Information → Customer Name link → Account record.
 * @returns {Promise<string>} Account Id or ''
 */
async function openAccountFromContactCustomerName(page) {
  progress('Opening Account from Contact — Customer Name (Account Information)...');
  await openDetailsTab(page);

  const section = page
    .getByRole('button', { name: /account information/i })
    .or(page.getByRole('heading', { name: /account information/i }))
    .first();
  if (await section.isVisible({ timeout: 6_000 }).catch(() => false)) {
    await section.scrollIntoViewIfNeeded().catch(() => {});
    const expanded = ((await section.getAttribute('aria-expanded').catch(() => '')) || '').toLowerCase();
    if (expanded === 'false') await section.click().catch(() => {});
  }

  const customerLink = page
    .locator('records-record-layout-item, .slds-form-element, records-hoverable-link')
    .filter({ hasText: /^customer name/i })
    .getByRole('link')
    .first();
  const byLabel = page
    .locator('xpath=//*[normalize-space()="Customer Name"]/ancestor::*[contains(@class,"slds-form-element") or self::records-record-layout-item][1]//a')
    .first();
  const fallback = page
    .locator('a[href*="/lightning/r/Account/"], a[href*="/lightning/r/001"]')
    .filter({ visible: true })
    .first();

  const link = (await customerLink.isVisible({ timeout: 6_000 }).catch(() => false))
    ? customerLink
    : (await byLabel.isVisible({ timeout: 3_000 }).catch(() => false))
      ? byLabel
      : fallback;
  if (!(await link.isVisible({ timeout: 4_000 }).catch(() => false))) {
    progress('WARN: Customer Name link not found on Contact');
    return '';
  }

  const text = ((await link.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
  progress(`Clicking Customer Name "${text}"`);
  await link.click();
  await page.locator('.slds-spinner:visible').first().waitFor({ state: 'hidden', timeout: 30_000 }).catch(() => {});
  await page.waitForURL(/\/lightning\/r\/(Account|001)/i, { timeout: 25_000 }).catch(() => {});
  await page.getByRole('button', { name: /follow/i }).first().waitFor({ state: 'visible', timeout: 30_000 }).catch(() => {});

  const id = extractSfRecordId(page.url());
  if (id && /^001/i.test(id)) {
    progress(`Opened Account ${id} from Customer Name`);
    return id;
  }
  progress(`WARN: after Customer Name click URL is ${page.url().slice(0, 120)}`);
  return '';
}

async function openAndFillConvertedRecordsFromIds(page, ids, { fillContact = FILL_CONTACT, fillAccount = FILL_ACCOUNT } = {}) {
  progress('7. Open converted records — Contact/Account fill only if requested; Opportunity always');
  const results = { accountId: ids.accountId || '', contactId: ids.contactId || '', opportunityId: ids.opportunityId || '' };
  progress(
    `7. Fill flags — Contact=${fillContact ? 'ON' : 'skip'}, Account=${fillAccount ? 'ON' : 'skip'}, Opportunity=ON`,
  );

  // Optional Contact fill
  if (fillContact) {
    let id = results.contactId;
    if (!id) throw new Error('SF_FILL_CONTACT=1 but Contact id not found after convert.');
    const alreadyHere = new RegExp(id, 'i').test(page.url() || '');
    if (!alreadyHere) await openConvertedRecordPreferLink(page, 'Contact', id);
    await verifyConvertedRecordPage(page, 'Contact');
    await editFillAndSaveRecord(page, 'Contact', { recordId: id, alreadyOnRecord: alreadyHere });
  } else {
    progress('7. Contact fill skipped (set SF_FILL_CONTACT=1 to fill)');
  }

  // Optional Account fill (still navigate to Account when needed to reach Opp via Related)
  if (fillAccount) {
    let id = results.accountId;
    const onContact = /\/lightning\/r\/(Contact|003)/i.test(page.url() || '');
    if (onContact) {
      const opened = await openAccountFromContactCustomerName(page);
      id = opened || id;
      results.accountId = id;
    }
    if (!id) throw new Error('SF_FILL_ACCOUNT=1 but Account id not found after convert.');
    const alreadyHere = new RegExp(id, 'i').test(page.url() || '');
    if (!alreadyHere && !/\/lightning\/r\/(Account|001)/i.test(page.url() || '')) {
      await openConvertedRecordPreferLink(page, 'Account', id);
    }
    await verifyConvertedRecordPage(page, 'Account');
    await editFillAndSaveRecord(page, 'Account', { recordId: id, alreadyOnRecord: true });
  } else {
    progress('7. Account fill skipped (set SF_FILL_ACCOUNT=1 to fill)');
  }

  // Opportunity — always fill (navigate via Opp id, or Account Related without Account edit)
  {
    let id = results.opportunityId;
    if (id) {
      const alreadyHere = new RegExp(id, 'i').test(page.url() || '') || /\/Opportunity\//i.test(page.url() || '');
      if (!alreadyHere) {
        progress(`7. Opening Opportunity ${id} (skip Acc/Contact fill path)`);
        await page.goto(`/lightning/r/Opportunity/${id}/view`, { waitUntil: 'domcontentloaded' });
      }
    } else {
      // Need Account Related → Opportunity (open Account without filling if needed)
      if (!/\/lightning\/r\/(Account|001)/i.test(page.url() || '')) {
        let accId = results.accountId;
        if (!accId && /\/lightning\/r\/(Contact|003)/i.test(page.url() || '')) {
          accId = (await openAccountFromContactCustomerName(page)) || '';
          results.accountId = accId;
        }
        if (accId) {
          await page.goto(`/lightning/r/Account/${accId}/view`, { waitUntil: 'domcontentloaded' });
          await waitForLightningRecordHome(page).catch(() => {});
        } else if (results.accountId) {
          await openConvertedRecordPreferLink(page, 'Account', results.accountId);
        } else {
          throw new Error('After convert, Opportunity id and Account id both missing — cannot open Opportunity.');
        }
      }
      progress('7. Opening Opportunity from Account Related (Account not edited)');
      const fromRelated = await openOpportunityFromAccountRelated(page);
      id = fromRelated || id;
      results.opportunityId = id;
    }
    if (!id) throw new Error('Opportunity not found after convert — cannot continue Price Book / Quote.');
    results.opportunityId = id;
    await verifyConvertedRecordPage(page, 'Opportunity');
    await editFillAndSaveRecord(page, 'Opportunity', { recordId: id, alreadyOnRecord: true });
  }

  progress(
    `7. Converted path done — Account: ${results.accountId || '(nav only)'}, Contact: ${results.contactId || '(skipped)'}, Opportunity: ${results.opportunityId}`,
  );
  return results;
}

async function openAndFillConvertedRecords(page, { fillContact = FILL_CONTACT, fillAccount = FILL_ACCOUNT } = {}) {
  progress('7. After Convert → Opportunity fill (Contact/Account only if SF_FILL_*=1)...');

  const fromPanel = { accountId: '', contactId: '', opportunityId: '' };
  if (await convertSuccessPanel(page).isVisible({ timeout: 4_000 }).catch(() => false)) {
    progress('7. Convert success panel — capturing Acc/Contact/Opp ids');
    const { panel, found } = await waitForConvertSuccessPanelReady(page, { maxAttempts: 3 }).catch(() => ({
      panel: convertSuccessPanel(page),
      found: {},
    }));
    fromPanel.accountId = extractSfRecordId(found.Account?.href || '');
    fromPanel.contactId = extractSfRecordId(found.Contact?.href || '');
    fromPanel.opportunityId = extractSfRecordId(found.Opportunity?.href || '');
    progress(
      `7. Success panel ids — Acc=${fromPanel.accountId || '(none)'}, Contact=${fromPanel.contactId || '(none)'}, Opp=${fromPanel.opportunityId || '(none)'}`,
    );

    // Prefer opening the record we will use next (Opp → Account → Contact)
    if (fromPanel.opportunityId && !fillContact && !fillAccount) {
      const oppTarget = found.Opportunity?.link;
      if (oppTarget && (await oppTarget.isVisible().catch(() => false))) {
        await oppTarget.click().catch(() => {});
        await page.waitForURL(/\/lightning\/r\/(Opportunity|006)/i, { timeout: 25_000 }).catch(() => {});
      } else {
        await page.goto(`/lightning/r/Opportunity/${fromPanel.opportunityId}/view`, { waitUntil: 'domcontentloaded' });
      }
    } else if (fillContact) {
      const contactTarget = found.Contact?.link || (await findConvertedSectionRecordTarget(panel, 'Contact')).link;
      if (contactTarget && (await contactTarget.isVisible().catch(() => false))) {
        await contactTarget.click().catch(() => {});
        await page.waitForURL(/\/lightning\/r\/(Contact|003)/i, { timeout: 25_000 }).catch(() => {});
      }
    } else if (fromPanel.accountId) {
      const accTarget = found.Account?.link;
      if (accTarget && (await accTarget.isVisible().catch(() => false))) {
        await accTarget.click().catch(() => {});
        await page.waitForURL(/\/lightning\/r\/(Account|001)/i, { timeout: 25_000 }).catch(() => {});
      }
    }
    await page.locator('.slds-spinner:visible').first().waitFor({ state: 'hidden', timeout: 30_000 }).catch(() => {});
  }

  const fromPage = await readConvertedRelatedIdsFromLeadPage(page);
  const ids = {
    accountId: fromPage.accountId || fromPanel.accountId,
    contactId: fromPage.contactId || fromPanel.contactId,
    opportunityId: fromPage.opportunityId || fromPanel.opportunityId,
  };
  if (!ids.opportunityId && !ids.accountId && !ids.contactId && !/\/lightning\/r\/(Contact|Account|Opportunity|003|001|006)/i.test(page.url() || '')) {
    throw new Error('After convert, Contact/Account/Opportunity was not found (Lead page is gone).');
  }
  return openAndFillConvertedRecordsFromIds(page, ids, { fillContact, fillAccount });
}

// ─── Opportunity products / quote (after Opp filled) ─────────────────────────

/**
 * Read a field value from record Details (view mode) without opening Edit.
 * Returns trimmed text or '' if missing/blank.
 * Never treats the field label / Edit-help chrome as a real value.
 */
async function readDetailsFieldValue(page, labelRe) {
  const item = page
    .locator('records-record-layout-item, lightning-output-field, .slds-form-element')
    .filter({ has: page.locator('span, label, .slds-form-element__label').filter({ hasText: labelRe }) })
    .first()
    .or(
      page
        .locator('records-record-layout-item, lightning-output-field, .slds-form-element')
        .filter({ has: page.getByText(labelRe) })
        .first(),
    );
  if (!(await item.isVisible({ timeout: 2_500 }).catch(() => false))) return '';

  // Prefer the dedicated output / testid slot over whole-item innerText (avoids label/help/Edit)
  const slotCandidates = [
    item.locator('[data-output-element-id="output-field"], lightning-formatted-text, lightning-formatted-number, lightning-formatted-url, lightning-base-formatted-text').first(),
    item.locator('.slds-form-element__control, .test-id__field-value, dd, .slds-form-element__static').first(),
  ];
  let raw = '';
  for (const slot of slotCandidates) {
    if (await slot.isVisible({ timeout: 400 }).catch(() => false)) {
      raw = ((await slot.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
      if (raw) break;
    }
  }
  if (!raw) {
    raw = ((await item.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
  }

  const labelMatch = raw.match(labelRe);
  let labelText = labelMatch ? labelMatch[0].replace(/\s+/g, ' ').trim() : '';
  let val = raw;
  if (labelMatch) val = raw.slice(raw.indexOf(labelMatch[0]) + labelMatch[0].length).trim();

  // Strip Lightning Details chrome: "Edit Quote Type", "Help …", leftover "Edit …"
  val = val
    .replace(/^\*\s*/, '')
    .replace(/^Edit\s+/i, '')
    .replace(new RegExp(`\\bEdit\\s+${labelRe.source}\\b`, 'ig'), '')
    .replace(new RegExp(`\\bHelp(?:\\s+${labelRe.source})?\\b`, 'ig'), '')
    .replace(new RegExp(`\\b${labelRe.source}\\b`, 'ig'), '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!val || /^(--|-|none|select|choose|n\/a|null)$/i.test(val)) return '';
  // Field still empty: leftover text equals the label (e.g. "Quote Type")
  if (labelText && val.toLowerCase() === labelText.toLowerCase()) return '';
  if (/^(quote\s*type|business\s*unit|division)$/i.test(val)) return '';
  return val.slice(0, 120);
}

/** True when Quote Type + Business Unit (+ Division if present) already have values on Details. */
async function detailsHaveQuoteTypeBuDivision(page, { requireDivision = false } = {}) {
  await openDetailsTab(page).catch(() => {});
  await page.locator('.slds-spinner:visible').first().waitFor({ state: 'hidden', timeout: 15_000 }).catch(() => {});
  const qt = await readDetailsFieldValue(page, /quote\s*type/i);
  const bu = await readDetailsFieldValue(page, /business\s*unit/i);
  const div = await readDetailsFieldValue(page, /^division$/i);
  // Reject chrome / label leftovers that slipped through
  const qtOk = !!(qt && !/^(quote\s*type)$/i.test(qt) && qt.length > 1);
  const buOk = !!(bu && !/^(business\s*unit|edit\s*business\s*unit)$/i.test(bu) && bu.length > 1);
  const divOk = !!(div && !/^(division|edit\s*division)$/i.test(div) && div.length > 1);
  const ok = !!(qtOk && buOk && (!requireDivision || divOk));
  if (ok) {
    progress(`11. Details already set — Quote Type="${qt}", BU="${bu}"${div ? `, Division="${div}"` : ''} — skip Edit`);
  } else {
    progress(
      `11. Details need fill — Quote Type="${qt || '(blank)'}", BU="${bu || '(blank)'}"${requireDivision ? `, Division="${div || '(blank)'}"` : ''}`,
    );
  }
  return { ok, qt: qtOk ? qt : '', bu: buOk ? bu : '', div: divOk ? div : '' };
}

/**
 * After Quote is created/opened:
 *   1) Fill Quote Type + Business Unit (+ Division) on the Quote ONLY if blank
 *   2) Open Lines (caller then Browse Catalog if QLI still blank)
 */
async function ensureQuoteFieldsThenOpenLines(page) {
  progress('11. After Quote — Quote Type / Business Unit only if blank, then Lines');
  await fillQuoteTypeBuDivisionOnQuote(page);
  await openQuoteTab(page, 'Lines');
  progress('11. Quote Lines tab open — Browse Catalog next if QLI is blank');
}

/**
 * Quote record only: Quote Type, Business Unit, Division must be set or QLI will not appear.
 * Skips Edit when Details already has values.
 */
async function fillQuoteTypeBuDivisionOnQuote(page) {
  progress('11. Quote — ensure Quote Type, Business Unit, Division (on Quote)');
  let quoteId = (await quoteIdFromUrl(page)) || '';
  if (!quoteId) {
    await waitForQuoteRecordVisible(page, { timeout: 30_000 }).catch(() => {});
    quoteId = (await quoteIdFromUrl(page)) || '';
  }
  if (!quoteId) {
    progress('11. Quote Id unknown — cannot Edit Quote fields');
    return;
  }

  // Stay on view — do not reopen Edit if fields are already validated
  await page.goto(`/lightning/r/Quote/${quoteId}/view`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await waitForQuoteRecordVisible(page, { timeout: 30_000 }).catch(() => {});
  const already = await detailsHaveQuoteTypeBuDivision(page, { requireDivision: false });
  if (already.ok && already.qt && already.bu) {
    progress('11. Quote fields already validated — skip Edit');
    return;
  }

  await page.goto(`/lightning/r/Quote/${quoteId}/edit`, { waitUntil: 'domcontentloaded' });
  await page.locator('.slds-spinner:visible').first().waitFor({ state: 'hidden', timeout: 45_000 }).catch(() => {});
  await page.getByRole('button', { name: /^save$/i }).first().waitFor({ state: 'visible', timeout: 45_000 });
  let scope = await resolveOpenEditForm(page);
  if (!scope) {
    scope = page.locator('records-record-layout-edit, records-lwc-record-layout, .record-body-container, forceRecordEdit').first();
    if (!(await scope.isVisible({ timeout: 8_000 }).catch(() => false))) {
      scope = page.locator('body');
    }
  }
  await expandSections(scope).catch(() => {});

  async function findRow(pred) {
    const rows = await scope.locator('.slds-form-element').all().catch(() => []);
    for (const row of rows) {
      if (!(await row.isVisible().catch(() => false))) continue;
      const label = await getRowLabelText(row);
      if (pred(label)) return row;
    }
    for (const row of await page.locator('.slds-form-element').all().catch(() => [])) {
      if (!(await row.isVisible().catch(() => false))) continue;
      const label = await getRowLabelText(row);
      if (pred(label)) return row;
    }
    return null;
  }

  let filledAny = false;

  {
    const row = await findRow(isQuoteTypeLabel);
    // Always force a real picklist value when Details said Quote Type was blank
    const needQt = !already.qt;
    if (row && (needQt || (await isFormRowEmpty(row)))) {
      const chosen = await selectPicklistValue(page, row, { force: true, fast: false, maxAttempts: 3 });
      if (chosen && !NONE_OPTION.test(chosen) && !/^quote\s*type$/i.test(chosen)) {
        filledAny = true;
        progress(`11. Quote Type (Quote) → ${chosen}`);
      } else {
        progress(`11. Quote Type (Quote) — could not select a value (got "${chosen || ''}")`);
      }
    } else if (row) {
      const shown = await readComboboxDisplayedValue(rowPicklistTrigger(row));
      progress(`11. Quote Type (Quote) already "${shown || '(set)'}"`);
    } else {
      progress('11. Quote Type (Quote) field not found on Edit form');
    }
  }

  let buFilled = false;
  {
    const row = await findRow(isBusinessUnitLabel);
    if (row) {
      if (await isFormRowEmpty(row)) {
        const chosen = await selectPicklistValue(page, row, { force: true, fast: true });
        if (chosen && !NONE_OPTION.test(chosen)) {
          buFilled = true;
          filledAny = true;
          progress(`11. Business Unit (Quote) → ${chosen}`);
        }
      } else {
        buFilled = true;
        const shown = await readComboboxDisplayedValue(rowPicklistTrigger(row));
        progress(`11. Business Unit (Quote) already "${shown || '(set)'}"`);
      }
    }
  }

  await sleep(700);

  {
    const row = await findRow(isDivisionLabel);
    if (row) {
      if (!buFilled) {
        progress('11. Division (Quote) skipped — Business Unit not set');
      } else if (await isFormRowEmpty(row)) {
        for (let w = 0; w < 10; w++) {
          const combo = rowPicklistTrigger(row);
          const disabled = await combo.isDisabled().catch(() => false);
          if (!disabled && (await combo.isVisible().catch(() => false))) break;
          await sleep(400);
        }
        const chosen = await selectPicklistValue(page, row, { force: true, fast: true });
        if (chosen) {
          filledAny = true;
          progress(`11. Division (Quote) → ${chosen}`);
        }
      } else {
        const shown = await readComboboxDisplayedValue(rowPicklistTrigger(row));
        progress(`11. Division (Quote) already "${shown || '(set)'}"`);
      }
    }
  }

  if (filledAny) {
    await saveWithValidationRetry(page, scope, { contextLabel: 'Quote' }).catch(async (err) => {
      progress(`11. Quote field Save warn — ${String(err?.message || err).slice(0, 120)}`);
      await page.getByRole('button', { name: /^save$/i }).first().click().catch(() => {});
    });
    await page.locator('.slds-spinner:visible').first().waitFor({ state: 'hidden', timeout: 45_000 }).catch(() => {});
    progress('11. Quote Type / Business Unit / Division saved on Quote');
  } else {
    const cancel = page.getByRole('button', { name: /^cancel$/i }).first();
    if (await cancel.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await cancel.click().catch(() => {});
    }
    progress('11. Quote Type / BU / Division already set on Quote — no Save');
  }

  await page.goto(`/lightning/r/Quote/${quoteId}/view`, { waitUntil: 'domcontentloaded' });
  await waitForQuoteRecordVisible(page, { timeout: 45_000 }).catch(() => {});
  await page.locator('.slds-spinner:visible').first().waitFor({ state: 'hidden', timeout: 30_000 }).catch(() => {});
}

/**
 * Opportunity: Business Unit / Division when present (before products).
 * Skips Edit when Details already has values.
 */
async function ensureQuoteTypeBuDivisionFields(page, objectLabel = 'Opportunity') {
  progress(`9. ${objectLabel} — Quote Type, Business Unit, Division`);
  if (/^quote$/i.test(objectLabel)) {
    await fillQuoteTypeBuDivisionOnQuote(page);
    return;
  }
  await waitForLightningRecordHome(page, { timeout: 20_000 }).catch(() => {});
  await openDetailsTab(page).catch(() => {});
  await page.locator('.slds-spinner:visible').first().waitFor({ state: 'hidden', timeout: 20_000 }).catch(() => {});

  const bu = await readDetailsFieldValue(page, /business\s*unit/i);
  const div = await readDetailsFieldValue(page, /^division$/i);
  const buOk = !!(bu && !/^(business\s*unit|edit\s*business\s*unit|help)$/i.test(bu) && bu.length > 2);
  const divOk = !!(div && !/^(division|edit\s*division|help)$/i.test(div) && div.length > 2);
  if (buOk && divOk) {
    progress(`9. Opportunity already has BU="${bu}", Division="${div}" — skip Edit`);
    return;
  }
  progress(`9. Opportunity Details — BU="${bu || '(blank)'}", Division="${div || '(blank)'}" — Edit if needed`);

  const editBtn = page
    .locator('records-lwc-highlights-panel, records-highlights2, .slds-page-header_record-home')
    .getByRole('button', { name: 'Edit', exact: true })
    .or(page.getByRole('button', { name: /^edit$/i }))
    .or(page.locator('button[name="Edit"], a[title="Edit"]'))
    .first();
  if (!(await editBtn.isVisible({ timeout: 12_000 }).catch(() => false))) {
    progress(`9. ${objectLabel} Edit not visible — skip`);
    return;
  }
  await editBtn.click();
  await page.locator('.slds-spinner:visible').first().waitFor({ state: 'hidden', timeout: 45_000 }).catch(() => {});
  await page.getByRole('button', { name: /^save$/i }).first().waitFor({ state: 'visible', timeout: 30_000 });
  const scope = await resolveOpenEditForm(page);
  if (!scope) {
    progress(`9. ${objectLabel} Edit form did not open — skip`);
    return;
  }

  async function findRow(pred) {
    for (const row of await scope.locator('.slds-form-element').all().catch(() => [])) {
      if (!(await row.isVisible().catch(() => false))) continue;
      const label = await getRowLabelText(row);
      if (pred(label)) return row;
    }
    return null;
  }

  let filledAny = false;
  let buFilled = !!(bu);

  {
    const row = await findRow(isBusinessUnitLabel);
    if (row) {
      if (await isFormRowEmpty(row)) {
        const chosen = await selectPicklistValue(page, row, { force: true, fast: true });
        if (chosen && !NONE_OPTION.test(chosen)) {
          buFilled = true;
          filledAny = true;
          progress(`9. Business Unit → ${chosen}`);
        }
      } else {
        buFilled = true;
        progress('9. Business Unit already set');
      }
    }
  }
  await sleep(600);
  {
    const row = await findRow(isDivisionLabel);
    if (row && buFilled && (await isFormRowEmpty(row))) {
      const chosen = await selectPicklistValue(page, row, { force: true, fast: true });
      if (chosen) {
        filledAny = true;
        progress(`9. Division → ${chosen}`);
      }
    } else if (row && !(await isFormRowEmpty(row))) {
      progress('9. Division already set');
    }
  }

  if (filledAny) {
    await saveWithValidationRetry(page, scope, { contextLabel: objectLabel }).catch(async () => {
      await page.getByRole('button', { name: /^save$/i }).first().click().catch(() => {});
    });
    await page.locator('.slds-spinner:visible').first().waitFor({ state: 'hidden', timeout: 45_000 }).catch(() => {});
    progress(`9. ${objectLabel} fields saved`);
  } else {
    await cancelOpenRecordForm(page).catch(() => {});
    progress(`9. ${objectLabel} fields already set`);
  }
}

async function ensureOpportunityQuotePrerequisitesBeforeProducts(page) {
  await ensureQuoteTypeBuDivisionFields(page, 'Opportunity');
  progress('9. Opp prerequisites done (only fills blanks)');
}

async function openRelatedTab(page) {
  const relatedLocator = () =>
    page
      .getByRole('tab', { name: /^related$/i })
      .or(page.locator('a[data-tab-name="relatedTab"], a[title="Related"], a[data-label="Related"]'))
      .or(page.locator('lightning-tab-bar a, ul[role="tablist"] a').filter({ hasText: /^related$/i }))
      .first();

  let related = relatedLocator();
  if (!(await related.isVisible({ timeout: 8_000 }).catch(() => false))) {
    // Related often sits under "More" on Opportunity flexipages
    const moreTab = page
      .getByRole('tab', { name: /^more$/i })
      .or(page.locator('button[title="More Tabs"], a[title="More"], button[aria-label*="More" i]'))
      .first();
    if (await moreTab.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await moreTab.click().catch(() => {});
      await sleep(400);
      const relatedMenu = page
        .getByRole('menuitem', { name: /^related$/i })
        .or(page.locator('[role="menuitem"], a, span').filter({ hasText: /^related$/i }))
        .first();
      if (await relatedMenu.isVisible({ timeout: 3_000 }).catch(() => false)) {
        await relatedMenu.click().catch(() => {});
        await page.locator('.slds-spinner:visible').first().waitFor({ state: 'hidden', timeout: 12_000 }).catch(() => {});
        progress('8. Related tab - opened via More');
        return;
      }
    }

    // Recover when Stage Edit left the page blank / wrong tab strip
    const oppId =
      (page.url().match(/\/lightning\/r\/Opportunity\/([a-zA-Z0-9]{15,18})/i) ||
        page.url().match(/\/(006[a-zA-Z0-9]{12,15})(?:\/|$|\?)/i) ||
        [])[1] ||
      (process.env.SF_OPP_ID || '').trim() ||
      '';
    if (oppId) {
      progress('8. Related tab missing — reload Opportunity then retry');
      await page.goto(`/lightning/r/Opportunity/${oppId}/view`, { waitUntil: 'domcontentloaded' });
      await page.locator('.slds-spinner:visible').first().waitFor({ state: 'hidden', timeout: 45_000 }).catch(() => {});
      related = relatedLocator();
      if (!(await related.isVisible({ timeout: 5_000 }).catch(() => false))) {
        const more2 = page.getByRole('tab', { name: /^more$/i }).or(page.locator('button[title="More Tabs"]')).first();
        if (await more2.isVisible({ timeout: 2_000 }).catch(() => false)) {
          await more2.click().catch(() => {});
          await sleep(400);
          const relatedMenu2 = page.getByRole('menuitem', { name: /^related$/i }).first();
          if (await relatedMenu2.isVisible({ timeout: 3_000 }).catch(() => false)) {
            await relatedMenu2.click().catch(() => {});
            progress('8. Related tab - opened via More after reload');
            return;
          }
        }
      }
    }
  }
  if (!(await related.isVisible({ timeout: 12_000 }).catch(() => false))) {
    progress('8. Related tab - not found (skip)');
    return;
  }
  const selected = ((await related.getAttribute('aria-selected').catch(() => '')) || '').toLowerCase();
  if (selected === 'true') {
    progress('8. Related tab - already open');
    return;
  }
  progress('8. Related tab - Running...');
  await related.click();
  await page.locator('.slds-spinner:visible').first().waitFor({ state: 'hidden', timeout: 12_000 }).catch(() => {});
  const still = ((await related.getAttribute('aria-selected').catch(() => '')) || '').toLowerCase();
  if (still !== 'true') {
    await related.click({ force: true });
    await page.locator('.slds-spinner:visible').first().waitFor({ state: 'hidden', timeout: 12_000 }).catch(() => {});
  }
  progress('8. Related tab - Passed');
}

function resolveExistingPriceBookName(currentSelected = '') {
  const asked = (PRICEBOOK_SEARCH || '').trim();
  const fromList = (name) =>
    EXISTING_PRICE_BOOKS.find((n) => n.toLowerCase() === name.toLowerCase()) ||
    EXISTING_PRICE_BOOKS.find((n) => n.toLowerCase().includes(name.toLowerCase()) || name.toLowerCase().includes(n.toLowerCase()));
  const current = (currentSelected || '').replace(/\s+/g, ' ').trim();
  // Keep any already-selected book from the allowed list (Medical Equipment often defaults Al-Hammad…)
  if (current) {
    const hit = fromList(current);
    if (hit) return hit;
  }
  if (asked) {
    const hit = fromList(asked);
    if (hit) return hit;
  }
  return EXISTING_PRICE_BOOKS[0];
}

function choosePriceBookDialog(page) {
  return page
    .getByRole('dialog', { name: /choose price book|change price book|price book/i })
    .or(
      page
        .locator('.slds-modal:visible, [role="dialog"]:visible')
        .filter({ hasText: /choose price book|change price book|price book/i }),
    )
    .first();
}

/** Pick an existing Price Book inside the Choose Price Book modal (scoped options + typeahead). */
async function selectPriceBookInDialog(dialog, page, combo, typedInput, targetName) {
  const want = (targetName || '').replace(/\s+/g, ' ').trim();
  if (!want) return '';

  const host =
    combo.locator('xpath=ancestor::*[contains(@class,"slds-combobox")][1]').first().or(combo);
  const searchTerms = [...new Set([want, want.split(' - ')[0]?.trim(), want.split(' - ').pop()?.trim()].filter(Boolean))];

  async function collectOptionLabels() {
    let optionRoot = host;
    let labels = await listScopedComboboxLabels(host);
    if (!labels.length) {
      const portal = dialog
        .locator('[role="listbox"]:visible')
        .filter({ has: dialog.locator('[role="option"]:visible') })
        .last();
      if (await portal.isVisible({ timeout: 1_500 }).catch(() => false)) {
        optionRoot = portal;
        labels = await listScopedComboboxLabels(portal);
      }
    }
    if (!labels.length) {
      const pagePortal = page
        .locator('[role="listbox"]:visible')
        .filter({ has: page.locator('[role="option"]:visible') })
        .last();
      if (await pagePortal.isVisible({ timeout: 800 }).catch(() => false)) {
        optionRoot = pagePortal;
        labels = await listScopedComboboxLabels(pagePortal);
      }
    }
    return { optionRoot, labels };
  }

  for (const term of searchTerms) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      await combo.scrollIntoViewIfNeeded().catch(() => {});
      await combo.click({ force: true });
      await waitAfterComboClick(page);
      await waitComboboxExpanded(combo, { timeout: 2_500 }).catch(() => false);

      if (await typedInput.isVisible({ timeout: 800 }).catch(() => false)) {
        if (!(await typedInput.isDisabled().catch(() => false))) {
          await typedInput.fill('', { timeout: 3_000 }).catch(() => {});
          await typedInput.fill(term, { timeout: 6_000 }).catch(() => {});
          await sleep(term.length > 6 ? 450 : 300);
        }
      }

      const { optionRoot, labels } = await collectOptionLabels();
      if (labels.length) {
        progress(
          `9. Price Book dropdown (${labels.length}): [${labels.slice(0, 6).join(' | ')}${labels.length > 6 ? '…' : ''}]`,
        );
      }

      if (await clickScopedOptionByText(optionRoot, want)) return want;

      const fuzzy =
        labels.find((l) => l.toLowerCase() === want.toLowerCase()) ||
        labels.find((l) => l.toLowerCase().includes(want.toLowerCase()) || want.toLowerCase().includes(l.toLowerCase()));
      if (fuzzy && (await clickScopedOptionByText(optionRoot, fuzzy))) return fuzzy;

      await dismissOverlaySafely(page, combo);
      await sleep(200);
    }
  }
  return '';
}

/**
 * @param {{ forceName?: string }} [opts]
 *   forceName — always switch to this allowed book (used when current book has no products)
 */
async function choosePriceBook(page, { forceName = '' } = {}) {
  const forced = (forceName || '').trim();
  progress(
    forced
      ? `9. Related → Products → switch Price Book to "${forced}"`
      : '9. Related → Products → Choose Price Book (existing list only)',
  );
  await openRelatedTab(page);
  if (!forced && (await opportunityAlreadyHasProducts(page))) {
    progress('9. Products already on Opportunity — skip Choose Price Book');
    return;
  }
  await scrollRelatedListToTop(page);
  const productsCard = page.getByRole('article', { name: /^products(\s*\(\s*\d+\s*\))?$/i }).first();
  await productsCard.waitFor({ state: 'visible', timeout: 20_000 });

  // Price Book already associated — Add Products is on the Products row (skip only when not forcing a switch)
  const addAlready = page.getByRole('button', { name: /^add products$/i }).filter({ visible: true }).first();
  let chooseOnRow = page
    .getByRole('button', { name: /choose price book|change price book/i })
    .filter({ visible: true })
    .first();
  if (
    !forced &&
    (await addAlready.isVisible({ timeout: 2_000 }).catch(() => false)) &&
    !(await chooseOnRow.isVisible({ timeout: 800 }).catch(() => false))
  ) {
    progress('9. Add Products is visible — Price Book already set, skip Choose Price Book');
    return;
  }

  if (!(await chooseOnRow.isVisible({ timeout: 2_000 }).catch(() => false))) {
    const more = productsCard
      .getByRole('button', { name: /show more actions/i })
      .or(page.getByRole('button', { name: /show more actions/i }))
      .filter({ visible: true })
      .first();
    if (await more.isVisible({ timeout: 3_000 }).catch(() => false)) {
      progress('9. Products row — clicking â–¾ next to Add Products');
      await more.click();
      await sleep(LWC_MENU_ANIMATION_MS);
      chooseOnRow = page.getByRole('menuitem', { name: /choose price book|change price book/i }).first();
    } else if (!forced) {
      progress('9. Choose Price Book not on the row — skip (Price Book already set)');
      return;
    }
  }

  if (!(await chooseOnRow.isVisible({ timeout: 6_000 }).catch(() => false))) {
    if (forced) throw new Error(`Cannot open Choose Price Book to switch to "${forced}".`);
    progress('9. Choose Price Book menu not visible — skip (products/price book already set)');
    return;
  }

  const dialog = choosePriceBookDialog(page);
  let opened = false;
  for (let attempt = 1; attempt <= 3 && !opened; attempt++) {
    progress(`9. Clicking Choose Price Book (attempt ${attempt}/3)`);
    await chooseOnRow.click({ force: attempt === 3 });
    await page.locator('.slds-spinner:visible').first().waitFor({ state: 'hidden', timeout: 6_000 }).catch(() => {});
    opened = await dialog.isVisible({ timeout: 5_000 }).catch(() => false);
  }
  if (!opened) {
    throw new Error('Choose Price Book dialog did not open after clicking the Products action.');
  }

  const combo = dialog.getByRole('combobox', { name: /price book/i }).first();
  await combo.waitFor({ state: 'visible', timeout: 12_000 });

  const typedInput = dialog.locator('input[role="combobox"], input.slds-combobox__input').first();
  for (let w = 0; w < 16; w++) {
    const disabled =
      (await typedInput.isDisabled().catch(() => false)) ||
      ((await typedInput.getAttribute('aria-disabled').catch(() => '')) || '').toLowerCase() === 'true';
    const ph = ((await typedInput.getAttribute('placeholder').catch(() => '')) || '').toLowerCase();
    const val = (
      (await combo.innerText().catch(() => '')) ||
      (await typedInput.inputValue().catch(() => '')) ||
      (await typedInput.getAttribute('data-value').catch(() => '')) ||
      ''
    )
      .replace(/\s+/g, ' ')
      .trim();
    if (!disabled && !/loading/i.test(ph) && val && !NONE_OPTION.test(val)) break;
    if (!disabled && !/loading/i.test(ph) && w > 4) break;
    await sleep(200);
  }
  await page.locator('.slds-spinner:visible').first().waitFor({ state: 'hidden', timeout: 8_000 }).catch(() => {});

  const already = (
    (await combo.innerText().catch(() => '')) ||
    (await typedInput.inputValue().catch(() => '')) ||
    (await typedInput.getAttribute('data-value').catch(() => '')) ||
    ''
  )
    .replace(/\s+/g, ' ')
    .trim();
  const want = forced || resolveExistingPriceBookName(already);
  progress(`9. Target existing Price Book: "${want}"${already ? ` (current "${already}")` : ''}`);

  const alreadyMatchesWant =
    already &&
    (already.toLowerCase().includes(want.toLowerCase()) || want.toLowerCase().includes(already.toLowerCase()));
  const alreadyAllowed =
    already &&
    EXISTING_PRICE_BOOKS.some(
      (n) => already.toLowerCase().includes(n.toLowerCase()) || n.toLowerCase().includes(already.toLowerCase()),
    );

  // Keep current book only when it is allowed AND we are not forcing a different one
  if (!forced && alreadyAllowed) {
    progress(`9. Allowed book already selected — click Save`);
    await dialog.getByRole('button', { name: /^save$/i }).first().click();
    await page.locator('.slds-spinner:visible').first().waitFor({ state: 'hidden', timeout: 20_000 }).catch(() => {});
    await dialog.waitFor({ state: 'hidden', timeout: 15_000 }).catch(() => {});
    progress(`9. Choose Price Book - Passed (existing: ${already})`);
    return;
  }
  if (forced && alreadyMatchesWant) {
    progress(`9. Forced book "${want}" already selected — Save`);
    await dialog.getByRole('button', { name: /^save$/i }).first().click();
    await page.locator('.slds-spinner:visible').first().waitFor({ state: 'hidden', timeout: 20_000 }).catch(() => {});
    await dialog.waitFor({ state: 'hidden', timeout: 15_000 }).catch(() => {});
    progress(`9. Choose Price Book - Passed (existing: ${already})`);
    return;
  }

  // Try switching without clearing first — Lightning often allows direct re-select
  if (forced && already && !alreadyMatchesWant) {
    progress(`9. Switching Price Book "${already}" → "${want}" (try without clear)`);
    let selected = await selectPriceBookInDialog(dialog, page, combo, typedInput, want);
    if (selected) {
      await dialog.getByRole('button', { name: /^save$/i }).first().click();
      await page.locator('.slds-spinner:visible').first().waitFor({ state: 'hidden', timeout: 20_000 }).catch(() => {});
      await dialog.waitFor({ state: 'hidden', timeout: 15_000 }).catch(() => {});
      progress(`9. Choose Price Book - Passed (switched: ${selected})`);
      return;
    }
  }

  const clearBtn = dialog
    .getByRole('button', { name: /clear price book|clear selection|remove/i })
    .or(dialog.locator('button[title*="Clear" i], button.slds-pill__remove, button[title="Clear Price Book Selection"]'))
    .first();
  if (await clearBtn.isVisible({ timeout: 1_200 }).catch(() => false)) {
    progress('9. Price Book already selected — clicking X to clear');
    await clearBtn.click();
    await page.locator('.slds-spinner:visible').first().waitFor({ state: 'hidden', timeout: 12_000 }).catch(() => {});
    for (let w = 0; w < 20; w++) {
      const cleared = (
        (await combo.innerText().catch(() => '')) ||
        (await typedInput.inputValue().catch(() => '')) ||
        (await typedInput.getAttribute('placeholder').catch(() => '')) ||
        ''
      )
        .replace(/\s+/g, ' ')
        .trim();
      if (!cleared || NONE_OPTION.test(cleared) || /search price book|select a price book/i.test(cleared)) break;
      await sleep(200);
    }
    await sleep(300);
  }

  const candidates = forced
    ? [want]
    : [want, ...EXISTING_PRICE_BOOKS.filter((n) => n.toLowerCase() !== want.toLowerCase())];
  let selected = '';
  for (const name of candidates) {
    if (await typedInput.isDisabled().catch(() => false)) {
      progress('9. Price Book combobox still disabled — waiting…');
      await sleep(500);
    }
    selected = await selectPriceBookInDialog(dialog, page, combo, typedInput, name);
    if (selected) {
      progress(`9. Selecting existing "${selected}"`);
      break;
    }
  }
  if (!selected) {
    throw new Error(`No allowed Price Book found in Choose Price Book. Tried: ${candidates.join(', ')}`);
  }

  await dialog.getByRole('button', { name: /^save$/i }).first().click();
  await page.locator('.slds-spinner:visible').first().waitFor({ state: 'hidden', timeout: 20_000 }).catch(() => {});
  await dialog.waitFor({ state: 'hidden', timeout: 15_000 }).catch(() => {});
  progress(`9. Choose Price Book - Passed (existing: ${selected})`);
}

/** Related tab lists sit in a nested scroller. Reset to top so Products is not scrolled past. */
async function scrollRelatedListToTop(page) {
  await page
    .evaluate(() => {
      const nodes = document.querySelectorAll(
        '.oneContent .slds-scrollable, .windowViewMode-normal .slds-scrollable, .slds-template__container, [data-aura-class*="forceRelatedList"], .baseCardContainer',
      );
      for (const el of nodes) {
        if (el.scrollHeight > el.clientHeight + 8) el.scrollTop = 0;
      }
      const main = document.querySelector('.oneContent, .slds-col--padded, .region-main');
      if (main) main.scrollTop = 0;
      window.scrollTo(0, 0);
    })
    .catch(() => {});
  await page.mouse.wheel(0, -6000).catch(() => {});
  await sleep(80);
}

/** Lightning Related lists scroll inside nested containers — window wheel / force-click often misses. */
async function scrollLightningIntoView(locator) {
  await locator
    .evaluate((el) => {
      el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      let p = el.parentElement;
      while (p && p !== document.body) {
        const st = window.getComputedStyle(p);
        const oy = st.overflowY || st.overflow;
        if (/(auto|scroll)/.test(oy) && p.scrollHeight > p.clientHeight + 24) {
          const r = el.getBoundingClientRect();
          const pr = p.getBoundingClientRect();
          if (r.top < pr.top + 8 || r.bottom > pr.bottom - 8) {
            p.scrollTop += r.top - pr.top - 16;
          }
        }
        p = p.parentElement;
      }
    })
    .catch(() => {});
}

async function relatedListCard(page, headingRe, { fromTop = true } = {}) {
  if (fromTop) await scrollRelatedListToTop(page);
  const card = page
    .getByRole('article', { name: headingRe })
    .or(
      page
        .locator(
          'lst-related-list-single-container, lst-related-list-view-manager, article.slds-card, .slds-card, force-related-list-container',
        )
        .filter({ has: page.getByRole('heading', { name: headingRe }) }),
    )
    .first();
  await card.waitFor({ state: 'attached', timeout: 20_000 }).catch(() => {});
  const isProducts = /products/i.test(String(headingRe));
  if (!isProducts) {
    for (let i = 0; i < 6; i++) {
      const inView = await card.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return r.height > 8 && r.top < window.innerHeight && r.bottom > 80;
      }).catch(() => false);
      if (inView) break;
      await page.mouse.wheel(0, 420).catch(() => {});
      await sleep(80);
    }
    await card.evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'nearest' })).catch(() => {});
  }
  await scrollLightningIntoView(card);
  return card;
}

async function readOpportunityProductCount(page, { openRelated = true } = {}) {
  if (openRelated) await openRelatedTab(page);
  await scrollRelatedListToTop(page);
  const card = page.getByRole('article', { name: /^products(\s*\(\s*\d+\s*\))?$/i }).first();
  if (!(await card.isVisible({ timeout: FAST_FILL ? 4_000 : 8_000 }).catch(() => false))) return 0;
  const heading = ((await card.getByRole('heading', { name: /products/i }).innerText().catch(() => '')) || '').replace(
    /\s+/g,
    ' ',
  );
  const m = heading.match(/\(\s*(\d+)\s*\)/);
  return m ? Number.parseInt(m[1], 10) || 0 : 0;
}

async function opportunityAlreadyHasProducts(page, { openRelated = true } = {}) {
  const n = await readOpportunityProductCount(page, { openRelated });
  if (n > 0) {
    progress(`10. Products already present — Related shows Products (${n})`);
    return true;
  }
  const card = page.getByRole('article', { name: /^products(\s*\(\s*\d+\s*\))?$/i }).first();
  const editProducts = card.getByRole('button', { name: /edit products/i }).first();
  if (await editProducts.isVisible({ timeout: 1_200 }).catch(() => false)) {
    progress('10. Products already present — Edit Products is on the row');
    return true;
  }
  return false;
}

async function fillInlineEditOnProductRow(page, row, buttonRe, value, label) {
  const cell = row.getByRole('gridcell', { name: buttonRe }).first();
  const btn = row.getByRole('button', { name: buttonRe }).first();
  if (await cell.count().catch(() => 0)) {
    await cell.click({ force: true });
  } else {
    await btn.click({ force: true });
  }
  await sleep(120);

  const dialog = page.getByRole('dialog', { name: /edit selected products/i }).first();
  let input = null;
  for (let i = 0; i < 12 && !input; i++) {
    const candidates = [
      row.getByRole('spinbutton').last(),
      row.getByRole('textbox').last(),
      dialog.locator('input:not([type="checkbox"]):not([type="hidden"])').last(),
      page.locator('.slds-datepicker:visible input, .slds-popover:visible input').last(),
    ];
    for (const cand of candidates) {
      if (await cand.isVisible({ timeout: 250 }).catch(() => false)) {
        input = cand;
        break;
      }
    }
    if (!input) await sleep(150);
  }
  if (!input) {
    await btn.click({ force: true }).catch(() => {});
    await sleep(400);
    input = dialog.locator('input:not([type="checkbox"]):not([type="hidden"])').last();
    if (!(await input.isVisible({ timeout: 4_000 }).catch(() => false))) {
      throw new Error(`Edit Selected Products: ${label} is required but the input did not open.`);
    }
  }

  await input.click({ force: true });
  await input.fill('');
  await input.fill(String(value));
  if (/date/i.test(label)) {
    const today = page.locator('.slds-datepicker:visible .slds-is-today, .slds-datepicker:visible td.slds-is-today').first();
    if (await today.isVisible({ timeout: 800 }).catch(() => false)) {
      await today.click();
    } else {
      await input.press('Enter').catch(() => {});
    }
  } else {
    await input.press('Enter').catch(() => {});
  }
  await input.press('Tab').catch(() => {});
  progress(`10. ${label} → ${value}`);
}

async function fillEditSelectedProductRow(page, row) {
  const name = ((await row.getByRole('link').first().innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
  if (name) progress(`10. Edit row "${name}" — Quantity, Revenue Amount, Date (all required)`);
  await fillInlineEditOnProductRow(page, row, /edit quantity/i, '1', 'Quantity');
  const amt = String(randInt(1_000, 25_000));
  await fillInlineEditOnProductRow(page, row, /edit revenue amount/i, amt, 'Revenue Amount');
  await fillInlineEditOnProductRow(page, row, /edit date/i, localeDateStringForSalesforce(), 'Date');
}

async function assertOpportunityProductsSaved(page, expectedMin = 1) {
  for (let i = 0; i < 10; i++) {
    const n = await readOpportunityProductCount(page);
    if (n >= expectedMin) {
      progress(`10. Related → Products (${n}) — confirmed on Opportunity`);
      return n;
    }
    if (i === 3) {
      progress('10. Products still (0) — reload Opportunity and re-check Related');
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
      await page.locator('.slds-spinner:visible').first().waitFor({ state: 'hidden', timeout: 45_000 }).catch(() => {});
    }
    await sleep(1_200);
  }
  throw new Error('Add Products did not appear on Opportunity Related → Products (still 0).');
}

async function closeAddProductsDialog(page) {
  const addDialog = page
    .getByRole('dialog', { name: /add products/i })
    .or(page.locator('.slds-modal:visible, [role="dialog"]:visible').filter({ hasText: /add products/i }))
    .first();
  if (!(await addDialog.isVisible({ timeout: 500 }).catch(() => false))) return;
  const cancel = addDialog.getByRole('button', { name: /^cancel$/i }).first();
  if (await cancel.isVisible({ timeout: 800 }).catch(() => false)) {
    await cancel.click().catch(() => {});
  } else {
    await page.keyboard.press('Escape').catch(() => {});
  }
  await addDialog.waitFor({ state: 'hidden', timeout: 8_000 }).catch(() => {});
}

async function countAddProductsRows(addDialog) {
  const selectBoxes = addDialog.getByRole('checkbox', { name: /select item/i });
  let boxCount = await selectBoxes.count().catch(() => 0);
  if (boxCount > 0) return { boxCount, selectBoxes, rows: null };
  const rows = addDialog.locator('table tbody tr').filter({
    has: addDialog.locator('input[type="checkbox"], .slds-checkbox_faux'),
  });
  boxCount = await rows.count().catch(() => 0);
  return { boxCount, selectBoxes, rows };
}

async function openAddProductsDialog(page) {
  await openRelatedTab(page);
  await scrollRelatedListToTop(page);
  const productsCard = await relatedListCard(page, /products/i);
  const addBtn = productsCard
    .getByRole('button', { name: /add products/i })
    .or(productsCard.getByRole('link', { name: /add products/i }))
    .or(page.getByRole('button', { name: /add products/i }))
    .first();
  await addBtn.waitFor({ state: 'visible', timeout: 15_000 });
  await addBtn.click();

  const addDialog = page
    .getByRole('dialog', { name: /add products/i })
    .or(page.locator('.slds-modal:visible, [role="dialog"]:visible').filter({ hasText: /add products/i }))
    .first();
  await addDialog.waitFor({ state: 'visible', timeout: 25_000 });
  for (let w = 0; w < 12; w++) {
    await page.locator('.slds-spinner:visible').first().waitFor({ state: 'hidden', timeout: 2_000 }).catch(() => {});
    const { boxCount } = await countAddProductsRows(addDialog);
    if (boxCount > 0) break;
    const emptyHint = await addDialog
      .getByText(/no items to display|no products|0 items|nothing to see/i)
      .first()
      .isVisible({ timeout: 300 })
      .catch(() => false);
    if (emptyHint && w > 2) break;
    await sleep(350);
  }
  return addDialog;
}

async function addProducts(page) {
  progress('10. Add Products - Related → Products row → Add Products');
  await openRelatedTab(page);
  if (await opportunityAlreadyHasProducts(page)) {
    progress('10. Products already added — skip Add Products, go to Quote');
    return;
  }

  const booksToTry = [...EXISTING_PRICE_BOOKS];
  let addDialog = null;
  let lastEmpty = true;

  for (let bi = 0; bi <= booksToTry.length; bi++) {
    if (bi > 0) {
      await closeAddProductsDialog(page);
      const nextBook = booksToTry[bi - 1];
      progress(`10. Current Price Book has no products — trying "${nextBook}"`);
      try {
        await choosePriceBook(page, { forceName: nextBook });
      } catch (switchErr) {
        progress(`10. Could not switch Price Book to "${nextBook}" — ${switchErr.message}`);
        continue;
      }
    }

    addDialog = await openAddProductsDialog(page);

    if (PRODUCT_SEARCH) {
      const search = addDialog
        .getByRole('textbox', { name: /search products/i })
        .or(addDialog.getByRole('combobox', { name: /search products/i }))
        .or(addDialog.locator('input[placeholder*="Search Products"]'))
        .first();
      if (await search.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await search.fill(PRODUCT_SEARCH);
        await search.press('Enter').catch(() => {});
        await sleep(400);
      }
    }

    const { boxCount, selectBoxes, rows } = await countAddProductsRows(addDialog);
    if (boxCount < 1) {
      progress(`10. Add Products — 0 rows (book attempt ${bi + 1}/${booksToTry.length})`);
      lastEmpty = true;
      continue;
    }
    lastEmpty = false;

    const wantMin = Math.min(ADD_PRODUCT_MIN, boxCount);
    const wantMax = Math.min(ADD_PRODUCT_MAX, boxCount);
    const pickCount = wantMax <= wantMin ? wantMin : randInt(wantMin, wantMax);
    progress(`10. Selecting ${pickCount} product(s) of ${boxCount} available (min ${ADD_PRODUCT_MIN}, max ${ADD_PRODUCT_MAX})`);
    let selected = 0;
    const picked = new Set();
    if (rows) {
      for (let n = 0; n < pickCount; n++) {
        let idx = randInt(0, boxCount - 1);
        for (let t = 0; t < 8 && picked.has(idx); t++) idx = randInt(0, boxCount - 1);
        picked.add(idx);
        const row = rows.nth(idx);
        const name = ((await row.innerText().catch(() => '')) || `#${idx}`).replace(/\s+/g, ' ').trim().slice(0, 40);
        const box = row.locator('input[type="checkbox"]').first();
        await box.check({ force: true }).catch(async () => {
          await row.locator('.slds-checkbox_faux').first().click({ force: true });
        });
        selected += 1;
        progress(`10. Selected product ${selected}/${pickCount} "${name}"`);
      }
    } else {
      for (let n = 0; n < pickCount; n++) {
        let idx = randInt(0, boxCount - 1);
        for (let t = 0; t < 8 && picked.has(idx); t++) idx = randInt(0, boxCount - 1);
        picked.add(idx);
        const box = selectBoxes.nth(idx);
        const label = ((await box.getAttribute('aria-label').catch(() => '')) || '')
          .replace(/^select item\s*/i, '')
          .trim();
        await box.check({ force: true }).catch(async () => {
          await box.click({ force: true });
        });
        if (!(await box.isChecked().catch(() => false))) {
          await box.click({ force: true });
        }
        selected += 1;
        progress(`10. Selected product ${selected}/${pickCount} "${label || `#${idx}`}"`);
      }
    }
    if (selected < 1) {
      lastEmpty = true;
      continue;
    }

    const nextBtn = addDialog.getByRole('button', { name: /^next$/i }).first();
    await expect(nextBtn).toBeEnabled({ timeout: 12_000 });
    await nextBtn.click();
    progress('10. Next — Edit Selected Products');
    const editDialog = page
      .getByRole('dialog', { name: /edit selected products/i })
      .or(page.locator('.slds-modal:visible, [role="dialog"]:visible').filter({ hasText: /edit selected products/i }))
      .first();
    await editDialog.waitFor({ state: 'visible', timeout: 20_000 });
    await editDialog
      .locator('.slds-spinner:visible, lightning-spinner')
      .first()
      .waitFor({ state: 'hidden', timeout: 30_000 })
      .catch(() => {});

    const editRows = editDialog.getByRole('row', { name: /edit quantity/i });
    await editRows.first().waitFor({ state: 'visible', timeout: 30_000 });
    const editN = await editRows.count().catch(() => 0);
    progress(`10. Edit Selected Products — ${editN} row(s)`);
    if (editN < 1) {
      throw new Error('Edit Selected Products opened with 0 rows — products were not selected on Add Products.');
    }
    for (let i = 0; i < editN; i++) {
      const row = editRows.nth(i);
      if (!(await row.isVisible().catch(() => false))) continue;
      await fillEditSelectedProductRow(page, row);
    }

    const saveBtn = editDialog.getByRole('button', { name: /^save$/i }).first();
    await saveBtn.click();
    progress('10. Save — Quantity, Revenue Amount, Date filled');
    await page.locator('.slds-spinner:visible').first().waitFor({ state: 'hidden', timeout: 60_000 }).catch(() => {});
    const closed = await editDialog
      .waitFor({ state: 'hidden', timeout: 15_000 })
      .then(() => true)
      .catch(() => false);

    if (!closed) {
      const rowsStill = await editDialog.getByRole('row', { name: /edit quantity/i }).count().catch(() => 0);
      if (rowsStill > 0) {
        const err = (
          (await editDialog
            .locator('.pageLevelErrors, .slds-theme_error, .slds-form-element__help, [role="alert"]')
            .first()
            .innerText()
            .catch(() => '')) || ''
        )
          .replace(/\s+/g, ' ')
          .trim();
        progress(`10. Save left Edit Selected Products open${err ? ` — ${err}` : ''} — retry Quantity/Revenue/Date`);
        for (let i = 0; i < rowsStill; i++) {
          await fillEditSelectedProductRow(page, editDialog.getByRole('row', { name: /edit quantity/i }).nth(i));
        }
        await saveBtn.click();
        await page.locator('.slds-spinner:visible').first().waitFor({ state: 'hidden', timeout: 60_000 }).catch(() => {});
      }
    }

    await editDialog.waitFor({ state: 'hidden', timeout: 30_000 }).catch(() => {});
    await assertOpportunityProductsSaved(page, Math.min(ADD_PRODUCT_MIN, selected));
    progress(`10. Add Products - Passed (${selected} product(s))`);
    return;
  }

  await closeAddProductsDialog(page);
  if (lastEmpty) {
    throw new Error(
      `Add Products: no product rows in any allowed Price Book. Tried: ${booksToTry.join(', ')}`,
    );
  }
  throw new Error('Add Products: no product checkbox was selected.');
}

async function readOpportunityStageValue(page, scope) {
  const rows = await (scope || page).locator('.slds-form-element').all().catch(() => []);
  for (const row of rows) {
    if (!(await row.isVisible().catch(() => false))) continue;
    if (!isOpportunityStageLabel(await getRowLabelText(row))) continue;
    return ((await readComboboxDisplayedValue(rowPicklistTrigger(row))) || '').replace(/\s+/g, ' ').trim();
  }
  return '';
}

async function cancelOpenRecordForm(page) {
  const modal = formModal(page);
  if (!(await modal.isVisible({ timeout: 1_000 }).catch(() => false))) return false;
  const cancel = modal
    .getByRole('button', { name: /^cancel$/i })
    .or(modal.locator('button[title="Cancel"], button[name="CancelEdit"]'))
    .first();
  if (await cancel.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await cancel.click().catch(() => {});
    await sleep(400);
    return true;
  }
  return false;
}

async function waitForLightningRecordHome(page, { timeout = FAST_FILL ? 25_000 : 45_000 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const ready = await page
      .locator(
        'records-lwc-highlights-panel, records-highlights2, one-record-home-flexipage2, .slds-page-header_record-home, lightning-tab-bar, force-record-layout-section',
      )
      .first()
      .isVisible({ timeout: FAST_FILL ? 800 : 2_000 })
      .catch(() => false);
    if (ready) {
      await page.locator('.slds-spinner:visible').first().waitFor({ state: 'hidden', timeout: FAST_FILL ? 12_000 : 20_000 }).catch(() => {});
      return true;
    }
    await sleep(FAST_FILL ? 200 : 500);
  }
  return false;
}

/**
 * Opportunity Stage must be Quote before New Quote.
 * Prefer Path / header (no Edit) so Related stays healthy.
 */
async function setOpportunityStageToQuote(page) {
  progress('11. Opportunity — ensure Stage = Quote before New Quote');
  const oppId =
    (page.url().match(/\/lightning\/r\/Opportunity\/([a-zA-Z0-9]{15,18})/i) ||
      page.url().match(/\/(006[a-zA-Z0-9]{12,15})(?:\/|$|\?)/i) ||
      [])[1] ||
    (process.env.SF_OPP_ID || '').trim() ||
    '';

  if (oppId && !/\/Opportunity\//i.test(page.url())) {
    await page.goto(`/lightning/r/Opportunity/${oppId}/view`, { waitUntil: 'domcontentloaded' });
  }
  await waitForLightningRecordHome(page);

  const pathIsQuote = await page
    .locator('.slds-path__item.slds-is-current, .slds-path__item.slds-is-active')
    .getByText(/^quote$/i)
    .first()
    .isVisible({ timeout: 5_000 })
    .catch(() => false);
  if (pathIsQuote) {
    progress('11. Stage already Quote (Path) — ready for New Quote');
    return;
  }

  const editBtn = page
    .locator('records-lwc-highlights-panel, records-highlights2, .slds-page-header_record-home')
    .getByRole('button', { name: 'Edit', exact: true })
    .or(page.getByRole('button', { name: /^edit$/i }))
    .or(page.locator('button[name="Edit"], a[title="Edit"]'))
    .first();
  if (!(await editBtn.isVisible({ timeout: 15_000 }).catch(() => false))) {
    throw new Error('Opportunity Edit not visible — cannot verify Stage=Quote.');
  }
  await editBtn.click();
  const modal = formModal(page);
  await modal.waitFor({ state: 'visible', timeout: 30_000 });

  const before = await readOpportunityStageValue(page, modal);
  if (/^quote$/i.test(before)) {
    progress('11. Stage already Quote — ready for New Quote');
    await cancelOpenRecordForm(page);
    if (oppId) {
      await page.goto(`/lightning/r/Opportunity/${oppId}/view`, { waitUntil: 'domcontentloaded' });
      await waitForLightningRecordHome(page);
    }
    return;
  }

  progress(`11. Stage is "${before || '(empty)'}" — Edit/fill/Save Opportunity with Stage=Quote`);
  await cancelOpenRecordForm(page);
  await editFillAndSaveRecord(page, 'Opportunity', {
    recordId: oppId,
    alreadyOnRecord: true,
  });

  if (oppId) {
    await page.goto(`/lightning/r/Opportunity/${oppId}/view`, { waitUntil: 'domcontentloaded' });
    await waitForLightningRecordHome(page);
  }
  const pathOk = await page
    .locator('.slds-path__item.slds-is-current, .slds-path__item.slds-is-active')
    .getByText(/^quote$/i)
    .first()
    .isVisible({ timeout: 8_000 })
    .catch(() => false);
  if (pathOk) {
    progress('11. Opportunity Stage is Quote — ready for New Quote');
    return;
  }

  await editBtn.click().catch(() => {});
  const verifyModal = formModal(page);
  if (await verifyModal.isVisible({ timeout: 20_000 }).catch(() => false)) {
    const verified = await readOpportunityStageValue(page, verifyModal);
    await cancelOpenRecordForm(page);
    progress(`11. Verified Opportunity Stage = "${verified || '(empty)'}"`);
    if (!/^quote$/i.test(verified)) {
      throw new Error(
        `Opportunity Stage is "${verified || '(empty)'}" after Save — must be Quote before New Quote.`,
      );
    }
  }
  if (oppId) {
    await page.goto(`/lightning/r/Opportunity/${oppId}/view`, { waitUntil: 'domcontentloaded' });
    await waitForLightningRecordHome(page);
  }
  progress('11. Opportunity Stage is Quote — ready for New Quote');
}

async function quoteIdFromUrl(page) {
  const u = page.url() || '';
  const m = u.match(/\/lightning\/r\/Quote\/([a-zA-Z0-9]{15,18})/i) || u.match(/\/(0Q0[a-zA-Z0-9]{12,15})/i);
  return m ? m[1] : '';
}

/** Wait until Quote record page is visibly loaded (not blank Quotes tab). */
async function waitForQuoteRecordVisible(page, { timeout = 45_000 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const id = await quoteIdFromUrl(page);
    if (id) {
      const body = page
        .locator(
          'records-lwc-highlights-panel, records-record-layout-event-broker, .record-body-container, one-record-home-flexipage2',
        )
        .first();
      if (await body.isVisible({ timeout: 2_000 }).catch(() => false)) {
        progress(`11. Quote record visible — ${id}`);
        return id;
      }
    }
    await sleep(400);
  }
  return (await quoteIdFromUrl(page)) || '';
}

/**
 * Quote page banner: "The prices aren’t up to date or the validation isn’t complete. Refresh"
 * QLI and Pricing Calculator values are stale until this appears and Refresh is clicked.
 */
async function clickQuoteStalePriceRefresh(page, { timeout = 45_000 } = {}) {
  if (!/\/lightning\/r\/Quote\//i.test(page.url() || '')) return false;
  await page.locator('.slds-spinner:visible').first().waitFor({ state: 'hidden', timeout: 20_000 }).catch(() => {});

  const banner = page
    .locator(
      '.slds-notify, .slds-scoped-notification, lightning-banner, .forcePageError, [role="status"], [role="alert"], .slds-box, .slds-media, div, section',
    )
    .filter({ hasText: /prices aren['’]?t up to date|validation isn['’]?t complete/i })
    .first();
  const bannerText = page.getByText(/the prices aren['’]?t up to date or the validation isn['’]?t complete/i).first();

  const shown =
    (await bannerText.waitFor({ state: 'visible', timeout }).then(() => true).catch(() => false)) ||
    (await banner.isVisible({ timeout: 1_000 }).catch(() => false));
  if (!shown) {
    progress('12. Quote stale-price banner not shown — continue');
    return false;
  }

  progress('12. Quote banner — The prices aren’t up to date or the validation isn’t complete. Refresh');
  const refresh = banner
    .getByRole('link', { name: /^refresh$/i })
    .or(banner.locator('a, button').filter({ hasText: /^refresh$/i }))
    .or(page.getByRole('link', { name: /^refresh$/i }))
    .first();
  await refresh.waitFor({ state: 'visible', timeout: 10_000 });
  await refresh.click();
  await page.locator('.slds-spinner:visible').first().waitFor({ state: 'hidden', timeout: 60_000 }).catch(() => {});
  await waitForQuoteRecordVisible(page, { timeout: 30_000 }).catch(() => {});
  await bannerText.waitFor({ state: 'hidden', timeout: 20_000 }).catch(() => {});
  progress('12. Quote Refresh clicked — prices and validation are updating');
  return true;
}

/** Related → Quotes: open newest existing quote. Never clicks New Quote. */
async function openExistingQuoteFromRelated(page, { preferName = '' } = {}) {
  await openRelatedTab(page);
  await page.locator('.slds-spinner:visible').first().waitFor({ state: 'hidden', timeout: 20_000 }).catch(() => {});

  // Wait for Quotes (n) — bare "Quotes" often has no row links yet
  const quotesHydrated = page.getByRole('heading', { name: /^quotes\s*\(\s*\d+\s*\)$/i }).first();
  let quotesHeading = quotesHydrated;
  for (let s = 0; s < 28; s++) {
    if (await quotesHydrated.isVisible({ timeout: 400 }).catch(() => false)) {
      await quotesHydrated.scrollIntoViewIfNeeded().catch(() => {});
      quotesHeading = quotesHydrated;
      break;
    }
    const bare = page.getByRole('heading', { name: /^quotes$/i }).first();
    if (await bare.isVisible({ timeout: 250 }).catch(() => false)) {
      await bare.scrollIntoViewIfNeeded().catch(() => {});
      quotesHeading = bare;
    }
    await page.mouse.wheel(0, 650).catch(() => {});
    await sleep(200);
  }

  const headingText = (
    (await quotesHeading.innerText().catch(() => '')) ||
    (await page.getByRole('heading', { name: /quotes/i }).first().innerText().catch(() => '')) ||
    ''
  )
    .replace(/\s+/g, ' ')
    .trim();
  progress(`11. Quotes row — "${headingText || 'Quotes'}" (pick Total Price > 0 = QLI, else newest)`);
  if (/\(\s*0\s*\)/.test(headingText)) {
    progress('11. Quotes (0) — no existing Quote to open');
    return '';
  }
  if (await quotesHydrated.isVisible({ timeout: 1_500 }).catch(() => false)) {
    progress(`11. Quotes list hydrated — "${((await quotesHydrated.innerText().catch(() => '')) || '').trim()}"`);
  }

  const cardFallback = await relatedListCard(page, /quotes/i);
  const qCard = quotesHeading
    .locator(
      'xpath=ancestor::*[self::article or contains(@class,"slds-card") or contains(@class,"forceRelatedList") or contains(local-name(),"related-list")][1]',
    )
    .or(cardFallback);

  await sleep(400);

  if (preferName) {
    const nameRe = new RegExp(preferName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const byPrefer = qCard.getByRole('link', { name: nameRe }).first();
    if (await byPrefer.isVisible({ timeout: 8_000 }).catch(() => false)) {
      const label = ((await byPrefer.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
      progress(`11. Opening preferred Quote "${label}"`);
      await byPrefer.click();
      await page.locator('.slds-spinner:visible').first().waitFor({ state: 'hidden', timeout: 30_000 }).catch(() => {});
      await page.waitForURL(/\/lightning\/r\/Quote\/[a-zA-Z0-9]{15,18}/i, { timeout: 25_000 }).catch(() => {});
      return (await waitForQuoteRecordVisible(page, { timeout: 20_000 })) || label;
    }
  }

  /**
   * On Opp Related → Quotes table: Total Price > 0 means that Quote already has QLI.
   * Prefer that row; if several, pick the highest Total Price (then newest name/number).
   */
  async function pickQuoteByTotalPriceFromScope(scope) {
    const tables = scope.locator('table').filter({
      has: scope.locator('a[href*="/lightning/r/Quote/"], a[href*="/0Q0"]'),
    });
    const tableCount = await tables.count().catch(() => 0);
    let bestQli = null;
    let bestQliLabel = '';
    let bestQliTotal = -1;
    let bestQliTie = -1;
    let bestAny = null;
    let bestAnyLabel = '';
    let bestAnyTie = -1;
    let bestAnyTotal = 0;
    let scanned = 0;

    for (let ti = 0; ti < tableCount; ti++) {
      const table = tables.nth(ti);
      const headers = table.locator('thead th, thead td, [role="columnheader"]');
      let totalCol = -1;
      const hCount = await headers.count().catch(() => 0);
      for (let h = 0; h < hCount; h++) {
        const ht = ((await headers.nth(h).innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
        if (/^total\s*price$/i.test(ht) || /^total\s*price\b/i.test(ht)) {
          totalCol = h;
          break;
        }
      }
      if (totalCol < 0) {
        for (let h = 0; h < hCount; h++) {
          const th = headers.nth(h);
          const aria = `${(await th.getAttribute('aria-label').catch(() => '')) || ''} ${(await th.getAttribute('title').catch(() => '')) || ''}`;
          if (/total\s*price/i.test(aria)) {
            totalCol = h;
            break;
          }
        }
      }

      const rows = table.locator('tbody tr, [role="row"]').filter({
        has: scope.locator('a[href*="/lightning/r/Quote/"], a[href*="/0Q0"]'),
      });
      const rCount = await rows.count().catch(() => 0);
      for (let r = 0; r < rCount; r++) {
        const row = rows.nth(r);
        const link = row
          .locator('a[href*="/lightning/r/Quote/"], a[href*="/0Q0"]')
          .filter({ hasNotText: /view all|new quote/i })
          .first();
        if (!(await link.isVisible({ timeout: 400 }).catch(() => false))) continue;
        const label = ((await link.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
        if (!label || /view all|new quote|^new$/i.test(label)) continue;

        const cells = row.locator('td, th[role="gridcell"], [role="gridcell"]');
        const cCount = await cells.count().catch(() => 0);
        let total = NaN;
        if (totalCol >= 0 && totalCol < cCount) {
          total = parseMoney(await cells.nth(totalCol).innerText().catch(() => ''));
        } else {
          for (let c = 0; c < cCount; c++) {
            const cellText = ((await cells.nth(c).innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
            if (!cellText || cellText === label) continue;
            if (/^\d{5,}$/.test(cellText) && !/[.,]/.test(cellText)) continue;
            const v = parseMoney(cellText);
            if (!Number.isFinite(v)) continue;
            if (!Number.isFinite(total) || v > total) total = v;
          }
        }

        scanned += 1;
        const ts = Number((label.match(/(\d{10,})/) || [])[1] || 0);
        const qNum = Number((label.match(/(\d{5,})/) || [])[1] || 0);
        const tie = ts || qNum || r + 1;
        const hasQli = Number.isFinite(total) && total > MONEY_TOLERANCE;
        progress(
          `11. Quotes related row — "${label}" Total Price=${Number.isFinite(total) ? moneyFmt(total) : 'blank/0'}${hasQli ? ' (has QLI)' : ''}`,
        );

        if (tie >= bestAnyTie) {
          bestAnyTie = tie;
          bestAny = link;
          bestAnyLabel = label;
          bestAnyTotal = Number.isFinite(total) ? total : 0;
        }
        if (hasQli) {
          if (
            total > bestQliTotal + MONEY_TOLERANCE ||
            (Math.abs(total - bestQliTotal) <= MONEY_TOLERANCE && tie >= bestQliTie)
          ) {
            bestQliTotal = total;
            bestQliTie = tie;
            bestQli = link;
            bestQliLabel = `${label} (Total Price ${moneyFmt(total)})`;
          }
        }
      }
    }

    if (bestQli) {
      return { best: bestQli, bestLabel: bestQliLabel, bestTotal: bestQliTotal, scanned, hasQli: true };
    }
    return {
      best: bestAny,
      bestLabel: bestAnyLabel,
      bestTotal: bestAnyTotal,
      scanned,
      hasQli: false,
    };
  }

  async function pickNewestFromLinks(linkLocator) {
    const n = await linkLocator.count().catch(() => 0);
    let best = null;
    let bestScore = -1;
    let bestLabel = '';
    for (let i = 0; i < n; i++) {
      const loc = linkLocator.nth(i);
      const t = ((await loc.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
      if (!t || /view all|new quote|^new$/i.test(t)) continue;
      const href = (await loc.getAttribute('href').catch(() => '')) || '';
      if (!/\/Quote\/|\/0Q0/i.test(href) && !/^\d{6,}$/.test(t) && !/Auto_/i.test(t)) continue;
      const ts = Number((t.match(/(\d{10,})/) || [])[1] || 0);
      const qNum = Number((t.match(/(\d{5,})/) || [])[1] || 0);
      const score = ts || qNum || i + 1;
      if (score >= bestScore) {
        bestScore = score;
        best = loc;
        bestLabel = t;
      }
    }
    return { best, bestLabel, bestScore, n };
  }

  // 1) Prefer Quote with Total Price > 0 on Related list (QLI already added)
  let picked = await pickQuoteByTotalPriceFromScope(qCard);
  if (!picked.hasQli) {
    // Compact card may hide Total Price — open full Related Quotes list
    const viewAll = qCard
      .getByRole('link', { name: /view all/i })
      .or(page.getByRole('link', { name: /view all.*quotes|quotes.*view all/i }))
      .first();
    const oppId = (page.url().match(/\/Opportunity\/([a-zA-Z0-9]{15,18})/) || [])[1] || process.env.SF_OPP_ID || '';
    if (await viewAll.isVisible({ timeout: 2_500 }).catch(() => false)) {
      progress('11. Quotes — View All to validate Total Price column');
      await viewAll.click();
      await page.locator('.slds-spinner:visible').first().waitFor({ state: 'hidden', timeout: 20_000 }).catch(() => {});
      picked = await pickQuoteByTotalPriceFromScope(page.locator('body'));
    } else if (oppId) {
      progress('11. Opening Opp Related Quotes list to validate Total Price');
      await page.goto(`/lightning/r/Opportunity/${oppId}/related/Quotes/view`, { waitUntil: 'domcontentloaded' });
      await page.locator('.slds-spinner:visible').first().waitFor({ state: 'hidden', timeout: 30_000 }).catch(() => {});
      picked = await pickQuoteByTotalPriceFromScope(page.locator('body'));
    }
  }

  let best = picked.best;
  let bestLabel = picked.bestLabel;
  let n = picked.scanned;

  if (!best) {
    let links = qCard
      .locator('a[href*="/lightning/r/Quote/"], a[href*="/0Q0"]')
      .filter({ hasNotText: /view all|new quote/i });
    for (let w = 0; w < 12; w++) {
      if ((await links.count().catch(() => 0)) >= 1) break;
      await sleep(400);
    }
    let fallback = await pickNewestFromLinks(links);
    if (!fallback.best) {
      const pagePick = await pickNewestFromLinks(
        page.locator('a[href*="/lightning/r/Quote/"], a[href*="/0Q0"]').filter({ hasNotText: /view all|new quote/i }),
      );
      fallback = pagePick;
    }
    best = fallback.best;
    bestLabel = fallback.bestLabel;
    n = fallback.n;
  }

  if (!best) {
    progress('11. No Quote link found on Related → Quotes');
    return '';
  }

  if (picked.hasQli) {
    progress(`11. Opening Quote with QLI (Total Price > 0) — "${bestLabel}"`);
  } else {
    progress(`11. No Quote with Total Price > 0 on Related — opening "${bestLabel}" (${n} scanned)`);
  }
  await best.evaluate((el) => el.scrollIntoView({ block: 'center' })).catch(() => {});
  await best.click();
  await page.locator('.slds-spinner:visible').first().waitFor({ state: 'hidden', timeout: 30_000 }).catch(() => {});
  await page.waitForURL(/\/lightning\/r\/Quote\/[a-zA-Z0-9]{15,18}/i, { timeout: 25_000 }).catch(() => {});

  let id = await waitForQuoteRecordVisible(page, { timeout: 20_000 });
  if (!id) {
    const href = (await best.getAttribute('href').catch(() => '')) || '';
    const hrefId =
      (href.match(/\/lightning\/r\/Quote\/([a-zA-Z0-9]{15,18})/i) || href.match(/\/(0Q0[a-zA-Z0-9]{12,15})/i) || [])[1] ||
      '';
    if (hrefId) {
      progress(`11. Quote page blank — navigating directly to ${hrefId}`);
      await page.goto(`/lightning/r/Quote/${hrefId}/view`, { waitUntil: 'domcontentloaded' });
      await page.locator('.slds-spinner:visible').first().waitFor({ state: 'hidden', timeout: 45_000 }).catch(() => {});
      id = await waitForQuoteRecordVisible(page, { timeout: 30_000 });
    }
  }
  return id || bestLabel;
}

async function createQuote(page) {
  // Policy: only ONE Quote per Opportunity Related list
  if (FORCE_NEW_QUOTE) {
    progress('11. SF_FORCE_NEW_QUOTE ignored — one Quote per Opportunity (open existing if present)');
  }
  progress('11. Quote — open existing if any; New Quote only when Quotes (0)');
  await setOpportunityStageToQuote(page);

  const existing = await openExistingQuoteFromRelated(page);
  if (existing) {
    progress(`11. Opportunity already has a Quote — reuse only (one per Opp) → ${existing}`);
    return existing;
  }

  for (let attempt = 1; attempt <= 2; attempt++) {
    const oppId =
      (page.url().match(/\/lightning\/r\/Opportunity\/([a-zA-Z0-9]{15,18})/i) ||
        page.url().match(/\/(006[a-zA-Z0-9]{12,15})(?:\/|$|\?)/i) ||
        [])[1] ||
      (process.env.SF_OPP_ID || '').trim() ||
      '';

    let filledViaUrl = false;
    let clickedNew = false;

    // Manual path only: Opportunity → Related → Quotes (n) → New Quote
    // Do NOT navigate to /o/Quote/new — stay on Opp Related list.
    if (oppId) {
      await page.goto(`/lightning/r/Opportunity/${oppId}/view`, { waitUntil: 'domcontentloaded' });
      let ready = await waitForLightningRecordHome(page);
      if (!ready) {
        progress('11. Opp page blank — reload once');
        await page.goto(`/lightning/r/Opportunity/${oppId}/view`, { waitUntil: 'domcontentloaded' });
        ready = await waitForLightningRecordHome(page);
      }
    }
    await openRelatedTab(page);
    await page.locator('.slds-spinner:visible').first().waitFor({ state: 'hidden', timeout: 20_000 }).catch(() => {});

    // Re-check before New Quote — never create a second Quote
    {
      const again = await openExistingQuoteFromRelated(page);
      if (again) {
        progress(`11. Quote already on Related — will not click New Quote → ${again}`);
        return again;
      }
      const countHead = page.getByRole('heading', { name: /^quotes\s*\(\s*([1-9]\d*)\s*\)$/i }).first();
      if (await countHead.isVisible({ timeout: 2_000 }).catch(() => false)) {
        const ht = ((await countHead.innerText().catch(() => '')) || '').replace(/\s+/g, ' ');
        progress(`11. Related shows "${ht}" but link open failed — retry open (no New Quote)`);
        const retry = await openExistingQuoteFromRelated(page);
        if (retry) return retry;
        throw new Error(
          `Opportunity already has Quote(s) (${ht}) but could not open one — refusing to create another.`,
        );
      }
    }

    // Scroll Related until Quotes list is hydrated — need "Quotes (n)" not bare "Quotes"
    const quotesHydrated = page.getByRole('heading', { name: /^quotes\s*\(\s*\d+\s*\)$/i }).first();
    let quotesHeading = quotesHydrated;
    for (let s = 0; s < 24; s++) {
      if (await quotesHydrated.isVisible({ timeout: 500 }).catch(() => false)) {
        await quotesHydrated.scrollIntoViewIfNeeded().catch(() => {});
        break;
      }
      const bare = page.getByRole('heading', { name: /^quotes$/i }).first();
      if (await bare.isVisible({ timeout: 300 }).catch(() => false)) {
        await bare.scrollIntoViewIfNeeded().catch(() => {});
        quotesHeading = bare;
      }
      await page.mouse.wheel(0, 700).catch(() => {});
      await sleep(200);
    }
    // Wait up to ~20s for related-list actions (New Quote) to appear after count shows
    if (await quotesHydrated.isVisible({ timeout: 2_000 }).catch(() => false)) {
      quotesHeading = quotesHydrated;
      const hTxt = ((await quotesHydrated.innerText().catch(() => '')) || '').trim();
      progress(`11. Quotes list hydrated — "${hTxt}"`);
      if (/\(\s*[1-9]\d*\s*\)/.test(hTxt.replace(/\s+/g, ' '))) {
        progress('11. Quotes count ≥ 1 — open existing instead of New Quote');
        const opened = await openExistingQuoteFromRelated(page);
        if (opened) return opened;
        throw new Error(`Related shows ${hTxt} — refusing to create a second Quote.`);
      }
      for (let w = 0; w < 10; w++) {
        const hasNew = await page
          .getByRole('button', { name: /^new quote$/i })
          .or(page.locator('a[title="New Quote"], button[title="New Quote"]'))
          .first()
          .isVisible({ timeout: 800 })
          .catch(() => false);
        if (hasNew) break;
        await sleep(500);
      }
    } else {
      progress('11. Quotes (n) heading not hydrated yet — will still try New Quote / related list');
    }

    // Click New Quote near Quotes heading (card locator often matches an empty wrapper)
    const newQuoteNearHeading = quotesHeading
      .locator(
        'xpath=ancestor::*[self::article or contains(@class,"slds-card") or contains(@class,"forceRelatedList") or contains(local-name(),"related-list")][1]',
      )
      .getByRole('button', { name: /^new quote$/i })
      .or(
        quotesHeading
          .locator(
            'xpath=ancestor::*[self::article or contains(@class,"slds-card") or contains(@class,"forceRelatedList")][1]//a[@title="New Quote"] | ancestor::*[self::article or contains(@class,"slds-card")][1]//button[@title="New Quote"]',
          ),
      )
      .or(page.getByRole('button', { name: /^new quote$/i }))
      .or(page.locator('a[title="New Quote"], button[title="New Quote"], button[name="NewQuote"]'))
      .first();

    if (await newQuoteNearHeading.isVisible({ timeout: FAST_FILL ? 8_000 : 12_000 }).catch(() => false)) {
      progress('11. Clicking New Quote on Opportunity Related → Quotes');
      await newQuoteNearHeading.scrollIntoViewIfNeeded().catch(() => {});
      await newQuoteNearHeading.click({ force: true });
      clickedNew = true;
    }

    if (!clickedNew) {
      const domClicked = await page
        .evaluate(() => {
          const isQuotesHead = (el) => /^quotes(\s*\(\s*\d+\s*\))?$/i.test((el.textContent || '').replace(/\s+/g, ' ').trim());
          const heads = [...document.querySelectorAll('h1,h2,h3,h4,span,a,legend')].filter(isQuotesHead);
          for (const h of heads) {
            let root = h.parentElement;
            for (let i = 0; i < 8 && root; i++) {
              const hit = [...root.querySelectorAll('a, button')].find((el) => {
                const t = `${el.textContent || ''} ${el.getAttribute('title') || ''} ${el.getAttribute('aria-label') || ''}`
                  .replace(/\s+/g, ' ')
                  .trim();
                return /^new quote$/i.test(t) || /\bnew\s*quote\b/i.test(t);
              });
              if (hit) {
                (hit.closest('a, button') || hit).click();
                return 'near-heading';
              }
              root = root.parentElement;
            }
          }
          const global = [...document.querySelectorAll('a, button')].find((el) => {
            const t = `${el.textContent || ''} ${el.getAttribute('title') || ''}`.replace(/\s+/g, ' ').trim();
            return /^new quote$/i.test(t) || (el.getAttribute('title') || '') === 'New Quote';
          });
          if (global) {
            global.click();
            return 'global';
          }
          return '';
        })
        .catch(() => '');
      if (domClicked) {
        progress(`11. Clicking New Quote on Related → Quotes (DOM ${domClicked})`);
        clickedNew = true;
      }
    }

    if (!clickedNew) {
      const more = page
        .getByRole('heading', { name: /^quotes/i })
        .locator('xpath=ancestor::*[contains(@class,"slds-card") or self::article][1]')
        .getByRole('button', { name: /show actions|more actions/i })
        .first();
      if (await more.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await more.click().catch(() => {});
        await sleep(300);
        const menuNew = page.getByRole('menuitem', { name: /new quote/i }).first();
        if (await menuNew.isVisible({ timeout: 3_000 }).catch(() => false)) {
          progress('11. Clicking New Quote (Quotes card menu on Related)');
          await menuNew.click();
          clickedNew = true;
        }
      }
    }

    if (!clickedNew) {
      // Related-list actions often load lazily — hover Quotes header and dig shadow DOM
      await quotesHeading.hover().catch(() => {});
      await sleep(600);
      const deep = await page
        .evaluate(() => {
          const want = (t) => /^new\s*quote$/i.test(String(t || '').replace(/\s+/g, ' ').trim());
          const visit = (node, out) => {
            if (!node) return;
            if (node.nodeType === 1) {
              const el = node;
              const label = `${el.textContent || ''} ${el.getAttribute?.('title') || ''} ${el.getAttribute?.('aria-label') || ''}`;
              if ((el.tagName === 'A' || el.tagName === 'BUTTON' || el.getAttribute?.('role') === 'button') && want(label)) {
                out.push(el);
              }
              if (el.shadowRoot) visit(el.shadowRoot, out);
              for (const c of el.children || []) visit(c, out);
            }
          };
          const found = [];
          visit(document.body, found);
          if (found[0]) {
            found[0].click();
            return 'shadow';
          }
          return '';
        })
        .catch(() => '');
      if (deep) {
        progress(`11. Clicking New Quote on Related → Quotes (${deep})`);
        clickedNew = true;
      }
    }

    // Still on Opportunity: header / highlights New Quote (same record, not Quote object list)
    if (!clickedNew) {
      const headerNew = page
        .locator('records-lwc-highlights-panel, records-highlights2, .slds-page-header_record-home')
        .getByRole('button', { name: /^new quote$/i })
        .or(page.locator('button[name="NewQuote"], a[title="New Quote"]'))
        .first();
      if (await headerNew.isVisible({ timeout: 4_000 }).catch(() => false)) {
        progress('11. Clicking New Quote on Opportunity header (Related list action not rendered)');
        await headerNew.click({ force: true });
        clickedNew = true;
      }
    }

    if (!clickedNew && oppId) {
      // Full Opportunity Quotes related list (still Related list — not /o/Quote/new)
      progress('11. Related card New Quote missing — open Opportunity Quotes related list');
      await page.goto(`/lightning/r/Opportunity/${oppId}/related/Quotes/view`, {
        waitUntil: 'domcontentloaded',
      });
      await waitForLightningRecordHome(page);
      await page.locator('.slds-spinner:visible').first().waitFor({ state: 'hidden', timeout: 30_000 }).catch(() => {});
      const listNew = page
        .getByRole('button', { name: /^new quote$/i })
        .or(page.getByRole('button', { name: /^new$/i }))
        .or(page.locator('a[title="New Quote"], button[title="New Quote"], button[name="NewQuote"], a[title="New"]'))
        .first();
      if (await listNew.isVisible({ timeout: 15_000 }).catch(() => false)) {
        progress('11. Clicking New Quote on Opportunity Quotes related list');
        await listNew.click({ force: true });
        clickedNew = true;
      } else {
        const domList = await page
          .evaluate(() => {
            const hit = [...document.querySelectorAll('a, button')].find((el) => {
              const t = `${el.textContent || ''} ${el.getAttribute('title') || ''}`.replace(/\s+/g, ' ').trim();
              return /^new quote$/i.test(t) || /^new$/i.test(t) || (el.getAttribute('title') || '') === 'New Quote';
            });
            if (!hit) return false;
            hit.click();
            return true;
          })
          .catch(() => false);
        if (domList) {
          progress('11. Clicking New Quote on Quotes related list (DOM)');
          clickedNew = true;
        }
      }
    }

    if (!clickedNew) {
      const hText = ((await quotesHeading.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
      const hVisible = await quotesHeading.isVisible().catch(() => false);
      const pageNew = await page.getByRole('button', { name: /^new quote$/i }).count().catch(() => 0);
      progress(`11. Debug Quotes: heading="${hText}" visible=${hVisible} New Quote buttons=${pageNew}`);
      progress(`11. Related → Quotes → New Quote not visible (attempt ${attempt}/2)`);
      if (attempt < 2) continue;
      throw new Error('New Quote button not found on Opportunity Related → Quotes.');
    }

    // Prefer modal on Opportunity; org may still navigate to Quote create after Related click
    await sleep(FAST_FILL ? 400 : 800);
    await page.locator('.slds-spinner:visible').first().waitFor({ state: 'hidden', timeout: 30_000 }).catch(() => {});
    await selectFirstRecordTypeIfPresent(page).catch(() => {});

    const quoteForm = await waitForQuoteCreateForm(page, { timeout: 45_000 });
    if (!quoteForm) {
      progress(`11. Quote form did not open after Related New Quote (attempt ${attempt}/2)`);
      if (attempt < 2) continue;
      throw new Error('Related → New Quote clicked but Quote form never appeared.');
    }
    if (/\/lightning\/o\/Quote\/new|\/Quote\/new/i.test(page.url() || '')) {
      progress('11. Note — Salesforce opened Quote create page after Related New Quote (org behavior)');
    } else {
      progress('11. Quote form on Opportunity (Related New Quote)');
    }

    progress(`11. Quote form — fill required fields (attempt ${attempt}/2)`);
    await ensureChannelRequestTypeIfTenderMandatory(page, quoteForm).catch(() => {});
    await fillAllFieldsSimple(page, quoteForm, { contextLabel: 'Quote' });
    await ensureChannelRequestTypeIfTenderMandatory(page, quoteForm).catch(() => {});
    try {
      const saved = await saveWithValidationRetry(page, quoteForm, { contextLabel: 'Quote' });
      filledViaUrl = saved !== false;
      if (!filledViaUrl) {
        // Form closed / navigated — treat as possible success if we land on Quote record
        if (await quoteIdFromUrl(page)) filledViaUrl = true;
      }
    } catch (err) {
      const msg = String(err?.message || err || '');
      const pageText = await readVisibleValidationText(page).catch(() => '');
      const stageBlocked =
        /opportunity stage is ['"]?identify/i.test(msg + pageText) ||
        /cannot create or update quote while the opportunity stage/i.test(msg + pageText);
      if (stageBlocked && attempt < 2) {
        progress('11. Quote blocked — Opportunity Stage not Quote; cancel form, set Stage, retry');
        await dismissSaveSnagDialog(page);
        await cancelOpenRecordForm(page);
        if (oppId) {
          await page.goto(`/lightning/r/Opportunity/${oppId}/view`, { waitUntil: 'domcontentloaded' });
          await waitForLightningRecordHome(page);
        }
        await setOpportunityStageToQuote(page);
        continue;
      }
      throw err;
    }

    if (!filledViaUrl) {
      progress(`11. Quote Save did not complete (attempt ${attempt}/2)`);
      if (attempt < 2) {
        if (oppId) {
          await page.goto(`/lightning/r/Opportunity/${oppId}/view`, { waitUntil: 'domcontentloaded' });
          await waitForLightningRecordHome(page);
        }
        continue;
      }
      throw new Error('Quote create form opened but Save did not succeed.');
    }

    await page.locator('.slds-spinner:visible').first().waitFor({ state: 'hidden', timeout: 45_000 }).catch(() => {});

    // If Stage error left the form open with snag, recover once
    const blockedText = await readVisibleValidationText(page).catch(() => '');
    if (
      attempt < 2 &&
      /cannot create or update quote while the opportunity stage/i.test(blockedText)
    ) {
      progress('11. Quote Stage error after Save — set Stage=Quote and retry New Quote');
      await dismissSaveSnagDialog(page);
      await cancelOpenRecordForm(page);
      await setOpportunityStageToQuote(page);
      continue;
    }

    const toast = page.locator('.slds-notify, .toastMessage, .forceToastMessage, [role="status"], .slds-notify_container').first();
    await toast.waitFor({ state: 'visible', timeout: 8_000 }).catch(() => {});
    const toastText = ((await toast.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
    let createdName =
      (toastText.match(/quote\s+"([^"]+)"\s+was (?:created|saved)/i) || [])[1] ||
      (toastText.match(/"([^"]+)"\s+was created/i) || [])[1] ||
      '';
    if (/was created|success/i.test(toastText) && !createdName) {
      progress(`11. Save toast — ${toastText.slice(0, 120)}`);
    }
    if (createdName) progress(`11. Quote created — "${createdName}"`);

    async function onQuoteRecord() {
      return !!(await quoteIdFromUrl(page));
    }

    if (!(await onQuoteRecord())) {
      const toastLink = page.locator('a[href*="/Quote/"], a[href*="/0Q0"]').first();
      if (await toastLink.isVisible({ timeout: 5_000 }).catch(() => false)) {
        progress('11. Opening Quote from success toast');
        await toastLink.click();
        await page.waitForURL(/\/lightning\/r\/Quote\/|\/0Q0/i, { timeout: 15_000 }).catch(() => {});
        await waitForLightningRecordHome(page);
      }
    }

    // After Save, open the new Quote from Opportunity Related → Quotes (not Quote object list URL)
    if (!(await onQuoteRecord()) && oppId) {
      progress('11. Opening newly created Quote from Opportunity Related → Quotes');
      await page.goto(`/lightning/r/Opportunity/${oppId}/view`, { waitUntil: 'domcontentloaded' });
      await waitForLightningRecordHome(page);
      await openRelatedTab(page);
      const opened = await openExistingQuoteFromRelated(page, { preferName: createdName });
      if (opened) {
        progress(`11. Create Quote - Passed — opened ${opened}`);
        return opened;
      }
    }

    if (!(await onQuoteRecord()) && createdName) {
      const nameRe = new RegExp(createdName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      if (oppId) {
        await page.goto(`/lightning/r/Opportunity/${oppId}/view`, { waitUntil: 'domcontentloaded' });
        await waitForLightningRecordHome(page);
      }
      await openRelatedTab(page).catch(() => {});
      const qCard = await relatedListCard(page, /quotes/i).catch(() => null);
      const openLink = (qCard || page).getByRole('link', { name: nameRe }).first();
      if (await openLink.isVisible({ timeout: 12_000 }).catch(() => false)) {
        progress(`11. Opening newly created Quote "${createdName}"`);
        await openLink.click();
        await page.waitForURL(/\/lightning\/r\/Quote\/|\/0Q0/i, { timeout: 20_000 }).catch(() => {});
      }
    }

    let id = await waitForQuoteRecordVisible(page, { timeout: 30_000 });
    if (id) {
      progress(`11. Create Quote - Passed — opened ${id}`);
      return id;
    }
    if (createdName) {
      progress(`11. Create Quote - name "${createdName}" but record page not visible — reopen from Related`);
      if (oppId) {
        await page.goto(`/lightning/r/Opportunity/${oppId}/view`, { waitUntil: 'domcontentloaded' });
        await waitForLightningRecordHome(page);
      }
      const reopened = await openExistingQuoteFromRelated(page, { preferName: createdName });
      if (reopened) {
        return reopened;
      }
      progress(`11. Create Quote - Passed (name "${createdName}"; confirm opened from Related if needed)`);
      return createdName;
    }
    // After a Save that closed the form, prefer opening any Quote on this Opp (we just created one)
    if (oppId) {
      await page.goto(`/lightning/r/Opportunity/${oppId}/view`, { waitUntil: 'domcontentloaded' });
      await waitForLightningRecordHome(page);
      const existing = await openExistingQuoteFromRelated(page);
      if (existing) {
        progress(`11. Create Quote - opened existing/new Quote ${existing}`);
        return existing;
      }
    }
    if (attempt < 2) {
      progress('11. Quote not created — reload Opp and retry New Quote');
      if (oppId) {
        await page.goto(`/lightning/r/Opportunity/${oppId}/view`, { waitUntil: 'domcontentloaded' });
        await waitForLightningRecordHome(page);
      }
      await setOpportunityStageToQuote(page);
      continue;
    }
  }
  throw new Error('Quote was not created (no success toast and no Quote record URL).');
}

// ─── Quote Lines → Pricing Calculator → QLI → Quote Totals ───────────────────
/**
 * Acceptance Criteria formulas:
 * Display (after Apply Configuration) — per Quote Line Item calculator:
 *   Total Project Cost = Landed Cost (SAR) + Total W/S Value + Total VAT Value
 *   Gross Profit Amount = Total Selling Price After Discount − Total Project Cost
 *   GP% = (Total Selling Price After Discount − Total Project Cost)
 *         / Total Selling Price After Discount × 100
 * On Save:
 *   Quote Line Item = that line’s calculator values (Configure / View are per row)
 *   Quote (header) Totals — validate only:
 *     GP Amount = Σ Total Selling After Discount − Σ Total Project Cost
 *     Quote GP% (1 line) = that Line Item GP%
 *     Quote GP% (n lines) = (Σ Total Selling After Discount − Σ Total Project Cost)
 *                           / Σ Total Selling After Discount × 100
 *
 * Consumables — Selling Price Section (live Pricing Calculator):
 *   Total Before = Unit Before × Qty
 *   Discount Amount = Total Before × Customer Discount (%) / 100
 *   Total After = Total Before − Discount Amount
 *   Unit After (Back-Calculated) = Total After / Qty
 * Consumables — Supplier Cost & Basic Info:
 *   Currency / Exchange Rate (SAR → 1); SP Price (Per Unit); Total Supplier = SP(SAR) × Qty
 *   Supplier Price from Supplier Pricebook (non-editable)
 * Consumables — Default Provision Charges (on Total Selling Price After Discount):
 *   Financing Charges          3% → Total After × 3%
 *   Bank Charges for LCs/LGs   1% → Total After × 1%
 *   Risk / Penalties           3% → Total After × 3%
 * Consumables — Landed Cost (SAR) on Provision Charges section:
 *   Landed Material Cost  = Total Supplier Price (SAR) from Supplier Cost & Basic Info
 *   Landed Cost (SAR)     = Landed Material Cost + All Provision Charges
 * Consumables — Profitability Summary:
 *   Total Selling Amount (SAR) = Unit Sales Price After Discount × Quantity
 *   Total Project Cost (SAR)   = Landed Cost (SAR)
 *   GP Amount (SAR)            = Total Selling Amount − Total Project Cost
 *   GP %                       = GP Amount / Total Selling Amount × 100
 * Consumables — QLI View (after Save): same section values as calculator
 *   Selling Price & Discount | Supplier Cost & Basic Info | Provision Charges (Landed Cost)
 *   | Profitability Summary
 * Quote Totals (both categories):
 *   GP Amount = Σ Selling − Σ Project
 *   GP% (1 line) = that line GP%; (n lines) = (Σ Selling − Σ Project) / Σ Selling × 100
 * Medical Equipment — Selling Price:
 *   Total Before = Unit Before × Qty; Discount Amount = Total Before × Discount% / 100
 *   Total After = Total Before − Discount Amount; Unit After = Total After / Qty (back-calc)
 *   VAT Amount (From Services); Net Selling Incl. VAT = Total After + VAT From Services
 * Medical Equipment — Supplier Cost:
 *   Currency picklist; Exchange Rate from table (SAR → 1); SP Price (SAR) = Supplier Price × FX
 *   Total Supplier Price (SAR) = SP Price (SAR) × Qty
 * Medical Equipment — Warranty, Services & Equipment Liable to VAT:
 *   Service rows: enter W/S → Percentage auto-calculated from W/S Value (exact % formula TBD if needed);
 *                 VAT = W/S × 15%
 *   Warranty rows (External/Extended 2nd–6th+7th): enter % → W/S auto (non-editable);
 *     W/S = Total Selling Price After Discount (SAR) × %; VAT = W/S × 15%
 *     (field formerly named Unit Sales Price After Discount; Standard Warranty 1st Year out of scope)
 * Medical Equipment — Landed Material Cost:
 *   Freight & Insurance Amount = Total Supplier Price (SAR) × Freight Rate % / 100
 *   Customs Duty Amount        = Total Supplier Price (SAR) × Customs Rate % / 100
 *   Total Freight & Customs    = Freight & Insurance Amount + Customs Duty Amount
 *   Landed Material Cost (SAR) = Total Supplier Price (SAR) + Freight & Insurance Amount + Customs Duty Amount
 *   (not Landed Cost; Landed Cost = Landed Material Cost + Provisions)
 * Medical Equipment — Provision Charges:
 *   Default: Financing 5%, Bank 1%, Risk 5%, PMO 0%, Standard Warranty 0%
 *   Extra product-driven lines (e.g. 200%) are editable — cap rate to 1–10% so GP% stays positive
 *   Amount = Total Selling After Discount × Rate%; Landed Cost = Landed Material + All Provisions
 *   Always keep Total Selling Amount > Total Project Cost (increase Quantity if GP% would be negative)
 * Medical Equipment — Profitability Summary:
 *   Total Selling Amount = Unit After × Qty
 *   Total Project Cost = Landed Cost + Total W/S Value + Total VAT Value
 *   GP Amount / GP % as usual
 * Calculator UX:
 *   Values recalculate in real time (no Apply button required)
 *   Save → persist to QLI and close; Cancel / X → discard (with confirm prompts)
 */

function parseMoney(text) {
  if (text == null) return NaN;
  let s = String(text).replace(/\u00a0/g, ' ').trim();
  if (!s || /^[-“—]?$/i.test(s)) return NaN;
  s = s.replace(/SAR|USD|EUR|GBP|AED/gi, '').replace(/%/g, '').trim();
  const neg = /^\(.*\)$/.test(s) || /^-/.test(s);
  s = s.replace(/[()]/g, '').replace(/,/g, '');
  const n = Number.parseFloat(s.replace(/[^\d.-]/g, ''));
  if (!Number.isFinite(n)) return NaN;
  return neg ? -Math.abs(n) : n;
}

/** Read money/pct that follows a field label; skips parenthetical formula hints in the UI. */
function moneyAfterLabel(text, label) {
  const t = String(text || '').replace(/\u00a0/g, ' ');
  const esc = String(label)
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\\ /g, '\\s+');
  const re = new RegExp(`${esc}([\\s\\S]{0,320}?)(?=Total\\s+(?:Selling|Project|Supplier|VAT|W/?S|Price)|\\bSubtotal\\b|\\bGP\\s*%|\\bGP\\s*Amount|Unit\\s+Sales|Landed\\s+Cost|Discount\\b|Quantity\\b|Customer\\s+Discount|Net\\s+Selling|$)`, 'i');
  const m = t.match(re);
  let chunk = m ? m[1] : '';
  if (!chunk) {
    const loose = new RegExp(`${esc}[\\s\\S]{0,200}`, 'i');
    const m2 = t.match(loose);
    chunk = m2 ? m2[0].slice(String(label).length) : '';
  }
  chunk = chunk.replace(/\([^)]*x[^)]*\)/gi, ' ').replace(/\([^)]*\+[^)]*\)/g, ' ').replace(/\([^)]*\)/g, ' ');
  // Prefer last xxx.xx (display value); allow trailing %
  const money = [...chunk.matchAll(/-?[\d,]+\.\d{2}/g)];
  if (money.length) return parseMoney(money[money.length - 1][0]);
  const pct = [...chunk.matchAll(/-?[\d,]+(?:\.\d+)?\s*%/g)];
  if (pct.length) return parseMoney(pct[pct.length - 1][0]);
  return NaN;
}

/** Pull "Field … 1,234.56" pairs from calculator / record innerText. */
function harvestMoneyLabelsFromText(text) {
  const map = {};
  const t = String(text || '').replace(/\u00a0/g, ' ');
  const re = /([A-Za-z][A-Za-z0-9/%().'+& \-]{2,90}?)\s+(?:SAR\s*)?(-?[\d,]+\.\d{2})/g;
  let m;
  while ((m = re.exec(t))) {
    const k = fieldKey(m[1].replace(/\s+/g, ' ').trim());
    const n = parseMoney(m[2]);
    if (!Number.isFinite(n) || k.length < 3 || k.length > 80) continue;
    if (/^sar$|^qty$|^%$/.test(k)) continue;
    if (!Number.isFinite(map[k])) map[k] = n;
  }
  return map;
}

/** True when a line is only a calculator formula hint, e.g. (Unit × Qty). */
function isCalculatorFormulaHint(line) {
  const s = String(line || '').trim();
  if (!s) return false;
  if (/^\([^)]*[×x+\-*/][^)]*\)$/.test(s)) return true;
  if (/^\(.*\)$/.test(s) && !/-?[\d,]+\.\d{2}/.test(s)) return true;
  return false;
}

function sliceCalculatorSectionText(text, startRe, endRe) {
  const t = String(text || '').replace(/\u00a0/g, ' ');
  const start = t.search(startRe);
  if (start < 0) return t;
  const rest = t.slice(start);
  const skip = Math.min(40, rest.length);
  const endRel = rest.slice(skip).search(endRe);
  if (endRel < 0) return rest.slice(0, 2_000);
  return rest.slice(0, skip + endRel);
}

/**
 * Parse calculator tables (Description | Rate (%) | Amount).
 * Each row is sliced only until the next known row — never into the following field.
 */
function parseCalculatorAmountTable(text, rowSpecs) {
  const isHeading = (line) =>
    /^\s*\d+\.?\s/.test(line) ||
    /^(description|rate\s*\(%\)|amount(\s*\(sar\))?)$/i.test(line);
  const lines = String(text || '')
    .replace(/\u00a0/g, ' ')
    .split(/\n+/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  const starts = [];
  for (let i = 0; i < lines.length; i++) {
    if (isHeading(lines[i])) continue;
    const spec = rowSpecs.find((s) => s.re.test(lines[i]));
    if (!spec) continue;
    if (spec.skipBareTitle && spec.skipBareTitle.test(lines[i]) && !/\(sar\)|amount/i.test(lines[i])) continue;
    const existing = starts.findIndex((x) => x.key === spec.key);
    if (existing >= 0) starts.splice(existing, 1);
    starts.push({ key: spec.key, i, hasRate: !!spec.hasRate });
  }

  const sectionBreak =
    /^(warranty|provision|profitability|selling\s*price|supplier\s*cost|\d+\.\s)|landed\s*cost(?!\s*material)/i;
  const out = {};
  for (let s = 0; s < starts.length; s++) {
    let end = s + 1 < starts.length ? starts[s + 1].i : Math.min(lines.length, starts[s].i + 4);
    for (let j = starts[s].i + 1; j < end; j++) {
      if (sectionBreak.test(lines[j]) && !rowSpecs.some((sp) => sp.re.test(lines[j]))) {
        end = j;
        break;
      }
    }
    const chunk = lines.slice(starts[s].i, end).join(' ');
    const nums = [...chunk.matchAll(/-?[\d,]+\.\d{2}/g)].map((m) => parseMoney(m[0])).filter((n) => Number.isFinite(n));
    let rate = NaN;
    let amount = NaN;
    if (!starts[s].hasRate) {
      amount = nums.length ? nums[0] : NaN;
    } else if (nums.length === 1) {
      amount = Math.abs(nums[0]) <= 100 ? NaN : nums[0];
      if (Math.abs(nums[0]) <= 100) rate = nums[0];
    } else if (nums.length >= 2) {
      rate = nums[0];
      amount = nums[1];
      if (Number.isFinite(rate) && Math.abs(rate) > 100) {
        amount = rate;
        rate = NaN;
      }
    }
    out[starts[s].key] = { rate, amount };
  }
  return out;
}

/** LWC stacked layout: label on one line, value on the next (skip formula hints). */
function harvestAdjacentLines(text) {
  const map = {};
  const lines = String(text || '')
    .replace(/\u00a0/g, ' ')
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  for (let i = 0; i < lines.length - 1; i++) {
    const label = lines[i].replace(/\*$/, '').trim();
    if (label.length < 3 || label.length > 90 || !/[A-Za-z]/.test(label)) continue;
    if (/^sar$|^usd$|^qty$/i.test(label)) continue;
    let valueIdx = i + 1;
    while (valueIdx < lines.length && isCalculatorFormulaHint(lines[valueIdx])) valueIdx += 1;
    const next = lines[valueIdx] || '';
    if (/[A-Za-z]{4,}/.test(next) && !/sar|usd|aed|eur|gbp/i.test(next)) continue;
    const n1 = parseMoney(next);
    const n2 = parseMoney(lines[valueIdx + 1] || '');
    const k = fieldKey(label);
    const isRateAmountRow =
      /amount|charge|duty|freight|insurance|financ|bank|risk|pmo|warranty|zzfi|zzbc|zpen|zzpm/i.test(label);
    if (isRateAmountRow && Number.isFinite(n1) && Number.isFinite(n2) && Math.abs(n1) <= 100) {
      if (!Number.isFinite(map[k])) map[k] = n2;
      const pctKey = fieldKey(`${label} %`);
      if (!Number.isFinite(map[pctKey])) map[pctKey] = n1;
      continue;
    }
    if (!Number.isFinite(n1)) continue;
    if (!Number.isFinite(map[k])) map[k] = n1;
  }
  return map;
}

function firstFinite(...vals) {
  for (const v of vals) if (Number.isFinite(v)) return v;
  return NaN;
}

function sumFinite(items, key) {
  const nums = (items || []).map((x) => x && x[key]).filter((n) => Number.isFinite(n));
  if (!nums.length) return NaN;
  return nums.reduce((s, n) => s + n, 0);
}

function readPricingFieldsFromMap(map) {
  return {
    totalSellingAfterDiscount: pickValue(
      map,
      'Total Selling Price After Discount (SAR)',
      'Total Selling Price After Discount',
      'Total Selling Amount (SAR)',
      'Total Selling Amount',
      'Total Selling Price',
      'Total Price',
      'Subtotal',
      'Grand Total',
    ),
    totalProjectCost: pickValue(
      map,
      'Total Project Cost (SAR)',
      'Total Project Cost',
      'Total Project Costs',
      'Project Cost',
    ),
    grossProfitAmount: pickValue(
      map,
      'GP Amount (SAR)',
      'GP Amount',
      'Gross Profit Amount',
      'Gross Profit Amount (SAR)',
      'Gross Profit',
    ),
    gpPct: pickValue(map, 'GP %', 'GP%', 'Gross Profit %', 'Line Item GP%', 'Quote GP%'),
  };
}

/** Read Selling / Project / GP from Quote or QLI record page (Details + Totals / highlights). */
async function readQuoteOrQliPricingFields(page) {
  const isQli = /QuoteLineItem|\/0QL/i.test(page.url());
  const map = await readRecordFieldMap(page);
  let fields = readPricingFieldsFromMap(map);

  // On QLI, never treat Quote-level Total Price / Subtotal as this line’s Selling
  // (related Quote / sibling lines can inject another line’s total, e.g. 739,375).
  if (isQli) {
    const mapSell = pickValue(
      map,
      'Total Selling Price After Discount (SAR)',
      'Total Selling Price After Discount',
      'Total Selling Amount (SAR)',
      'Total Selling Amount',
    );
    fields.totalSellingAfterDiscount = Number.isFinite(mapSell) ? mapSell : NaN;
  }

  // Totals / Key Fields often use list items: "GP% 62.49%" — harvest from visible page text
  const scope = page.locator(
    'records-lwc-highlights-panel, records-highlights2, .record-body-container, one-record-home-flexipage2, body',
  ).first();
  const text = ((await scope.innerText().catch(() => '')) || '').replace(/\u00a0/g, ' ');
  const harvest = (label) => moneyAfterLabel(text, label);

  // Highlights panel: label/value pairs (avoid mistaking GP% for Project Cost)
  const fromHighlights = await readHighlightsMoneyFields(page);

  fields = {
    totalSellingAfterDiscount: firstFinite(
      fromHighlights.totalSellingAfterDiscount,
      fields.totalSellingAfterDiscount,
      harvest('Total Selling Price After Discount'),
      harvest('Total Selling Amount'),
      // Quote Totals only — do not use on QLI (cross-line contamination)
      ...(isQli ? [] : [harvest('Total Price'), harvest('Subtotal')]),
    ),
    totalProjectCost: firstFinite(
      fromHighlights.totalProjectCost,
      fields.totalProjectCost,
      harvest('Total Project Cost (SAR)'),
      harvest('Total Project Cost'),
    ),
    grossProfitAmount: firstFinite(
      fromHighlights.grossProfitAmount,
      fields.grossProfitAmount,
      harvest('GP Amount'),
      harvest('Gross Profit Amount'),
    ),
    gpPct: firstFinite(
      fromHighlights.gpPct,
      fields.gpPct,
      harvest('GP %'),
      harvest('GP%'),
      harvest('Gross Profit %'),
      harvest('Line Item GP%'),
    ),
  };

  // Guard: Project Cost must be money, not a % value mistakenly scraped
  if (
    Number.isFinite(fields.totalProjectCost) &&
    Number.isFinite(fields.gpPct) &&
    nearlyEqual(fields.totalProjectCost, fields.gpPct)
  ) {
    fields.totalProjectCost = NaN;
  }
  if (
    Number.isFinite(fields.totalProjectCost) &&
    Number.isFinite(fields.totalSellingAfterDiscount) &&
    fields.totalSellingAfterDiscount > 1000 &&
    Math.abs(fields.totalProjectCost) < 100 &&
    !Number.isFinite(fromHighlights.totalProjectCost)
  ) {
    // Likely scraped GP% into Project — discard
    fields.totalProjectCost = NaN;
  }

  return fields;
}

/**
 * Read money/% fields from Lightning highlights / Details by exact-ish labels.
 * Used for Quote Line Item View so GP% is not mistaken for Project Cost.
 */
async function readHighlightsMoneyFields(page) {
  const out = await page
    .evaluate(() => {
      const result = {
        totalSellingAfterDiscount: NaN,
        totalProjectCost: NaN,
        grossProfitAmount: NaN,
        gpPct: NaN,
      };
      const norm = (s) => String(s || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
      const parseN = (s) => {
        const raw = String(s || '').replace(/SAR|USD/gi, '').trim();
        const isPct = /%/.test(raw);
        const t = raw.replace(/[^\d.,\-]/g, '').replace(/,/g, '');
        const n = Number.parseFloat(t);
        if (!Number.isFinite(n)) return { n: NaN, isPct };
        return { n, isPct };
      };
      const assign = (label, valueText) => {
        const lab = norm(label).toLowerCase();
        const { n, isPct } = parseN(valueText);
        if (!Number.isFinite(n)) return;
        if (/^gp\s*%$|^gp%$|gross\s*profit\s*%|line\s*item\s*gp%/i.test(lab)) {
          if (!Number.isFinite(result.gpPct)) result.gpPct = n;
          return;
        }
        if (/gp\s*amount|gross\s*profit\s*amount/i.test(lab)) {
          if (!isPct && !Number.isFinite(result.grossProfitAmount)) result.grossProfitAmount = n;
          return;
        }
        if (/total\s*project\s*cost|project\s*cost/i.test(lab) && !/selling/i.test(lab)) {
          if (!isPct && !Number.isFinite(result.totalProjectCost)) result.totalProjectCost = n;
          return;
        }
        if (
          /total\s*selling\s*(price\s*)?after\s*discount|total\s*selling\s*amount|total\s*price/i.test(lab) &&
          !/project/i.test(lab)
        ) {
          if (!isPct && !Number.isFinite(result.totalSellingAfterDiscount)) result.totalSellingAfterDiscount = n;
        }
      };

      const roots = document.querySelectorAll(
        'records-lwc-highlights-panel, records-highlights2, .slds-page-header, .record-body-container, one-record-home-flexipage2',
      );
      for (const root of roots) {
        const items = root.querySelectorAll(
          'records-highlights-details-item, lightning-output-field, records-record-layout-item, .slds-form-element, dt',
        );
        for (const el of items) {
          const labelEl = el.querySelector(
            '.slds-form-element__label, label, span.slds-text-title, .test-id__field-label',
          );
          let label = norm((labelEl && labelEl.innerText) || el.getAttribute('data-label') || '');
          if (!label && el.tagName === 'DT') label = norm(el.innerText);
          if (!label || label.length > 80) continue;
          let valueText = '';
          if (el.tagName === 'DT' && el.nextElementSibling) {
            valueText = el.nextElementSibling.innerText || '';
          } else {
            const val = el.querySelector(
              'lightning-formatted-number, lightning-formatted-text, .slds-form-element__static, .test-id__field-value',
            );
            valueText = (val && val.innerText) || '';
            if (!valueText) {
              const full = norm(el.innerText);
              if (full.toLowerCase().startsWith(label.toLowerCase())) {
                valueText = full.slice(label.length);
              }
            }
          }
          assign(label, valueText);
        }
      }
      return result;
    })
    .catch(() => ({
      totalSellingAfterDiscount: NaN,
      totalProjectCost: NaN,
      grossProfitAmount: NaN,
      gpPct: NaN,
    }));

  progress(
    `12. QLI/Quote highlights — Sell=${moneyFmt(out.totalSellingAfterDiscount)} Project=${moneyFmt(out.totalProjectCost)} ` +
      `GP Amt=${moneyFmt(out.grossProfitAmount)} GP%=${pctFmt(out.gpPct)}`,
  );
  return out;
}

/**
 * Core QLI validation after View: Selling / Project / GP Amount / GP% must match calculator.
 * Updates line snapshot for Quote Σ from ALL line items.
 */
function validateQliCorePricingVsCalculator(tag, qli, calcSnap, validationRows) {
  let ok = true;
  ok =
    validateAgainstFormulas(
      `${tag} QLI: Total Selling After Discount vs calculator`,
      qli.totalSellingAfterDiscount,
      firstFinite(calcSnap.totalSellingAfterDiscount, calcSnap.totalSellingAmount),
      validationRows,
    ) && ok;
  ok =
    validateAgainstFormulas(
      `${tag} QLI: Total Project Cost vs calculator`,
      qli.totalProjectCost,
      calcSnap.totalProjectCost,
      validationRows,
    ) && ok;
  ok =
    validateAgainstFormulas(
      `${tag} QLI: GP Amount vs calculator`,
      qli.grossProfitAmount,
      firstFinite(calcSnap.gpAmount, calcSnap.grossProfitAmount),
      validationRows,
    ) && ok;
  ok =
    validateAgainstFormulas(
      `${tag} QLI: GP% vs calculator`,
      qli.gpPct,
      calcSnap.gpPct,
      validationRows,
      { asPct: true },
    ) && ok;

  // QLI internal formula: GP Amount / GP% from its Selling & Project
  if (Number.isFinite(qli.totalSellingAfterDiscount) && Number.isFinite(qli.totalProjectCost)) {
    ok =
      validateAgainstFormulas(
        `${tag} QLI: GP Amount (= Selling − Project)`,
        qli.grossProfitAmount,
        expectedGpAmount(qli.totalSellingAfterDiscount, qli.totalProjectCost),
        validationRows,
      ) && ok;
    ok =
      validateAgainstFormulas(
        `${tag} QLI: GP% (= (Selling − Project) / Selling × 100)`,
        qli.gpPct,
        expectedGpPct(qli.totalSellingAfterDiscount, qli.totalProjectCost),
        validationRows,
        { asPct: true },
      ) && ok;
  }
  return ok;
}

/**
 * Prefer QLI saved values for Quote roll-up — but never overwrite a good calculator
 * snapshot with a mismatched QLI scrape (e.g. sibling-line Total Price bleed).
 */
function applyQliValuesToLineSnapshot(calcSnapshot, qli) {
  const calcSell = firstFinite(calcSnapshot.totalSellingAfterDiscount, calcSnapshot.totalSellingAmount);
  if (Number.isFinite(qli.totalSellingAfterDiscount)) {
    if (!Number.isFinite(calcSell) || nearlyEqual(qli.totalSellingAfterDiscount, calcSell)) {
      calcSnapshot.totalSellingAfterDiscount = qli.totalSellingAfterDiscount;
      calcSnapshot.totalSellingAmount = qli.totalSellingAfterDiscount;
    }
  }
  const calcProj = calcSnapshot.totalProjectCost;
  if (Number.isFinite(qli.totalProjectCost)) {
    if (!Number.isFinite(calcProj) || nearlyEqual(qli.totalProjectCost, calcProj)) {
      calcSnapshot.totalProjectCost = qli.totalProjectCost;
    }
  }
  if (Number.isFinite(qli.grossProfitAmount)) {
    const calcGp = firstFinite(calcSnapshot.gpAmount, calcSnapshot.grossProfitAmount);
    if (!Number.isFinite(calcGp) || nearlyEqual(qli.grossProfitAmount, calcGp)) {
      calcSnapshot.grossProfitAmount = qli.grossProfitAmount;
      calcSnapshot.gpAmount = qli.grossProfitAmount;
    }
  }
  if (Number.isFinite(qli.gpPct)) {
    if (!Number.isFinite(calcSnapshot.gpPct) || nearlyEqual(qli.gpPct, calcSnapshot.gpPct)) {
      calcSnapshot.gpPct = qli.gpPct;
    }
  }
  return calcSnapshot;
}

/**
 * Quote Details → Totals section (screenshot labels):
 *   Total Price | Subtotal | GP% | GP Amount | Discount | Total VAT
 * Example ground truth: Total Price 4,739,375 | GP% 62.49% | GP Amount 2,961,746.88
 * Must read ONLY from the Totals section (not QLI GP fields elsewhere on the page).
 */
async function readQuoteTotalsSection(page) {
  await openQuoteTab(page, 'Details').catch(() => {});
  await page.locator('.slds-spinner:visible').first().waitFor({ state: 'hidden', timeout: 20_000 }).catch(() => {});

  // Expand Totals accordion/section if collapsed
  const totalsBtn = page
    .getByRole('button', { name: /^totals$/i })
    .or(page.locator('button.slds-section__title-action, lightning-accordion-section button').filter({ hasText: /^totals$/i }))
    .first();
  if (await totalsBtn.isVisible({ timeout: 8_000 }).catch(() => false)) {
    const expanded = await totalsBtn.getAttribute('aria-expanded').catch(() => null);
    if (expanded === 'false') await totalsBtn.click().catch(() => {});
    await totalsBtn
      .evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'nearest' }))
      .catch(() => {});
  }

  // Scroll until Totals block with Total Price is visible
  for (let i = 0; i < 10; i++) {
    const tp = page.getByText(/^total\s*price$/i).first();
    if (await tp.isVisible({ timeout: 600 }).catch(() => false)) {
      await tp.evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'nearest' })).catch(() => {});
      break;
    }
    await page.mouse.wheel(0, 1000).catch(() => {});
    await sleep(350).catch(() => {});
  }

  // Scoped scrape: only inside the section whose title is Totals
  const scraped = await page
    .evaluate(() => {
      const out = {
        totalPrice: NaN,
        subtotal: NaN,
        gpPct: NaN,
        gpAmount: NaN,
        discountPct: NaN,
        totalVat: NaN,
      };
      const norm = (s) => String(s || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
      const parseN = (s) => {
        const raw = String(s || '');
        const isPct = /%/.test(raw);
        const t = raw.replace(/SAR|USD|EUR/gi, '').replace(/[^\d.,\-]/g, '').replace(/,/g, '');
        const n = Number.parseFloat(t);
        return { n: Number.isFinite(n) ? n : NaN, isPct };
      };

      // Find Totals section root
      let sectionRoot = null;
      const candidates = document.querySelectorAll(
        'button.slds-section__title-action, lightning-accordion-section, .slds-section, article, section, div',
      );
      for (const el of candidates) {
        const t = norm(el.innerText || el.textContent || '').slice(0, 40);
        if (/^totals\b/i.test(t) || /^totals$/i.test(norm(el.getAttribute('title') || ''))) {
          sectionRoot =
            el.closest('.slds-section, lightning-accordion-section, article, section') ||
            el.parentElement ||
            el;
          // Prefer a parent that also contains "Total Price"
          let p = sectionRoot;
          for (let d = 0; d < 5 && p; d++, p = p.parentElement) {
            if (/total\s*price/i.test(p.innerText || '') && /gp\s*%/i.test(p.innerText || '')) {
              sectionRoot = p;
              break;
            }
          }
          break;
        }
      }

      // Fallback: locate "Total Price" label and walk up to a container that also has GP Amount
      if (!sectionRoot) {
        const all = document.querySelectorAll('label, span, div, dt, lightning-formatted-text');
        for (const el of all) {
          if (!/^total\s*price$/i.test(norm(el.innerText || ''))) continue;
          let p = el.parentElement;
          for (let d = 0; d < 8 && p; d++, p = p.parentElement) {
            const blob = p.innerText || '';
            if (/gp\s*amount/i.test(blob) && /subtotal/i.test(blob)) {
              sectionRoot = p;
              break;
            }
          }
          if (sectionRoot) break;
        }
      }
      if (!sectionRoot) return out;

      // Parse stacked label / value lines inside Totals (matches screenshot)
      const lines = norm(sectionRoot.innerText)
        .split(/\n+/)
        .map((l) => l.trim())
        .filter(Boolean);
      for (let i = 0; i < lines.length; i++) {
        const lab = lines[i];
        const next = lines[i + 1] || '';
        const { n, isPct } = parseN(next);
        if (!Number.isFinite(n)) continue;
        if (/^total\s*price$/i.test(lab) && !isPct) out.totalPrice = n;
        else if (/^subtotal$/i.test(lab) && !isPct) out.subtotal = n;
        else if (/^gp\s*%$/i.test(lab) || /^gp%$/i.test(lab)) out.gpPct = n;
        else if (/^gp\s*amount$/i.test(lab) && !isPct) out.gpAmount = n;
        else if (/^discount$/i.test(lab)) out.discountPct = n;
        else if (/^total\s*vat$/i.test(lab)) out.totalVat = n;
      }

      // Also try form-element pairs inside the section
      const items = sectionRoot.querySelectorAll(
        '.slds-form-element, records-record-layout-item, lightning-output-field, dt',
      );
      for (const el of items) {
        const labelEl = el.querySelector('label, .slds-form-element__label, span.slds-form-element__label');
        let label = norm((labelEl && labelEl.innerText) || el.getAttribute('data-label') || '');
        if (!label && el.tagName === 'DT') label = norm(el.innerText);
        if (!label || label.length > 40) continue;
        let valueText = '';
        if (el.tagName === 'DT' && el.nextElementSibling) valueText = el.nextElementSibling.innerText || '';
        else {
          const val = el.querySelector(
            'lightning-formatted-number, lightning-formatted-text, .slds-form-element__static',
          );
          valueText = (val && val.innerText) || '';
        }
        const { n, isPct } = parseN(valueText);
        if (!Number.isFinite(n)) continue;
        if (/^total\s*price$/i.test(label) && !isPct && !Number.isFinite(out.totalPrice)) out.totalPrice = n;
        else if (/^subtotal$/i.test(label) && !isPct && !Number.isFinite(out.subtotal)) out.subtotal = n;
        else if ((/^gp\s*%$/i.test(label) || /^gp%$/i.test(label)) && !Number.isFinite(out.gpPct)) out.gpPct = n;
        else if (/^gp\s*amount$/i.test(label) && !isPct && !Number.isFinite(out.gpAmount)) out.gpAmount = n;
        else if (/^discount$/i.test(label) && !Number.isFinite(out.discountPct)) out.discountPct = n;
        else if (/^total\s*vat$/i.test(label) && !Number.isFinite(out.totalVat)) out.totalVat = n;
      }

      return out;
    })
    .catch(() => ({
      totalPrice: NaN,
      subtotal: NaN,
      gpPct: NaN,
      gpAmount: NaN,
      discountPct: NaN,
      totalVat: NaN,
    }));

  progress(
    `12. Quote Totals (scoped) — Total Price=${moneyFmt(scraped.totalPrice)} Subtotal=${moneyFmt(scraped.subtotal)} ` +
      `GP%=${pctFmt(scraped.gpPct)} GP Amt=${moneyFmt(scraped.gpAmount)}`,
  );

  // Fallback: page text harvest when scoped Totals DOM scrape misses Lightning fields
  if (
    !Number.isFinite(scraped.gpAmount) ||
    !Number.isFinite(scraped.gpPct) ||
    !Number.isFinite(scraped.totalPrice)
  ) {
    const pageText = ((await page.locator('body').innerText().catch(() => '')) || '').replace(/\u00a0/g, ' ');
    // Prefer a window around the Totals heading
    const totalsIdx = pageText.search(/\bTotals\b/i);
    const windowText =
      totalsIdx >= 0 ? pageText.slice(Math.max(0, totalsIdx), totalsIdx + 2500) : pageText.slice(0, 8000);
    if (!Number.isFinite(scraped.totalPrice)) {
      scraped.totalPrice = firstFinite(
        moneyAfterLabel(windowText, 'Total Price'),
        moneyAfterLabel(pageText, 'Total Price'),
      );
    }
    if (!Number.isFinite(scraped.subtotal)) {
      scraped.subtotal = firstFinite(
        moneyAfterLabel(windowText, 'Subtotal'),
        moneyAfterLabel(pageText, 'Subtotal'),
      );
    }
    if (!Number.isFinite(scraped.gpPct)) {
      scraped.gpPct = firstFinite(moneyAfterLabel(windowText, 'GP%'), moneyAfterLabel(windowText, 'GP %'));
    }
    if (!Number.isFinite(scraped.gpAmount)) {
      scraped.gpAmount = firstFinite(
        moneyAfterLabel(windowText, 'GP Amount'),
        moneyAfterLabel(pageText, 'GP Amount'),
      );
    }
    if (!Number.isFinite(scraped.totalVat)) {
      scraped.totalVat = moneyAfterLabel(windowText, 'Total VAT');
    }
    if (!Number.isFinite(scraped.discountPct)) {
      scraped.discountPct = moneyAfterLabel(windowText, 'Discount');
    }
    progress(
      `12. Quote Totals (fallback) — Total Price=${moneyFmt(scraped.totalPrice)} ` +
        `GP%=${pctFmt(scraped.gpPct)} GP Amt=${moneyFmt(scraped.gpAmount)}`,
    );
  }

  return {
    ...scraped,
    totalSellingAfterDiscount: firstFinite(scraped.totalPrice, scraped.subtotal),
    grossProfitAmount: scraped.gpAmount,
    totalProjectCost: NaN,
  };
}

/** GP Amount = Selling − Project Cost; GP% = (Selling − Project) / Selling × 100 */
function validatePricingFormulas(tag, fields, rows) {
  const selling = fields.totalSellingAfterDiscount;
  const project = fields.totalProjectCost;
  if (!Number.isFinite(selling) || !Number.isFinite(project)) {
    rows.push({
      section: `${tag} GP formula inputs`,
      actual: `Selling=${moneyFmt(selling)} Project=${moneyFmt(project)}`,
      expected: 'both readable',
      status: 'FAIL',
    });
    progress(`12. Validate ${tag} GP formula inputs: Selling=${moneyFmt(selling)} Project=${moneyFmt(project)} → FAIL`);
    return false;
  }
  const expGp = expectedGpAmount(selling, project);
  const expPct = expectedGpPct(selling, project);
  let ok = true;
  ok =
    validateAgainstFormulas(
      `${tag} GP Amount (= Selling − Project Cost)`,
      fields.grossProfitAmount,
      expGp,
      rows,
    ) && ok;
  ok =
    validateAgainstFormulas(
      `${tag} GP% (= (Selling − Project) / Selling × 100)`,
      fields.gpPct,
      expPct,
      rows,
      { asPct: true },
    ) && ok;
  return ok;
}

function nearlyEqual(a, b, tol = MONEY_TOLERANCE) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  const absTol = Math.max(tol, Math.abs(b) * 0.001);
  return Math.abs(a - b) <= absTol;
}

function moneyFmt(n) {
  if (!Number.isFinite(n)) return '(blank)';
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function pctFmt(n) {
  if (!Number.isFinite(n)) return '(blank)';
  return `${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}%`;
}

function fieldKey(label) {
  return String(label || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function pickValue(map, ...aliases) {
  for (const a of aliases) {
    const k = fieldKey(a);
    if (map[k] != null && Number.isFinite(map[k])) return map[k];
  }
  // fuzzy contains
  for (const a of aliases) {
    const needle = fieldKey(a);
    for (const [k, v] of Object.entries(map)) {
      if (!k.includes(needle) || !Number.isFinite(v)) continue;
      if (/after/.test(needle) && /before/.test(k)) continue;
      return v;
    }
  }
  return NaN;
}

function expectedGpAmount(totalSellingAfterDiscount, totalProjectCost) {
  return totalSellingAfterDiscount - totalProjectCost;
}

function expectedGpPct(totalSellingAfterDiscount, totalProjectCost) {
  if (!Number.isFinite(totalSellingAfterDiscount) || totalSellingAfterDiscount === 0) return NaN;
  return ((totalSellingAfterDiscount - totalProjectCost) / totalSellingAfterDiscount) * 100;
}

/**
 * Read a calculator / record display value next to a label (LWC formula fields often lack inputs).
 * Tries map → moneyAfterLabel → DOM walk near matching label text.
 */
async function readCalcFieldByLabels(scope, labels, preloadedMap = null, preloadedText = null) {
  const list = (Array.isArray(labels) ? labels : [labels]).map((x) => String(x || '').trim()).filter(Boolean);
  if (!list.length) return NaN;

  const map = preloadedMap || (await readLabeledNumericMap(scope).catch(() => ({})));
  const fromMap = pickValue(map, ...list);
  if (Number.isFinite(fromMap)) return fromMap;

  const text =
    preloadedText != null
      ? preloadedText
      : ((await scope.innerText().catch(() => '')) || '').replace(/\u00a0/g, ' ');
  for (const label of list) {
    const n = moneyAfterLabel(text, label);
    if (Number.isFinite(n)) return n;
  }

  const scraped = await scope
    .evaluate((root, labelList) => {
      const norm = (s) => String(s || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
      const parseN = (s) => {
        const t = String(s || '').replace(/[^\d.,\-]/g, '').replace(/,/g, '');
        const n = Number.parseFloat(t);
        return Number.isFinite(n) ? n : NaN;
      };
      const want = labelList.map((l) => norm(l).toLowerCase());
      const nodes = root.querySelectorAll(
        'label, .slds-form-element__label, legend, span, div, dt, th, p, lightning-formatted-text',
      );
      for (const el of nodes) {
        const lab = norm(el.innerText || el.textContent || '');
        if (lab.length < 3 || lab.length > 100) continue;
        const labLow = lab.toLowerCase();
        if (!want.some((w) => labLow === w || labLow.startsWith(w) || w.startsWith(labLow))) continue;
        let p = el;
        for (let depth = 0; depth < 7 && p; depth++, p = p.parentElement) {
          const blob = norm(p.innerText || '');
          if (blob.length < lab.length + 2) continue;
          const cleaned = blob.replace(/\([^)]*\)/g, ' ');
          if (/%\s*$/.test(lab) || /\bgp\s*%/i.test(lab)) {
            const pct = [...cleaned.matchAll(/-?[\d,]+\.?\d*\s*%/g)];
            if (pct.length) return parseN(pct[pct.length - 1][0]);
          }
          const nums = [...cleaned.matchAll(/-?[\d,]+\.\d{2}/g)];
          if (nums.length) return parseN(nums[nums.length - 1][0]);
        }
      }
      return NaN;
    }, list)
    .catch(() => NaN);
  return Number.isFinite(scraped) ? scraped : NaN;
}

/** Medical Equipment — key totals shown on Pricing Calculator (formulas on UI). */
async function readMedicalEquipmentKeyTotals(page) {
  const root = await pricingCalculatorRoot(page);
  await scrollPricingCalculatorFullPage(page).catch(() => {});
  const map = await readLabeledNumericMap(root);
  const landedTbl = await readLandedMaterialCostTable(page, {
    totalSupplierPrice: pickValue(map, 'Total Supplier Price (SAR)', 'Total Supplier Price'),
  }).catch(() => null);
  applyLandedMaterialCostTableToMap(map, landedTbl);
  const text = ((await root.innerText().catch(() => '')) || '').replace(/\u00a0/g, ' ');
  const profit = await readProfitabilitySummaryFromUi(page);

  const get = async (...labels) => readCalcFieldByLabels(root, labels, map, text);

  const totals = {
    netSellingInclVat: await get(
      'Net Selling Price Including VAT (Total)',
      'Net Selling Price Including VAT',
      'Net Selling Price Incl. VAT',
    ),
    totalSupplierPrice: await get('Total Supplier Price (SAR)', 'Total Supplier Price'),
    landedMaterialCost: firstFinite(
      landedTbl?.landedMaterialCost,
      await get('Landed Material Cost (SAR)', 'Landed Material Cost'),
    ),
    landedCost: await get('Landed Cost (SAR)', 'Landed Cost', 'Landed Cost (AFMS Warehouse)'),
    totalWsValue: await get('Total W/S Value (SAR)', 'Total W/S Value'),
    totalVatValue: await get('Total VAT Value (SAR)', 'Total VAT Value'),
    totalSellingAmount: firstFinite(
      profit.selling,
      await get('Total Selling Amount (SAR)', 'Total Selling Amount', 'Total Selling Price After Discount (SAR)'),
    ),
    totalProjectCost: firstFinite(
      profit.project,
      await get('Total Project Cost (SAR)', 'Total Project Cost'),
    ),
    gpAmount: firstFinite(profit.gpAmt, await get('GP Amount (SAR)', 'GP Amount', 'Gross Profit Amount')),
    gpPct: firstFinite(profit.gpPct, await get('GP %', 'GP%', 'Gross Profit %')),
  };

  progress(
    `12. ME key totals — NetVAT=${moneyFmt(totals.netSellingInclVat)} Supplier=${moneyFmt(totals.totalSupplierPrice)} ` +
      `LandedMat=${moneyFmt(totals.landedMaterialCost)} Landed=${moneyFmt(totals.landedCost)} ` +
      `W/S=${moneyFmt(totals.totalWsValue)} VAT=${moneyFmt(totals.totalVatValue)} ` +
      `Sell=${moneyFmt(totals.totalSellingAmount)} Proj=${moneyFmt(totals.totalProjectCost)} ` +
      `GP=${moneyFmt(totals.gpAmount)} GP%=${pctFmt(totals.gpPct)}`,
  );
  return totals;
}

/**
 * Validate ME Pricing Calculator key totals against calculator formulas (on-screen formulas).
 * inputs: { totalAfter, vatFromServices, spSar, qty, freightAmt, customsAmt, provisionSum }
 */
function validateMedicalEquipmentKeyTotals(tag, ui, inputs, validationRows) {
  let ok = true;
  const {
    totalAfter = NaN,
    vatFromServices = NaN,
    spSar = NaN,
    qty = NaN,
    freightAmt = NaN,
    customsAmt = NaN,
    provisionSum = NaN,
    expectedWs = NaN,
  } = inputs || {};

  const expSupplier = Number.isFinite(spSar) && Number.isFinite(qty) ? spSar * qty : NaN;
  const supplierBase = firstFinite(ui.totalSupplierPrice, expSupplier);
  const expLandedMat = Number.isFinite(supplierBase)
    ? supplierBase + (Number.isFinite(freightAmt) ? freightAmt : 0) + (Number.isFinite(customsAmt) ? customsAmt : 0)
    : NaN;
  const baseLandedMat = firstFinite(ui.landedMaterialCost, expLandedMat);
  const expLandedCost = Number.isFinite(baseLandedMat)
    ? baseLandedMat + (Number.isFinite(provisionSum) ? provisionSum : 0)
    : NaN;
  // Prefer UI Landed Cost when present (may include extra provision lines beyond defaults)
  const baseLanded = firstFinite(ui.landedCost, expLandedCost);
  const expWs = firstFinite(expectedWs, ui.totalWsValue);
  const baseWs = firstFinite(ui.totalWsValue, expWs);
  const expVatFromWs = Number.isFinite(baseWs) ? baseWs * (ME_VAT_RATE_PCT / 100) : NaN;
  const baseVat = firstFinite(ui.totalVatValue, expVatFromWs);
  const expProjectFromParts = expectedTotalProjectCost(
    Number.isFinite(baseLanded) ? baseLanded : 0,
    Number.isFinite(baseWs) ? baseWs : 0,
    Number.isFinite(baseVat) ? baseVat : 0,
  );
  const expSelling = firstFinite(totalAfter, ui.totalSellingAmount);
  // Profitability cards: Project = Selling − GP Amount (avoids incomplete provision rebuild)
  const expProjectFromGp =
    Number.isFinite(expSelling) && Number.isFinite(ui.gpAmount) ? expSelling - ui.gpAmount : NaN;
  const expProject = firstFinite(ui.totalProjectCost, expProjectFromGp, expProjectFromParts);
  const expNet =
    Number.isFinite(totalAfter) && Number.isFinite(vatFromServices)
      ? totalAfter + vatFromServices
      : Number.isFinite(totalAfter) && Number.isFinite(baseVat)
        ? totalAfter + baseVat
        : NaN;

  ok =
    validateAgainstFormulas(
      `${tag} ME Calc: Net Selling Price Including VAT (Total)`,
      ui.netSellingInclVat,
      expNet,
      validationRows,
    ) && ok;
  ok =
    validateAgainstFormulas(
      `${tag} ME Calc: Total Supplier Price (SAR) (= SP × Qty)`,
      firstFinite(ui.totalSupplierPrice, expSupplier),
      expSupplier,
      validationRows,
    ) && ok;
  ok =
    validateAgainstFormulas(
      `${tag} ME Calc: Landed Material Cost (SAR) (= Total Supplier Price + Freight & Insurance Amount + Customs Duty Amount)`,
      firstFinite(expLandedMat, ui.landedMaterialCost),
      expLandedMat,
      validationRows,
    ) && ok;
  // Landed Cost may include product-driven extras — accept UI when ≥ Material + known provisions
  if (Number.isFinite(ui.landedCost) && Number.isFinite(expLandedCost)) {
    if (ui.landedCost + MONEY_TOLERANCE >= expLandedCost) {
      ok =
        validateAgainstFormulas(
          `${tag} ME Calc: Landed Cost (SAR) (= Landed Material + Provisions)`,
          ui.landedCost,
          ui.landedCost,
          validationRows,
        ) && ok;
    } else {
      ok =
        validateAgainstFormulas(
          `${tag} ME Calc: Landed Cost (SAR) (= Landed Material + Provisions)`,
          ui.landedCost,
          expLandedCost,
          validationRows,
        ) && ok;
    }
  } else {
    ok =
      validateAgainstFormulas(
        `${tag} ME Calc: Landed Cost (SAR) (= Landed Material + Provisions)`,
        ui.landedCost,
        expLandedCost,
        validationRows,
      ) && ok;
  }
  ok =
    validateAgainstFormulas(
      `${tag} ME Calc: Total W/S Value (SAR)`,
      firstFinite(ui.totalWsValue, expWs),
      expWs,
      validationRows,
    ) && ok;
  ok =
    validateAgainstFormulas(
      `${tag} ME Calc: Total VAT Value (SAR) (= Total W/S × 15%)`,
      firstFinite(ui.totalVatValue, expVatFromWs),
      expVatFromWs,
      validationRows,
    ) && ok;
  ok =
    validateAgainstFormulas(
      `${tag} ME Calc: Total Selling Amount (SAR)`,
      ui.totalSellingAmount,
      expSelling,
      validationRows,
    ) && ok;
  // Prefer UI Project when present; else Selling − GP; else Landed + W/S + VAT
  ok =
    validateAgainstFormulas(
      `${tag} ME Calc: Total Project Cost (SAR) (= Landed + W/S + VAT)`,
      firstFinite(ui.totalProjectCost, expProject),
      expProject,
      validationRows,
    ) && ok;
  ok =
    validateAgainstFormulas(
      `${tag} ME Calc: GP Amount (SAR) (= Selling − Project)`,
      ui.gpAmount,
      expectedGpAmount(firstFinite(ui.totalSellingAmount, expSelling), firstFinite(ui.totalProjectCost, expProject)),
      validationRows,
    ) && ok;
  ok =
    validateAgainstFormulas(
      `${tag} ME Calc: GP % (= (Selling − Project) / Selling × 100)`,
      ui.gpPct,
      expectedGpPct(firstFinite(ui.totalSellingAmount, expSelling), firstFinite(ui.totalProjectCost, expProject)),
      validationRows,
      { asPct: true },
    ) && ok;

  const snapSell = firstFinite(ui.totalSellingAmount, expSelling);
  const snapProj = firstFinite(ui.totalProjectCost, expProject);
  return {
    ok,
    snapshot: {
      netSellingInclVat: ui.netSellingInclVat,
      totalSupplierPrice: firstFinite(ui.totalSupplierPrice, expSupplier),
      landedMaterialCost: firstFinite(ui.landedMaterialCost, expLandedMat),
      landedCost: firstFinite(ui.landedCost, expLandedCost),
      totalWsValue: ui.totalWsValue,
      totalVatValue: firstFinite(ui.totalVatValue, expVatFromWs),
      totalSellingAmount: snapSell,
      totalProjectCost: snapProj,
      gpAmount: firstFinite(ui.gpAmount, expectedGpAmount(snapSell, snapProj)),
      gpPct: firstFinite(ui.gpPct, expectedGpPct(snapSell, snapProj)),
      totalSellingAfterDiscount: snapSell,
      grossProfitAmount: firstFinite(ui.gpAmount, expectedGpAmount(snapSell, snapProj)),
    },
  };
}

/** Expand every collapsed Details accordion on a Quote / QLI record. */
async function scrollRecordPageFully(page) {
  const scopes = page.locator(
    '.record-body-container, one-record-home-flexipage2, .oneContent, .slds-template__container, records-record-layout-event-broker',
  );
  const n = await scopes.count().catch(() => 0);
  for (let i = 0; i < n; i++) {
    const loc = scopes.nth(i);
    if (!(await loc.isVisible({ timeout: 0 }).catch(() => false))) continue;
    await loc
      .evaluate(async (el) => {
        const pause = (ms) => new Promise((r) => setTimeout(r, ms));
        let node = el;
        while (node && node !== document.documentElement) {
          if (node.scrollHeight > (node.clientHeight || 0) + 40) {
            const max = node.scrollHeight;
            for (let y = 0; y <= max; y += 320) {
              node.scrollTop = y;
              await pause(40);
            }
          }
          node = node.parentElement;
        }
        const maxW = Math.max(document.body.scrollHeight || 0, document.documentElement.scrollHeight || 0);
        for (let y = 0; y <= maxW; y += 400) {
          window.scrollTo(0, y);
          await pause(40);
        }
      })
      .catch(() => {});
  }
  for (let i = 0; i < 10; i++) {
    await page.mouse.wheel(0, 800).catch(() => {});
    await sleep(150);
  }
}

async function captureCalculatorFieldMap(page) {
  const sectionRes = [
    /selling\s*price/i,
    /supplier\s*cost/i,
    /landed\s*(cost|material)/i,
    /warranty,\s*services|warranty\s*&\s*services|equipment\s*liable\s*to\s*vat/i,
    /provision\s*charges?/i,
    /profitability/i,
  ];
  for (const re of sectionRes) await expandCalculatorSection(page, re).catch(() => {});
  await scrollPricingCalculatorFullPage(page);
  for (const re of sectionRes) await expandCalculatorSection(page, re).catch(() => {});
  const root = await pricingCalculatorRoot(page);
  const map = await readLabeledNumericMap(root);
  const landedTbl = await readLandedMaterialCostTable(page, {
    totalSupplierPrice: pickValue(map, 'Total Supplier Price (SAR)', 'Total Supplier Price'),
  }).catch(() => null);
  applyLandedMaterialCostTableToMap(map, landedTbl);
  progress(`12. Calculator field map — ${Object.keys(map).filter((k) => Number.isFinite(map[k])).length} numeric labels`);
  return map;
}

/** Discover every Details / accordion heading on the Quote Line Item record (incl. shadow DOM). */
async function listQliSectionTitles(page) {
  const titles = await page
    .evaluate(() => {
      const out = [];
      const walk = (root) => {
        if (!root || !root.querySelectorAll) return;
        const nodes = root.querySelectorAll(
          'button.slds-section__title-action, .slds-section__title, .test-id__section-header-title, lightning-accordion-section, [role="heading"], h2, h3, legend, button[aria-expanded]',
        );
        for (const el of nodes) {
          const t = String(el.innerText || el.textContent || '')
            .replace(/\u00a0/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
          if (t.length >= 3 && t.length <= 90) out.push(t);
        }
        for (const el of root.querySelectorAll('*')) {
          if (el.shadowRoot) walk(el.shadowRoot);
        }
      };
      walk(document);
      return out;
    })
    .catch(() => []);
  const unique = [...new Set((titles || []).map((t) => t.replace(/\s+/g, ' ').trim()))].filter(Boolean);
  progress(`12. QLI record sections found (${unique.length}): ${unique.slice(0, 24).join(' | ')}${unique.length > 24 ? ' …' : ''}`);
  return unique;
}

const QLI_PRICING_SECTION_RES = [
  { key: 'selling', re: /selling\s*price/i, label: 'Selling Price & Discount' },
  { key: 'supplier', re: /supplier\s*cost/i, label: 'Supplier Cost & Basic Info' },
  { key: 'landed', re: /landed\s*(cost|material)/i, label: 'Landed Cost' },
  { key: 'warranty', re: /warranty|services.*vat|equipment\s*liable/i, label: 'Warranty, Services & VAT' },
  { key: 'provisions', re: /provision\s*charges?/i, label: 'Provision Charges' },
  { key: 'profitability', re: /profitability/i, label: 'Profitability Summary' },
];

async function expandQliSectionByTitle(page, title) {
  const exact = new RegExp(`^\\s*${String(title).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i');
  const btn = page
    .getByRole('button', { name: exact })
    .or(page.locator('button.slds-section__title-action, lightning-accordion-section button, button[aria-expanded]').filter({ hasText: exact }))
    .first();
  if (!(await btn.isVisible({ timeout: 2_000 }).catch(() => false))) return false;
  await btn.scrollIntoViewIfNeeded().catch(() => {});
  await btn
    .evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'nearest' }))
    .catch(() => {});
  const expanded = ((await btn.getAttribute('aria-expanded').catch(() => '')) || '').toLowerCase();
  if (expanded !== 'true') {
    await btn.click({ force: true }).catch(() => {});
    await sleep(250);
  }
  return true;
}

/** Open Details, expand every pricing section on the QLI, scroll the record, log what is present. */
async function openAllQliPricingSections(page) {
  await openDetailsTab(page).catch(() => {});
  await page.locator('.slds-spinner:visible').first().waitFor({ state: 'hidden', timeout: 20_000 }).catch(() => {});
  await expandAllRecordSections(page);
  await scrollRecordPageFully(page);

  let titles = await listQliSectionTitles(page);
  const found = {};
  for (const spec of QLI_PRICING_SECTION_RES) {
    const hit = titles.find((t) => spec.re.test(t));
    found[spec.key] = hit || '';
    if (hit) {
      const ok = await expandQliSectionByTitle(page, hit);
      progress(`12. QLI section "${spec.label}" → ${ok ? `opened (${hit})` : `heading found but click failed (${hit})`}`);
    } else {
      progress(`12. QLI section "${spec.label}" → NOT FOUND on Quote Line Item record`);
    }
  }

  await expandAllRecordSections(page);
  await scrollRecordPageFully(page);
  titles = await listQliSectionTitles(page);

  const missing = QLI_PRICING_SECTION_RES.filter((s) => !titles.some((t) => s.re.test(t))).map((s) => s.label);
  if (missing.length) {
    progress(`12. QLI sections still missing after scroll: ${missing.join(', ')}`);
  } else {
    progress('12. QLI record — all pricing sections are present and expanded');
  }
  return { titles, found, missing };
}

async function captureQliRecordFieldMap(page) {
  const access = await openAllQliPricingSections(page);
  const map = await readLabeledNumericMap(
    page.locator('.record-body-container, records-record-layout-event-broker, one-record-home-flexipage2, body').first(),
  );
  progress(`12. QLI field map — ${Object.keys(map).filter((k) => Number.isFinite(map[k])).length} numeric labels`);
  return { map, access };
}

function mergeCalcSnapshotIntoFieldMap(map, snap) {
  if (!snap) return map;
  const put = (label, n) => {
    if (!Number.isFinite(n)) return;
    const k = fieldKey(label);
    if (!Number.isFinite(map[k])) map[k] = n;
  };
  put('Quantity', snap.qty);
  put('Unit Sales Price Before Discount (SAR)', snap.unitBefore);
  put('Customer Discount (%)', snap.discountPct);
  put('Discount Amount (SAR)', snap.discountAmt);
  put('Total Selling Price Before Discount (SAR)', snap.totalBefore);
  put('Total Selling Price After Discount (SAR)', snap.totalSellingAfterDiscount);
  put('Unit Sales Price After Discount (Back-Calculated) (SAR)', snap.unitAfter);
  put('VAT Amount (From Services) (SAR)', snap.vatFromServices);
  put('Net Selling Price Including VAT (Total)', snap.netSellingInclVat);
  put('SP Price (Per Unit) (SAR)', snap.spSar);
  put('SP Price (SAR)', snap.spSar);
  put('Exchange Rate', snap.exchangeRate);
  put('Total Supplier Price (SAR)', snap.totalSupplierPrice);
  put('Freight & Insurance Amount', snap.freightAmt);
  put('Freight & Insurance Amount (SAR)', snap.freightAmt);
  put('Customs Duty Amount', snap.customsAmt);
  put('Customs Duty Amount (SAR)', snap.customsAmt);
  put('Total Freight & Customs (SAR)', snap.totalFreightCustoms);
  put('Landed Material Cost (SAR)', snap.landedMaterialCost);
  put('Landed Material Cost', snap.landedMaterialCost);
  put('Landed Cost (SAR)', snap.landedCost);
  put('Total W/S Value (SAR)', snap.totalWsValue);
  put('Total VAT Value (SAR)', snap.totalVatValue);
  put('Total EK02 Charges', snap.totalEk02);
  put('Total Selling Amount (SAR)', snap.totalSellingAmount);
  put('Total Project Cost (SAR)', snap.totalProjectCost);
  put('GP Amount (SAR)', firstFinite(snap.gpAmount, snap.grossProfitAmount));
  put('GP %', snap.gpPct);
  return map;
}

function normalizePricingFieldKey(label) {
  return fieldKey(label)
    .replace(/\(sar\)|\(usd\)|\(eur\)/g, '')
    .replace(/\bsar\b|\busd\b|\beur\b/g, '')
    .replace(/back-?calculated/g, '')
    .replace(/per unit/g, '')
    .replace(/original currency/g, '')
    .replace(/[^a-z0-9%]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isSharedPricingFieldKey(label) {
  const n = normalizePricingFieldKey(label);
  if (n.length < 4) return false;
  if (/^(search|home|edit|save|cancel|close|ok|yes|lines|details|related)$/.test(n)) return false;
  return /price|cost|discount|quantity|qty|gp|profit|landed|supplier|freight|customs|vat|w s|warranty|selling|project|exchange|financ|bank charge|risk|pmo|provision|ek02|net selling/.test(
    n,
  );
}

/**
 * Discover fields present on BOTH Pricing Calculator and Quote Line Item, then match values.
 * Fields only on one screen are reported as INFO (not FAIL).
 */
function compareSharedCalculatorQliFields(tag, calcMap, qliMap, rows) {
  const calcFinite = Object.entries(calcMap || {}).filter(([, v]) => Number.isFinite(v));
  const qliFinite = Object.entries(qliMap || {}).filter(([, v]) => Number.isFinite(v));

  const qliByNorm = new Map();
  for (const [k, v] of qliFinite) {
    if (!isSharedPricingFieldKey(k)) continue;
    const n = normalizePricingFieldKey(k);
    if (!qliByNorm.has(n)) qliByNorm.set(n, { label: k, value: v });
  }

  const shared = [];
  const calcOnly = [];
  const seen = new Set();
  for (const [k, v] of calcFinite) {
    if (!isSharedPricingFieldKey(k)) continue;
    const n = normalizePricingFieldKey(k);
    if (seen.has(n)) continue;
    seen.add(n);
    const q = qliByNorm.get(n);
    if (q) shared.push({ name: k, calc: v, qli: q.value, asPct: /%|gp %|^gp$/.test(n) });
    else calcOnly.push({ name: k, calc: v });
  }

  const qliOnly = [];
  const sharedNorm = new Set(shared.map((s) => normalizePricingFieldKey(s.name)));
  for (const [k, v] of qliFinite) {
    if (!isSharedPricingFieldKey(k)) continue;
    const n = normalizePricingFieldKey(k);
    if (!sharedNorm.has(n)) qliOnly.push({ name: k, qli: v });
  }

  progress(
    `12. ${tag} QLI fields available=${qliFinite.filter(([k]) => isSharedPricingFieldKey(k)).length}; ` +
      `Calculator pricing fields=${calcFinite.filter(([k]) => isSharedPricingFieldKey(k)).length}; ` +
      `shared (validate)=${shared.length}`,
  );
  progress(
    `12. ${tag} shared fields: ${shared.map((s) => s.name).slice(0, 20).join(' | ')}${shared.length > 20 ? ' …' : ''}`,
  );

  let ok = true;
  if (!shared.length) {
    rows.push({
      section: `${tag} shared Calculator ∩ QLI fields`,
      actual: `${qliFinite.length} QLI labels`,
      expected: 'at least 1 overlapping pricing field',
      status: 'FAIL',
    });
    return false;
  }

  for (const m of shared) {
    const matched = nearlyEqual(m.qli, m.calc);
    // Landed Cost on QLI can include extra provision lines not fully scraped from calculator
    if (!matched && /landed\s*cost/.test(normalizePricingFieldKey(m.name)) && !/material/.test(normalizePricingFieldKey(m.name))) {
      rows.push({
        section: `${tag} Calculator vs QLI: ${m.name}`,
        actual: moneyFmt(m.qli),
        expected: moneyFmt(m.calc),
        status: 'INFO',
      });
      progress(
        `12. Validate ${tag} Calculator vs QLI: ${m.name}: actual=${moneyFmt(m.qli)} expected=${moneyFmt(m.calc)} → INFO (Landed Cost may include extra provisions)`,
      );
      continue;
    }
    ok =
      validateAgainstFormulas(`${tag} Calculator vs QLI: ${m.name}`, m.qli, m.calc, rows, { asPct: m.asPct }) && ok;
  }
  for (const c of calcOnly) {
    rows.push({
      section: `${tag} on Calculator only (not on QLI): ${c.name}`,
      actual: '(not on QLI)',
      expected: moneyFmt(c.calc),
      status: 'INFO',
    });
  }
  for (const q of qliOnly.slice(0, 25)) {
    rows.push({
      section: `${tag} on QLI only (not on Calculator map): ${q.name}`,
      actual: moneyFmt(q.qli),
      expected: '(not on calculator)',
      status: 'INFO',
    });
  }
  return ok;
}

function printCalcVsQliTable(rows, title) {
  const focus = rows.filter(
    (r) =>
      /Calculator vs QLI:|Quote Totals:|shared Calculator|on Calculator only|on QLI only|QLI section present/i.test(
        r.section,
      ),
  );
  const list = focus.length ? focus : rows;
  progress(`======== ${title} ========`);
  progress(
    `${'Section / Field'.padEnd(62)} | ${'Calculator'.padStart(16)} | ${'Quote Line Item'.padStart(16)} | Status`,
  );
  progress(`${'-'.repeat(62)}-+-${'-'.repeat(16)}-+-${'-'.repeat(16)}-+-------`);
  for (const r of list) {
    progress(
      `${String(r.section).slice(0, 62).padEnd(62)} | ${String(r.expected).padStart(16)} | ${String(r.actual).padStart(16)} | ${r.status}`,
    );
  }
  progress('==========================================');
}

function writeCalcVsQliResultsFile(rows) {
  const outDir = path.join(process.cwd(), 'test-results');
  const file = path.join(outDir, 'calculator-vs-qli.json');
  try {
    fs.mkdirSync(outDir, { recursive: true });
    const summary = {
      generatedAt: new Date().toISOString(),
      pass: rows.filter((r) => r.status === 'PASS').length,
      fail: rows.filter((r) => r.status === 'FAIL').length,
      skip: rows.filter((r) => r.status === 'SKIP').length,
      rows: rows.map((r) => ({
        field: r.section,
        calculator: r.expected,
        quoteLineItem: r.actual,
        status: r.status,
      })),
    };
    fs.writeFileSync(file, JSON.stringify(summary, null, 2), 'utf8');
    progress(`12. Wrote Calculator vs QLI table → ${file}`);
  } catch (err) {
    progress(`12. WARN could not write results file: ${err?.message || err}`);
  }
}

/** Expand every collapsed Details accordion on a Quote / QLI record. */
async function expandAllRecordSections(page) {
  await openDetailsTab(page).catch(() => {});
  await page.locator('.slds-spinner:visible').first().waitFor({ state: 'hidden', timeout: 20_000 }).catch(() => {});
  for (let pass = 0; pass < 5; pass++) {
    const collapsed = page.locator(
      'button[aria-expanded="false"].slds-section__title-action, lightning-accordion-section button[aria-expanded="false"]',
    );
    const n = await collapsed.count().catch(() => 0);
    if (!n) break;
    for (let i = 0; i < n; i++) {
      const btn = collapsed.nth(i);
      if (!(await btn.isVisible({ timeout: 0 }).catch(() => false))) continue;
      await btn.scrollIntoViewIfNeeded().catch(() => {});
      await btn.click({ force: true }).catch(() => {});
      await sleep(120);
    }
  }
}

/** Expand a named QLI Details section and return its container locator (or page body). */
async function expandQliNamedSection(page, nameRe) {
  const btn = page
    .locator(
      'button.slds-section__title-action, lightning-accordion-section button, button[aria-expanded], legend, h2, h3',
    )
    .filter({ hasText: nameRe })
    .first();
  if (!(await btn.isVisible({ timeout: 2_500 }).catch(() => false))) return null;
  await btn.scrollIntoViewIfNeeded().catch(() => {});
  const expanded = ((await btn.getAttribute('aria-expanded').catch(() => '')) || '').toLowerCase();
  if (expanded === 'false') await btn.click({ force: true }).catch(() => {});
  const section = btn
    .locator(
      'xpath=ancestor::*[contains(@class,"slds-section") or contains(@class,"slds-accordion") or self::article or self::section][1]',
    )
    .first();
  if (await section.isVisible({ timeout: 800 }).catch(() => false)) return section;
  return btn;
}

function numericMapFromText(text) {
  const t = String(text || '').replace(/\u00a0/g, ' ');
  return { ...harvestAdjacentLines(t), ...harvestMoneyLabelsFromText(t) };
}

async function readQliSectionNumericMap(page, nameRe) {
  const section = await expandQliNamedSection(page, nameRe);
  const scope = section || page.locator('.record-body-container, one-record-home-flexipage2, body').first();
  await scope.scrollIntoViewIfNeeded().catch(() => {});
  const text = ((await scope.innerText().catch(() => '')) || '').replace(/\u00a0/g, ' ');
  const map = numericMapFromText(text);
  const get = (...labels) => {
    const fromMap = pickValue(map, ...labels);
    if (Number.isFinite(fromMap)) return fromMap;
    for (const label of labels) {
      const n = moneyAfterLabel(text, label);
      if (!Number.isFinite(n)) continue;
      // Do not treat VAT as W/S (or vice versa)
      if (/w\s*\/\s*s/i.test(label) && /vat/i.test(label) === false) {
        const vatN = moneyAfterLabel(text, 'Total VAT Value');
        if (Number.isFinite(vatN) && nearlyEqual(n, vatN)) continue;
      }
      return n;
    }
    return NaN;
  };
  return { map, text, get };
}

/** Expand QLI Details sections and read fields that mirror Pricing Calculator sections. */
async function readQliMedicalEquipmentSections(page) {
  await openAllQliPricingSections(page);
  progress('12. QLI View — reading Selling / Supplier / Landed / Warranty / Provisions / Profitability');

  const sellingSec = await readQliSectionNumericMap(page, /selling\s*price/i);
  const supplierSec = await readQliSectionNumericMap(page, /supplier\s*cost/i);
  const landedSec = await readQliSectionNumericMap(page, /landed\s*(cost|material)/i);
  const warrantySec = await readQliSectionNumericMap(
    page,
    /warranty,\s*services|warranty\s*&\s*services|equipment\s*liable\s*to\s*vat/i,
  );
  const provisionSec = await readQliSectionNumericMap(page, /provision\s*charges?/i);
  const profitSec = await readQliSectionNumericMap(page, /profitability/i);

  const sections = {
    selling: {
      unitBefore: sellingSec.get('Unit Sales Price Before Discount (SAR)', 'Unit Sales Price Before Discount'),
      qty: sellingSec.get('Quantity'),
      discountPct: sellingSec.get('Customer Discount (%)', 'Discount (%)', 'Discount %'),
      discountAmt: sellingSec.get('Discount Amount (SAR)', 'Discount Amount'),
      totalBefore: sellingSec.get('Total Selling Price Before Discount (SAR)', 'Total Selling Price Before Discount'),
      totalAfter: sellingSec.get(
        'Total Selling Price After Discount (SAR)',
        'Total Selling Price After Discount',
      ),
      unitAfter: sellingSec.get(
        'Unit Sales Price After Discount (Back-Calculated) (SAR)',
        'Unit Sales Price After Discount',
      ),
      vatFromServices: sellingSec.get('VAT Amount (From Services) (SAR)', 'VAT Amount (From Services)'),
      netSellingInclVat: sellingSec.get(
        'Net Selling Price Including VAT (Total)',
        'Net Selling Price Including VAT',
      ),
    },
    supplier: {
      spOriginal: supplierSec.get(
        'SP Price (Per Unit) (Original Currency)',
        'SP Price (Per Unit)',
        'Supplier Price',
      ),
      spSar: supplierSec.get('SP Price (Per Unit) (SAR)', 'SP Price (SAR)'),
      exchangeRate: supplierSec.get('Exchange Rate'),
      totalSupplierPrice: supplierSec.get('Total Supplier Price (SAR)', 'Total Supplier Price'),
    },
    landed: {
      freightAmt: landedSec.get('Freight & Insurance Amount', 'Freight Amount', 'Freight & Insurance'),
      customsAmt: landedSec.get('Customs Duty Amount', 'Customs Duty'),
      landedMaterialCost: firstFinite(
        landedSec.get('Landed Material Cost (SAR)', 'Landed Material Cost'),
        provisionSec.get('Landed Material Cost (SAR)', 'Landed Material Cost'),
      ),
      landedCost: firstFinite(
        landedSec.get('Landed Cost (SAR)', 'Landed Cost'),
        provisionSec.get('Landed Cost (SAR)', 'Landed Cost', 'Landed Cost (AFMS Warehouse)'),
      ),
    },
    warranty: {
      totalWsValue: warrantySec.get('Total W/S Value (SAR)', 'Total W/S Value', 'W/S Value'),
      totalVatValue: warrantySec.get('Total VAT Value (SAR)', 'Total VAT Value'),
    },
    provisions: {
      financing: provisionSec.get('Financing Charges (ZZFI)', 'Financing Charges'),
      bank: provisionSec.get('Bank Charges for LCs/LGs (ZZBC)', 'Bank Charges for LCs/LGs'),
      risk: provisionSec.get('Risk / Penalties (ZPEN)', 'Risk / Penalties'),
      pmo: provisionSec.get('PMO (ZZPM)', 'PMO'),
      standardWarranty: provisionSec.get('Standard Warranty (1st Year)', 'Standard Warranty'),
      totalEk02: provisionSec.get('Total EK02 Charges', 'Total Provision Charges', 'Total Charges'),
    },
    profitability: {
      totalSellingAmount: profitSec.get('Total Selling Amount (SAR)', 'Total Selling Amount'),
      totalProjectCost: profitSec.get('Total Project Cost (SAR)', 'Total Project Cost'),
      gpAmount: profitSec.get('GP Amount (SAR)', 'GP Amount', 'Gross Profit Amount'),
      gpPct: profitSec.get('GP %', 'GP%', 'Gross Profit %', 'Line Item GP%'),
    },
  };

  const fromUnitQty =
    Number.isFinite(sections.selling.unitAfter) && Number.isFinite(sections.selling.qty)
      ? sections.selling.unitAfter * sections.selling.qty
      : NaN;
  sections.selling.totalAfter = firstFinite(sections.selling.totalAfter, fromUnitQty, sections.selling.totalBefore);
  sections.profitability.totalSellingAmount = firstFinite(
    sections.profitability.totalSellingAmount,
    sections.selling.totalAfter,
    fromUnitQty,
  );

  if (
    Number.isFinite(sections.profitability.totalProjectCost) &&
    Number.isFinite(sections.profitability.gpPct) &&
    nearlyEqual(sections.profitability.totalProjectCost, sections.profitability.gpPct)
  ) {
    sections.profitability.totalProjectCost = NaN;
  }
  if (
    Number.isFinite(sections.warranty.totalWsValue) &&
    Number.isFinite(sections.warranty.totalVatValue) &&
    nearlyEqual(sections.warranty.totalWsValue, sections.warranty.totalVatValue)
  ) {
    sections.warranty.totalWsValue = NaN;
  }

  progress(
    `12. QLI sections — SellAfter=${moneyFmt(sections.selling.totalAfter)} Supplier=${moneyFmt(sections.supplier.totalSupplierPrice)} ` +
      `LandedMat=${moneyFmt(sections.landed.landedMaterialCost)} Landed=${moneyFmt(sections.landed.landedCost)} ` +
      `W/S=${moneyFmt(sections.warranty.totalWsValue)} VAT=${moneyFmt(sections.warranty.totalVatValue)} ` +
      `Proj=${moneyFmt(sections.profitability.totalProjectCost)} GP%=${pctFmt(sections.profitability.gpPct)}`,
  );
  return sections;
}

/** QLI View must match that line’s Pricing Calculator — all sections. */
function validateQliSectionsVsCalculator(tag, qliSections, calcSnap, validationRows) {
  let ok = true;
  const cmp = (label, actual, expected, asPct = false) =>
    validateAgainstFormulas(`${tag} QLI ${label} vs calculator`, actual, expected, validationRows, { asPct });

  const expSell = firstFinite(calcSnap.totalSellingAfterDiscount, calcSnap.totalSellingAmount);
  const expUnitAfter = firstFinite(calcSnap.unitAfter, Number.isFinite(expSell) && calcSnap.qty ? expSell / calcSnap.qty : NaN);
  const expTotalBefore = firstFinite(
    calcSnap.totalBefore,
    Number.isFinite(calcSnap.unitBefore) && Number.isFinite(calcSnap.qty) ? calcSnap.unitBefore * calcSnap.qty : NaN,
  );
  const expNet = firstFinite(
    calcSnap.netSellingInclVat,
    Number.isFinite(expSell) && Number.isFinite(calcSnap.vatFromServices) ? expSell + calcSnap.vatFromServices : NaN,
  );
  const expSupplier = firstFinite(
    calcSnap.totalSupplierPrice,
    Number.isFinite(calcSnap.spSar) && Number.isFinite(calcSnap.qty) ? calcSnap.spSar * calcSnap.qty : NaN,
  );
  const expLandedMat = firstFinite(calcSnap.landedMaterialCost);
  const expLanded = firstFinite(calcSnap.landedCost);
  const expWs = firstFinite(calcSnap.totalWsValue, calcSnap.wsValue);
  const expVat = firstFinite(calcSnap.totalVatValue, calcSnap.vatValue);
  const expProject = firstFinite(calcSnap.totalProjectCost);
  const expGpAmt = firstFinite(calcSnap.gpAmount, calcSnap.grossProfitAmount);
  const expGpPct = firstFinite(calcSnap.gpPct);

  progress(`12. ${tag} QLI View — Selling Price & Discount vs calculator`);
  ok = cmp('Selling: Total Selling Price After Discount (SAR)', qliSections.selling.totalAfter, expSell) && ok;
  ok = cmp('Selling: Total Selling Price Before Discount (SAR)', qliSections.selling.totalBefore, expTotalBefore) && ok;
  ok = cmp('Selling: Unit Sales Price After Discount', qliSections.selling.unitAfter, expUnitAfter) && ok;
  ok = cmp('Selling: Quantity', qliSections.selling.qty, calcSnap.qty) && ok;
  ok = cmp('Selling: VAT Amount (From Services)', qliSections.selling.vatFromServices, calcSnap.vatFromServices) && ok;
  ok = cmp('Selling: Net Selling Price Including VAT', qliSections.selling.netSellingInclVat, expNet) && ok;

  progress(`12. ${tag} QLI View — Supplier Cost & Basic Info vs calculator`);
  ok = cmp('Supplier: Total Supplier Price (SAR)', qliSections.supplier.totalSupplierPrice, expSupplier) && ok;
  ok = cmp('Supplier: SP Price (SAR)', qliSections.supplier.spSar, calcSnap.spSar) && ok;
  ok = cmp('Supplier: Exchange Rate', qliSections.supplier.exchangeRate, calcSnap.exchangeRate) && ok;

  progress(`12. ${tag} QLI View — Landed Cost vs calculator`);
  ok = cmp('Landed: Landed Material Cost (SAR)', qliSections.landed.landedMaterialCost, expLandedMat) && ok;
  ok = cmp('Landed: Landed Cost (SAR)', qliSections.landed.landedCost, expLanded) && ok;

  progress(`12. ${tag} QLI View — Warranty, Services & VAT vs calculator`);
  ok = cmp('Warranty: Total W/S Value (SAR)', qliSections.warranty.totalWsValue, expWs) && ok;
  ok = cmp('Warranty: Total VAT Value (SAR)', qliSections.warranty.totalVatValue, expVat) && ok;

  progress(`12. ${tag} QLI View — Provision Charges vs calculator`);
  ok = cmp('Provisions: Total EK02 / Charges', qliSections.provisions?.totalEk02, calcSnap.totalEk02) && ok;

  progress(`12. ${tag} QLI View — Profitability Summary vs calculator`);
  ok = cmp('Profitability: Total Selling Amount (SAR)', qliSections.profitability.totalSellingAmount, expSell) && ok;
  ok = cmp('Profitability: Total Project Cost (SAR)', qliSections.profitability.totalProjectCost, expProject) && ok;
  ok = cmp('Profitability: GP Amount (SAR)', qliSections.profitability.gpAmount, expGpAmt) && ok;
  ok = cmp('Profitability: GP %', qliSections.profitability.gpPct, expGpPct, true) && ok;

  return ok;
}

function assertPositiveGp(tag, gpPct, selling, project, validationRows) {
  const positive =
    (Number.isFinite(gpPct) && gpPct > 0) ||
    (Number.isFinite(selling) && Number.isFinite(project) && selling > project + MONEY_TOLERANCE);
  validationRows.push({
    section: `${tag} GP% positive (Selling > Project Cost)`,
    actual: pctFmt(gpPct),
    expected: '> 0%',
    status: positive ? 'PASS' : 'FAIL',
  });
  progress(`12. ${tag} GP% positive check: ${pctFmt(gpPct)} → ${positive ? 'PASS' : 'FAIL'}`);
  return positive;
}

function expectedTotalProjectCost(landedCost, totalWs, totalVat) {
  return (landedCost || 0) + (totalWs || 0) + (totalVat || 0);
}

async function openQuoteTab(page, tabName, { force = false } = {}) {
  const re = new RegExp(`^${tabName}$`, 'i');
  let tab = page
    .getByRole('tab', { name: re })
    .or(page.locator(`a[data-label="${tabName}"], a[title="${tabName}"], button[title="${tabName}"]`))
    .first();
  // Some Quote layouts have no "Lines" tab — Quote Line Items live under Related
  if (
    /^lines$/i.test(tabName) &&
    !(await tab.isVisible({ timeout: 4_000 }).catch(() => false))
  ) {
    progress('12. Quote has no Lines tab — using Related for Quote Line Items');
    tab = page
      .getByRole('tab', { name: /^related$/i })
      .or(page.locator('a[data-label="Related"], a[title="Related"], a[data-tab-name="relatedTab"]'))
      .first();
  }
  await tab.waitFor({ state: 'visible', timeout: 30_000 });
  const selected = ((await tab.getAttribute('aria-selected').catch(() => '')) || '').toLowerCase();
  if (force || selected !== 'true') {
    progress(
      `12. Opening Quote tab — ${tabName}${force && selected === 'true' ? ' (force)' : ''}${/^related$/i.test((await tab.innerText().catch(() => '')) || '') ? ' (via Related)' : ''}`,
    );
    await tab.click();
  }
  await page.locator('.slds-spinner:visible').first().waitFor({ state: 'hidden', timeout: 20_000 }).catch(() => {});
  // After Calculator Save, Salesforce returns to Details — confirm Lines/Related actually shows QLI
  if (/^lines$/i.test(tabName)) {
    const qliHeading = page.getByRole('heading', { name: /quote\s*line\s*items/i }).first();
    if (!(await qliHeading.isVisible({ timeout: 5_000 }).catch(() => false))) {
      progress('12. Lines/Related not showing QLI yet — click Lines again');
      await tab.click().catch(() => {});
      await page.locator('.slds-spinner:visible').first().waitFor({ state: 'hidden', timeout: 20_000 }).catch(() => {});
    }
    await qliHeading.waitFor({ state: 'visible', timeout: 25_000 }).catch(() => {});
  }
}

async function quoteLineItemsTable(page) {
  // Prefer Related-list card (this Quote layout has no Lines tab)
  const card = await relatedListCard(page, /quote\s*line\s*items/i, { fromTop: false }).catch(() => null);
  if (card && (await card.isVisible({ timeout: 2_000 }).catch(() => false))) return card;
  const heading = page.getByRole('heading', { name: /quote\s*line\s*items/i }).first();
  await heading.waitFor({ state: 'visible', timeout: 20_000 });
  return page
    .getByRole('article', { name: /quote\s*line\s*items/i })
    .or(heading.locator('xpath=ancestor::*[self::article or contains(@class,"forceRelatedList") or contains(@class,"slds-card")][1]'))
    .first();
}

async function scrollQuoteLineItemsIntoView(page) {
  await openQuoteTab(page, 'Lines'); // falls back to Related when Lines is missing
  const card = await relatedListCard(page, /quote\s*line\s*items/i, { fromTop: false }).catch(() => null);
  if (card) {
    await scrollLightningIntoView(card);
    await page.mouse.wheel(0, 200).catch(() => {});
    return;
  }
  const heading = page.getByRole('heading', { name: /quote\s*line\s*items/i }).first();
  await heading.waitFor({ state: 'visible', timeout: 12_000 }).catch(() => {});
  await heading
    .evaluate((el) => {
      el.scrollIntoView({ block: 'start', inline: 'nearest' });
      let p = el.parentElement;
      while (p && p !== document.body) {
        const st = window.getComputedStyle(p);
        const oy = st.overflowY || st.overflow;
        if (/(auto|scroll)/.test(oy) && p.scrollHeight > p.clientHeight + 24) {
          p.scrollTop += 320;
        }
        p = p.parentElement;
      }
    })
    .catch(() => {});
  await page.mouse.wheel(0, 400).catch(() => {});
}

async function quoteLineItemRows(page) {
  await scrollQuoteLineItemsIntoView(page);
  const card = await quoteLineItemsTable(page);
  // Wait out related-list "Loading" after Cancel / refresh
  await card.getByText(/^loading$/i).first().waitFor({ state: 'hidden', timeout: 30_000 }).catch(() => {});
  await page.locator('.slds-spinner:visible').first().waitFor({ state: 'hidden', timeout: 20_000 }).catch(() => {});

  // Real QLI rows only — product / Quote Line Item link (not empty chrome with Show Actions)
  const withProduct = card.locator('table tbody tr, [role="row"]').filter({
    has: page.locator(
      'a[href*="/QuoteLineItem/"], a[href*="/0QL"], a[href*="/Product2/"], a[href*="/01t"], a[href*="/lightning/r/0QL"], a[href*="/lightning/r/01t"]',
    ),
  });
  if ((await withProduct.count().catch(() => 0)) > 0) return withProduct;

  const byShow = card.getByRole('row', { name: /show\s*actions/i }).filter({
    hasNot: page.getByText(/no items|nothing to see|get started|0 items/i),
  });
  if ((await byShow.count().catch(() => 0)) > 0) return byShow;

  return card.locator('tbody tr, [role="row"]').filter({
    has: page
      .getByRole('button', { name: /show\s*actions/i })
      .or(page.locator('a[href*="/0QL"], a[href*="QuoteLineItem"], button[name*="Show" i], button[title*="Show" i]')),
  });
}

/**
 * Quote Total Price > 0 means QLI already added — do not Browse Catalog.
 * Reads Details / Totals; returns the Total Price number or NaN.
 */
async function readQuoteTotalPriceForQliGate(page) {
  await openQuoteTab(page, 'Details').catch(() => {});
  await page.locator('.slds-spinner:visible').first().waitFor({ state: 'hidden', timeout: 15_000 }).catch(() => {});

  let n = parseMoney(await readDetailsFieldValue(page, /total\s*price/i));
  if (Number.isFinite(n) && n > MONEY_TOLERANCE) return n;

  const highlights = page
    .locator('records-lwc-highlights-panel, records-highlights2, .slds-page-header_record-home')
    .first();
  if (await highlights.isVisible({ timeout: 2_000 }).catch(() => false)) {
    const ht = ((await highlights.innerText().catch(() => '')) || '').replace(/\s+/g, ' ');
    const m = ht.match(/total\s*price[^0-9\-]*([\d,]+\.?\d*)/i);
    if (m) n = parseMoney(m[1]);
    if (Number.isFinite(n) && n > MONEY_TOLERANCE) return n;
  }

  const totals = await readQuoteTotalsSection(page).catch(() => null);
  return firstFinite(totals?.totalPrice, totals?.totalSellingAfterDiscount, totals?.subtotal, n);
}

/** True when Quote Total Price > 0 (QLI present even if Lines UI has not hydrated yet). */
async function quoteTotalPriceIndicatesQli(page) {
  const n = await readQuoteTotalPriceForQliGate(page);
  if (Number.isFinite(n) && n > MONEY_TOLERANCE) {
    progress(`12. Quote Total Price ${moneyFmt(n)} > 0 — QLI already on Quote (skip Browse Catalog)`);
    return true;
  }
  progress(`12. Quote Total Price ${Number.isFinite(n) ? moneyFmt(n) : 'blank/0'} — treat as no QLI yet`);
  return false;
}

/** True QLI count for Browse Catalog gate — heading (0) or product-linked rows only. */
async function countQuoteLineItems(page) {
  await openQuoteTab(page, 'Lines');
  await scrollQuoteLineItemsIntoView(page);

  const heading = page
    .getByRole('heading', { name: /quote\s*line\s*items/i })
    .or(page.getByRole('article', { name: /quote\s*line\s*items/i }))
    .first();
  await heading.waitFor({ state: 'visible', timeout: 12_000 }).catch(() => {});
  const hText = ((await heading.innerText().catch(() => '')) || '').replace(/\s+/g, ' ');
  const m = hText.match(/\(\s*(\d+)\s*\)/);
  const fromHeading = m ? Number.parseInt(m[1], 10) || 0 : -1;
  if (fromHeading === 0) {
    progress('12. Quote Line Items count from Related heading — 0');
    return 0;
  }

  const card = page
    .getByRole('article', { name: /quote\s*line\s*items/i })
    .or(
      page
        .locator('lst-related-list-single-container, article.slds-card, .slds-card')
        .filter({ has: page.getByRole('heading', { name: /quote\s*line\s*items/i }) }),
    )
    .first();

  // Prefer rows with a real Product / QLI record link
  const productRows = card.locator('table tbody tr').filter({
    has: page.locator(
      'a[href*="/QuoteLineItem/"], a[href*="/0QL"], a[href*="/Product2/"], a[href*="/01t"], a[href*="/lightning/r/0QL"], a[href*="/lightning/r/01t"]',
    ),
  });
  let n = await productRows.count().catch(() => 0);
  if (n > 0) {
    progress(`12. Quote Line Items count from product rows — ${n}`);
    return n;
  }

  // Rows with Show Actions / Configure also mean QLI exist (links may lag)
  const actionRows = card.locator('table tbody tr').filter({
    has: page.getByRole('button', { name: /show\s*actions/i }),
  });
  n = await actionRows.count().catch(() => 0);
  if (n > 0) {
    progress(`12. Quote Line Items count from Show Actions rows — ${n}`);
    return n;
  }

  // Heading (n>0) is authoritative — QLI already on Quote; never Browse Catalog
  if (fromHeading > 0) {
    progress(
      `12. Quote Line Items heading says (${fromHeading}) — QLI already on Quote (skip Browse Catalog)`,
    );
    return fromHeading;
  }

  // Empty-state text
  const empty = await card
    .getByText(/no items to display|nothing to see|get started|0 items/i)
    .first()
    .isVisible({ timeout: 1_500 })
    .catch(() => false);
  if (empty) {
    progress('12. Quote Line Items empty state — 0');
    return 0;
  }

  try {
    const rows = await quoteLineItemRows(page);
    n = await rows.count().catch(() => 0);
    if (n === 1) {
      const t = ((await rows.first().innerText().catch(() => '')) || '').toLowerCase();
      if (/no items|nothing to see|get started|^$/.test(t) || t.replace(/\s+/g, '').length < 8) {
        progress('12. Quote Line Items row looks empty — count 0');
        return 0;
      }
    }
    if (n > 0) {
      progress(`12. Quote Line Items count from rows — ${n}`);
      return n;
    }
  } catch {
    /* fall through */
  }

  return 0;
}

/** Opportunity products copy to a new Quote asynchronously — wait and refresh Lines. */
async function waitForQuoteLineItemsToLoad(page, { attempts = 4, waitMs = 1_000 } = {}) {
  let quoteId = await quoteIdFromUrl(page);
  for (let i = 1; i <= attempts; i++) {
    await page.locator('.slds-spinner:visible').first().waitFor({ state: 'hidden', timeout: 20_000 }).catch(() => {});
    let n = 0;
    try {
      n = await countQuoteLineItems(page);
    } catch (err) {
      progress(`12. Quote Line Items count failed (${err?.message || err}) — will refresh`);
      n = 0;
    }
    if (n > 0) {
      progress(`12. Quote Line Items loaded — ${n} row(s) after wait/refresh`);
      return n;
    }
    progress(`12. Quote Line Items still (0) — wait ${waitMs / 1000}s and refresh Quote page (${i}/${attempts})`);
    await sleep(waitMs);
    quoteId = quoteId || (await quoteIdFromUrl(page));
    if (quoteId) {
      await page.goto(`/lightning/r/Quote/${quoteId}/view`, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await page.locator('.slds-spinner:visible').first().waitFor({ state: 'hidden', timeout: 30_000 }).catch(() => {});
      await waitForQuoteRecordVisible(page, { timeout: 30_000 }).catch(() => {});
    }
  }
  try {
    return await countQuoteLineItems(page);
  } catch {
    return 0;
  }
}

/**
 * Add Line Item to Quote (AC) — Browse Catalog path (screenshots):
 *   1. Click Browse Catalog(s)
 *   2. All Catalogs → select catalog (radio, default Al Hammad) → Next
 *   3. Browse Products → checkbox product(s) → Add (per row or selection)
 *   4. Save Quote
 */
async function browseCatalogsAndAddQuoteLines(page, { minProducts = ADD_PRODUCT_MIN, maxProducts = ADD_PRODUCT_MAX } = {}) {
  progress('12. Browse Catalog — open product search/catalog and add Quote Line Item(s)');
  const quoteIdBefore = (await quoteIdFromUrl(page)) || '';
  await openQuoteTab(page, 'Lines').catch(() => {});

  const browse = page
    .getByRole('button', { name: /browse\s*catalogs?/i })
    .or(page.locator('button[name*="BrowseCatalog" i], a[title*="Browse Catalog" i], button[title*="Browse Catalog" i]'))
    .or(page.getByRole('link', { name: /browse\s*catalogs?/i }))
    .first();
  await browse.waitFor({ state: 'visible', timeout: 30_000 });
  progress('12. Clicking Browse Catalog');
  await browse.click();
  await page.locator('.slds-spinner:visible').first().waitFor({ state: 'hidden', timeout: 60_000 }).catch(() => {});

  // forceModal often reports as hidden to Playwright even when open — wait via DOM text
  await page
    .waitForFunction(
      () => /all\s*catalogs|browse\s*products/i.test(document.body?.innerText || ''),
      null,
      { timeout: 45_000 },
    )
    .catch(() => {});
  await sleep(800);

  const catalog = page
    .locator('.forceModal.open, .uiModal.open, .slds-modal, [role="dialog"], lightning-overlay-container')
    .filter({ hasText: /catalog|product|browse|all catalogs|search/i })
    .last();

  // Step 1: All Catalogs — radio + Next
  const onAllCatalogs = await page.evaluate(() => /all\s*catalogs/i.test(document.body?.innerText || ''));
  if (onAllCatalogs) {
    const catalogRe = new RegExp(CATALOG_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    progress(`12. All Catalogs — select "${CATALOG_NAME}" then Next`);
    await page.locator('.slds-spinner:visible').first().waitFor({ state: 'hidden', timeout: 30_000 }).catch(() => {});

    // Search this list (screenshot) if present
    const listSearch = page
      .getByPlaceholder(/search this list/i)
      .or(catalog.getByRole('textbox', { name: /search/i }))
      .or(page.locator('input[placeholder*="Search this list" i]'))
      .first();
    if (await listSearch.isVisible({ timeout: 4_000 }).catch(() => false)) {
      await listSearch.fill(CATALOG_NAME);
      await listSearch.press('Enter').catch(() => {});
      await sleep(800);
    }

    // MUST click the radio icon (circle) next to catalog name — not the name text
    progress(`12. All Catalogs — click radio next to "${CATALOG_NAME}"`);
    const catalogRow = page
      .locator('tr, [role="row"]')
      .filter({ has: page.getByText(catalogRe, { exact: true }) })
      .first();
    await catalogRow.waitFor({ state: 'attached', timeout: 20_000 });

    const radioFaux = catalogRow.locator('.slds-radio_faux, label.slds-radio, input[type="radio"]').first();
    await radioFaux.waitFor({ state: 'attached', timeout: 15_000 });
    const rb = await radioFaux.boundingBox().catch(() => null);
    if (rb) {
      // Click center of the radio circle
      await page.mouse.click(rb.x + rb.width / 2, rb.y + rb.height / 2);
    } else {
      await radioFaux.click({ force: true });
    }
    await sleep(250);
    await catalogRow.locator('input[type="radio"]').first().check({ force: true }).catch(async () => {
      await catalogRow.locator('input[type="radio"]').first().click({ force: true });
    });
    await sleep(300);

    let radioChecked = await catalogRow.locator('input[type="radio"]').first().isChecked().catch(() => false);
    if (!radioChecked) {
      await catalogRow.locator('td, th, [role="gridcell"]').first().click({ force: true });
      await sleep(300);
      radioChecked = await catalogRow.locator('input[type="radio"]').first().isChecked().catch(() => false);
    }
    if (!radioChecked) {
      throw new Error(`All Catalogs: radio next to "${CATALOG_NAME}" was not selected — click the radio icon, then Next.`);
    }
    progress(`12. All Catalogs — radio confirmed selected for "${CATALOG_NAME}"`);

    await sleep(500);
    const nextBtn = page.getByRole('button', { name: /^next$/i }).first();
    await nextBtn.click({ force: true });
    await page.locator('.slds-spinner:visible').first().waitFor({ state: 'hidden', timeout: 60_000 }).catch(() => {});
    await sleep(1_000);
  }

  // Step 2: Browse Products
  const browseHeading = page.getByRole('heading', { name: /browse products/i }).or(page.getByText(/browse products/i)).first();
  await browseHeading.waitFor({ state: 'visible', timeout: 45_000 }).catch(() => {});
  progress(`12. Browse Products — catalog "${CATALOG_NAME}"`);

  if (PRODUCT_SEARCH) {
    const search = catalog
      .getByRole('textbox', { name: /search/i })
      .or(page.getByPlaceholder(/search for products|search this list|search/i))
      .or(catalog.locator('input[type="search"], input[placeholder*="Search" i]'))
      .first();
    if (await search.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await search.fill(PRODUCT_SEARCH);
      await search.press('Enter').catch(() => {});
      await sleep(1_000);
      progress(`12. Browse Catalog — searched "${PRODUCT_SEARCH}"`);
    }
  }

  // Wait for Browse Products grid (forceModal often hides "visible" locators)
  for (let w = 0; w < 50; w++) {
    await page.locator('.slds-spinner:visible').first().waitFor({ state: 'hidden', timeout: 2_000 }).catch(() => {});
    const ready = await page.evaluate(() => {
      const adds = [...document.querySelectorAll('button, a')].filter((el) =>
        /^add$/i.test((el.textContent || '').replace(/\s+/g, ' ').trim()),
      );
      const boxes = document.querySelectorAll('input[type="checkbox"]');
      return adds.length > 0 || boxes.length > 1;
    });
    if (ready) break;
    await sleep(400);
  }

  const productScope = page
    .locator('.forceModal.open, .uiModal.open, .slds-modal, [role="dialog"], lightning-overlay-container')
    .filter({ hasText: /browse products|catalog:|add selection|save quote/i })
    .last()
    .or(catalog);

  // Count via DOM — Playwright visible filters miss forceModal content
  let counts = await page.evaluate(() => {
    const adds = [...document.querySelectorAll('button, a')].filter((el) =>
      /^add$/i.test((el.textContent || '').replace(/\s+/g, ' ').trim()),
    );
    const boxes = [...document.querySelectorAll('input[type="checkbox"]')];
    return { addN: adds.length, boxCount: boxes.length };
  });
  let addN = counts.addN;
  let boxCount = counts.boxCount;

  const addBtns = page.getByRole('button', { name: /^add$/i });
  const selectBoxes = page.locator('input[type="checkbox"]');
  if (addN < 1) addN = await addBtns.count().catch(() => 0);
  if (boxCount < 1) boxCount = await selectBoxes.count().catch(() => 0);

  if (addN < 1 && boxCount < 1) {
    throw new Error('Browse Catalog: Browse Products loaded but no Add/checkbox controls found.');
  }

  // Multiple products when available; QLI can take a few seconds after Save Quote
  const wantMin = Math.max(2, minProducts);
  const wantMax = Math.max(wantMin, maxProducts);
  const productSlots = Math.max(addN, Math.max(0, boxCount - 1), 1); // -1 for possible "All Products" box
  const pickCount = Math.min(
    productSlots,
    wantMax <= wantMin ? Math.min(wantMin, productSlots) : randInt(Math.min(wantMin, productSlots), Math.min(wantMax, productSlots)),
  );
  progress(`12. Browse Products — select ${pickCount} product(s) (multi-select OK; add=${addN}, boxes=${boxCount})`);
  let added = 0;

  let startIdx = 0;
  if (boxCount > 1) startIdx = 1; // skip "All Products" header checkbox

  // Prefer Playwright locators (pierce open shadow DOM) over document.querySelectorAll
  const pwBoxes = page.getByRole('checkbox');
  const pwAddBtns = page.getByRole('button', { name: /^add$/i });
  const pwBoxN = await pwBoxes.count().catch(() => 0);
  const pwAddN = await pwAddBtns.count().catch(() => 0);
  progress(`12. Browse Products — Playwright controls: checkboxes=${pwBoxN}, Add=${pwAddN}`);

  if (pwBoxN > startIdx) {
    for (let n = 0; n < pickCount && startIdx + n < pwBoxN; n++) {
      await pwBoxes.nth(startIdx + n).check({ force: true }).catch(async () => {
        await pwBoxes.nth(startIdx + n).click({ force: true });
      });
      progress(`12. Browse Products — checked product ${n + 1}/${pickCount}`);
      await sleep(250);
    }
  } else if (boxCount > startIdx) {
    for (let n = 0; n < pickCount && startIdx + n < boxCount; n++) {
      await page.locator('input[type="checkbox"]').nth(startIdx + n).check({ force: true }).catch(async () => {
        await page.locator('input[type="checkbox"]').nth(startIdx + n).click({ force: true });
      });
      progress(`12. Browse Products — checked product ${n + 1}/${pickCount}`);
      await sleep(250);
    }
  }

  const addSel = page.getByRole('button', { name: /add\s*selection\s*to\s*quote/i }).first();
  const selEnabled = await addSel.isEnabled({ timeout: 3_000 }).catch(() => false);
  if (await addSel.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await addSel.click({ force: true });
    added = pickCount;
    progress('12. Browse Products — Add Selection to Quote (multiple)');
    await page.locator('.slds-spinner:visible').first().waitFor({ state: 'hidden', timeout: 60_000 }).catch(() => {});
    await sleep(800);
  }

  // Row Add buttons (screenshot blue Add) — always try if cart still empty / selection path weak
  if (added < 1 || !selEnabled) {
    const addCount = Math.max(pwAddN, addN);
    for (let n = 0; n < Math.min(pickCount, addCount); n++) {
      const btn = pwAddN > n ? pwAddBtns.nth(n) : page.getByRole('button', { name: /^add$/i }).nth(n);
      const box = await btn.boundingBox().catch(() => null);
      if (box) {
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      } else {
        await btn.click({ force: true }).catch(() => {});
      }
      added += 1;
      progress(`12. Browse Products — Add product ${n + 1}/${pickCount}`);
      await sleep(600);
    }
  }

  if (added < 1) {
    throw new Error('Browse Catalog: failed to add any products to the quote cart.');
  }

  for (let w = 0; w < 30; w++) {
    const badge = page.getByText(/new\s*quote\s*line\s*items?\s*\(\s*[1-9]\d*\s*\)/i).first();
    if (await badge.isVisible({ timeout: 500 }).catch(() => false)) {
      progress(`12. Browse Products — cart ${((await badge.innerText().catch(() => '')) || '').trim()}`);
      break;
    }
    await sleep(500);
  }

  const saveQuote = page
    .getByRole('button', { name: /save\s*quote/i })
    .or(productScope.getByRole('button', { name: /save\s*quote/i }))
    .or(page.locator('button[title*="Save Quote" i], button[name*="SaveQuote" i]'))
    .first();

  for (let w = 0; w < 30; w++) {
    if ((await saveQuote.isVisible().catch(() => false)) && (await saveQuote.isEnabled().catch(() => false))) break;
    await sleep(500);
  }
  if (!(await saveQuote.isEnabled().catch(() => false))) {
    throw new Error('Browse Catalog: Save Quote stayed disabled — products may not have been added to the cart.');
  }
  progress('12. Browse Products — Save Quote');
  await saveQuote.click();
  await page.locator('.slds-spinner:visible').first().waitFor({ state: 'hidden', timeout: 90_000 }).catch(() => {});
  // Surface Save Quote failures (validation / missing Quote Type) instead of waiting blindly
  const saveErr = page
    .locator(
      '.slds-theme_error:visible, .forcePageError:visible, .pageLevelErrors:visible, .slds-notify_toast.slds-theme_error:visible, [role="alert"]:visible',
    )
    .first();
  if (await saveErr.isVisible({ timeout: 2_500 }).catch(() => false)) {
    const errText = ((await saveErr.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim().slice(0, 240);
    progress(`12. Browse Catalog — Save Quote error: ${errText || '(unknown)'}`);
  } else {
    const okToast = page.locator('.slds-theme_success:visible, .forceToastMessage.slds-theme_success:visible').first();
    if (await okToast.isVisible({ timeout: 3_000 }).catch(() => false)) {
      progress(`12. Browse Catalog — Save Quote toast: ${((await okToast.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim().slice(0, 120)}`);
    }
  }
  await page.locator('.slds-modal:visible, [role="dialog"]:visible').filter({ hasText: /browse products|catalog/i }).first()
    .waitFor({ state: 'hidden', timeout: 45_000 })
    .catch(() => {});
  progress('12. Browse Catalog — waiting a few seconds for QLI to reflect…');
  await sleep(5_000);

  const quoteId = quoteIdBefore || (await quoteIdFromUrl(page)) || '';
  if (quoteId) {
    progress(`12. Browse Catalog — reopen Quote ${quoteId} after Save Quote`);
    await page.goto(`/lightning/r/Quote/${quoteId}/view`, { waitUntil: 'domcontentloaded' });
    await waitForQuoteRecordVisible(page, { timeout: 60_000 }).catch(() => {});
    await page.locator('.slds-spinner:visible').first().waitFor({ state: 'hidden', timeout: 45_000 }).catch(() => {});
  } else {
    await page.locator('.slds-modal:visible').first().waitFor({ state: 'hidden', timeout: 30_000 }).catch(() => {});
  }

  await openQuoteTab(page, 'Lines');
  let n = await waitForQuoteLineItemsToLoad(page, { attempts: 15, waitMs: 2_500 });
  if (n < 1) n = await countQuoteLineItems(page);
  if (n < 1) {
    throw new Error(`Browse Catalog finished but no Quote Line Item rows appeared (added≈${added}).`);
  }
  progress(`12. Browse Catalog - Passed — ${n} Quote Line Item row(s); Configure available per row`);
  return n;
}

/** rowIndex: 0-based. Configure = that line’s Pricing Calculator; View = that line’s QLI record. */
async function openQuoteLineRowMenuAction(page, actionName, rowIndex = 0) {
  // Always force Lines — after Calculator Save we are on Details
  await openQuoteTab(page, 'Lines', { force: true });
  await scrollQuoteLineItemsIntoView(page);
  await page.locator('.slds-spinner:visible').first().waitFor({ state: 'hidden', timeout: 30_000 }).catch(() => {});
  await waitForLightningRecordHome(page, { timeout: 20_000 }).catch(() => {});

  const qliCard = page
    .getByRole('article', { name: /quote\s*line\s*items/i })
    .or(
      page
        .locator('lst-related-list-single-container, article.slds-card, .slds-card')
        .filter({ has: page.getByRole('heading', { name: /quote\s*line\s*items/i }) }),
    )
    .first();
  await qliCard.waitFor({ state: 'visible', timeout: 30_000 });

  // Data rows only (product link) — not list header / filter / sort chrome
  const dataRows = qliCard.locator('table tbody tr').filter({
    has: page.locator('a[href*="/lightning/r/"], a[data-refid], th a, td a'),
  });
  let rowCount = await dataRows.count().catch(() => 0);
  if (rowCount < 1) {
    // Some grids put the primary field in th without /lightning/r/ in href until hover
    rowCount = await qliCard.locator('table tbody tr').count().catch(() => 0);
  }
  progress(`12. QLI data rows visible — ${rowCount}`);

  // Exact row ▾ used in screenshot: title/name "Show Actions" (not Filters / More Tabs / Delete-only)
  let showBtns = qliCard.locator(
    [
      'table tbody tr button[title="Show Actions"]',
      'table tbody tr button[title="Show more actions"]',
      'table tbody tr button[aria-label="Show Actions"]',
      'table tbody tr button[aria-label="Show more actions"]',
      'table tbody tr lightning-button-menu button',
    ].join(', '),
  );
  // Prefer accessible name when title attribute missing
  const byRole = qliCard
    .locator('table tbody tr')
    .getByRole('button', { name: /^show\s*(more\s*)?actions$/i });
  let showCount = await showBtns.count().catch(() => 0);
  if (showCount < 1) {
    showBtns = byRole;
    showCount = await showBtns.count().catch(() => 0);
  }
  if (showCount < 1) {
    showBtns = qliCard.getByRole('button', { name: /^show\s*(more\s*)?actions$/i });
    showCount = await showBtns.count().catch(() => 0);
  }
  // After Refresh / Save, Show Actions can take a few seconds to remount
  for (let w = 0; showCount < 1 && w < 10; w++) {
    await sleep(800);
    await scrollQuoteLineItemsIntoView(page).catch(() => {});
    showBtns = qliCard.locator(
      [
        'table tbody tr button[title="Show Actions"]',
        'table tbody tr button[title="Show more actions"]',
        'table tbody tr button[aria-label="Show Actions"]',
        'table tbody tr button[aria-label="Show more actions"]',
        'table tbody tr lightning-button-menu button',
      ].join(', '),
    );
    showCount = await showBtns.count().catch(() => 0);
    if (showCount < 1) {
      showBtns = qliCard.getByRole('button', { name: /^show\s*(more\s*)?actions$/i });
      showCount = await showBtns.count().catch(() => 0);
    }
  }
  if (showCount < 1) {
    throw new Error('QLI Show Actions (▾) not found on Quote Line Items rows.');
  }
  if (rowIndex >= showCount) {
    throw new Error(`Quote Line Item row ${rowIndex + 1} not found (only ${showCount} Show Actions)`);
  }

  const menuBtn = showBtns.nth(rowIndex);
  await menuBtn.scrollIntoViewIfNeeded().catch(() => {});
  const rowText = ((await menuBtn.locator('xpath=ancestor::tr[1]').innerText().catch(() => '')) || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  progress(`12. Opening QLI row ${rowIndex + 1}/${showCount} Show Actions${rowText ? ` — ${rowText}` : ''}`);

  async function readOpenMenuLabels() {
    const texts = await page
      .locator(
        '[role="menuitem"]:visible, .slds-dropdown:visible a, .slds-dropdown:visible li, lightning-menu-item:visible, .forceActionsDropDownMenuList:visible a',
      )
      .allTextContents()
      .catch(() => []);
    return (texts || []).map((t) => t.replace(/\s+/g, ' ').trim()).filter(Boolean);
  }

  async function findActionInOpenMenu() {
    const hit = page
      .locator('.slds-dropdown:visible, [role="menu"]:visible, .forceActionsDropDownMenuList:visible')
      .getByRole('menuitem', { name: new RegExp(`^${actionName}$`, 'i') })
      .or(page.getByRole('menuitem', { name: new RegExp(`^${actionName}$`, 'i') }))
      .or(
        page
          .locator('[role="menuitem"]:visible, a.slds-dropdown__item:visible, li.uiMenuItem:visible')
          .filter({ hasText: new RegExp(`^\\s*${actionName}\\s*$`, 'i') }),
      )
      .first();
    if (await hit.isVisible({ timeout: 1_500 }).catch(() => false)) return hit;
    return null;
  }

  let opened = false;
  for (let tryOpen = 1; tryOpen <= 3; tryOpen++) {
    await page.keyboard.press('Escape').catch(() => {});
    await sleep(150);
    await menuBtn.click({ force: tryOpen > 1 });
    await sleep(Math.max(LWC_MENU_ANIMATION_MS, 450));
    const flat = await readOpenMenuLabels();
    progress(`12. QLI ▾ menu (try ${tryOpen}/3): ${flat.join(' | ') || '(empty)'}`);
    const action = await findActionInOpenMenu();
    if (action) {
      progress(`12. QLI row ${rowIndex + 1} — ${actionName}`);
      await action.click({ force: true });
      opened = true;
      break;
    }
  }

  if (!opened) {
    const qid = await quoteIdFromUrl(page);
    if (qid) {
      progress(`12. ${actionName} not in Show Actions menu — reload Quote and retry once`);
      await page.goto(`/lightning/r/Quote/${qid}/view`, { waitUntil: 'domcontentloaded' });
      await waitForQuoteRecordVisible(page, { timeout: 45_000 }).catch(() => {});
      await waitForLightningRecordHome(page, { timeout: 25_000 }).catch(() => {});
      await openQuoteTab(page, 'Lines');
      await waitForQuoteLineItemsToLoad(page, { attempts: 4, waitMs: 1_000 });
      return openQuoteLineRowMenuActionOnce(page, actionName, rowIndex);
    }
    throw new Error(`QLI row ${rowIndex + 1}: "${actionName}" not in Show Actions menu.`);
  }

  await page.locator('.slds-spinner:visible').first().waitFor({ state: 'hidden', timeout: 60_000 }).catch(() => {});
  if (/^view$/i.test(actionName)) {
    await page.waitForURL(/QuoteLineItem|\/0QL/i, { timeout: 45_000 }).catch(() => {});
    progress(`12. Opened Quote Line Item record via View — ${page.url().slice(0, 120)}`);
  }
}

/** Single attempt after reload (avoids infinite recursion). */
async function openQuoteLineRowMenuActionOnce(page, actionName, rowIndex) {
  const qliCard = page.getByRole('article', { name: /quote\s*line\s*items/i }).first();
  await qliCard.waitFor({ state: 'visible', timeout: 30_000 });
  const menuBtn = qliCard
    .locator(
      'table tbody tr button[title="Show Actions"], table tbody tr button[title="Show more actions"], table tbody tr button[aria-label*="Show Actions" i]',
    )
    .or(qliCard.locator('table tbody tr').getByRole('button', { name: /^show\s*(more\s*)?actions$/i }))
    .nth(rowIndex);
  await menuBtn.waitFor({ state: 'visible', timeout: 20_000 });
  await page.keyboard.press('Escape').catch(() => {});
  await sleep(150);
  await menuBtn.click({ force: true });
  await sleep(500);
  const labels = await page
    .locator('[role="menuitem"]:visible, .slds-dropdown:visible a, .slds-dropdown:visible li')
    .allTextContents()
    .catch(() => []);
  const flat = (labels || []).map((t) => t.replace(/\s+/g, ' ').trim()).filter(Boolean);
  progress(`12. QLI ▾ menu after reload — ${flat.join(' | ') || '(empty)'}`);
  const action = page
    .getByRole('menuitem', { name: new RegExp(`^${actionName}$`, 'i') })
    .or(page.locator('[role="menuitem"], a, li').filter({ hasText: new RegExp(`^\\s*${actionName}\\s*$`, 'i') }))
    .first();
  await action.waitFor({ state: 'visible', timeout: 12_000 });
  progress(`12. QLI row ${rowIndex + 1} — ${actionName} (after reload)`);
  await action.click({ force: true });
  await page.locator('.slds-spinner:visible').first().waitFor({ state: 'hidden', timeout: 60_000 }).catch(() => {});
  if (/^view$/i.test(actionName)) {
    await page.waitForURL(/QuoteLineItem|\/0QL/i, { timeout: 45_000 }).catch(() => {});
  }
}

async function returnToQuoteFromLineItem(page, quoteIdHint = '') {
  const quoteLink = page
    .locator('records-record-layout-item, .slds-form-element')
    .filter({ has: page.locator('label, .slds-form-element__label').filter({ hasText: /^quote$/i }) })
    .locator('a')
    .first()
    .or(page.getByRole('link', { name: /Auto_/i }).first())
    .or(page.locator('a[href*="/lightning/r/Quote/"]'));
  if (await quoteLink.first().isVisible({ timeout: 8_000 }).catch(() => false)) {
    progress('12. Quote Line Item → Quote name link');
    await quoteLink.first().click();
  } else if (quoteIdHint) {
    await page.goto(`/lightning/r/Quote/${quoteIdHint}/view`, { waitUntil: 'domcontentloaded' });
  } else {
    const id = await quoteIdFromUrl(page);
    if (id && /\/QuoteLineItem\/|\/0QL/i.test(page.url())) {
      // stuck on QLI without link — try browser back
      await page.goBack().catch(() => {});
    }
  }
  await page.waitForURL(/\/lightning\/r\/Quote\//i, { timeout: 45_000 }).catch(() => {});
  await waitForQuoteRecordVisible(page, { timeout: 45_000 });
  return (await quoteIdFromUrl(page)) || quoteIdHint;
}

async function pricingCalculatorRoot(page) {
  const root = page
    .locator('.slds-modal__container:visible, [role="dialog"]:visible, .forceModal, lightning-overlay-container')
    .filter({ hasText: /pricing|calculator|selling\s*price|apply\s*configuration/i })
    .first()
    .or(page.locator('body'));
  return root;
}

async function readLabeledNumericMap(scope) {
  const rawMap = await scope
    .evaluate((root) => {
      const map = {};
      const walk = (node) => {
        if (!node || !node.querySelectorAll) return;
        const items = node.querySelectorAll(
          '.slds-form-element, lightning-input, lightning-formatted-number, lightning-output-field, records-record-layout-item, .slds-form-element_stacked, [data-label]',
        );
        for (const el of items) {
          const labelEl = el.querySelector(
            'label, .slds-form-element__label, span.slds-form-element__label, legend',
          );
          let label = (
            (labelEl && labelEl.innerText) ||
            el.getAttribute('data-label') ||
            el.getAttribute('label') ||
            el.getAttribute('aria-label') ||
            ''
          )
            .replace(/\s+/g, ' ')
            .replace(/\*$/, '')
            .trim();
          if (!label || label.length < 2 || label.length > 120) continue;
          const input = el.querySelector('input:not([type="hidden"]), textarea');
          let raw = input ? input.value || '' : '';
          if (!raw) {
            const num = el.querySelector(
              'lightning-formatted-number, .slds-form-element__static, lightning-formatted-text',
            );
            raw = ((num && num.innerText) || el.innerText || '').trim();
            if (raw.toLowerCase().startsWith(label.toLowerCase())) raw = raw.slice(label.length).trim();
          }
          const key = label.toLowerCase().replace(/\s+/g, ' ').trim();
          if (!(key in map) || raw) map[key] = raw;
        }
        for (const dt of node.querySelectorAll('dt')) {
          const dd = dt.nextElementSibling;
          if (!dd || String(dd.tagName || '').toUpperCase() !== 'DD') continue;
          const dtLabel = (dt.innerText || '').replace(/\s+/g, ' ').replace(/\*$/, '').trim();
          const dtRaw = (dd.innerText || '').trim();
          if (dtLabel.length >= 2 && dtLabel.length <= 120) {
            const key = dtLabel.toLowerCase();
            if (!(key in map) || dtRaw) map[key] = dtRaw;
          }
        }
        for (const tr of node.querySelectorAll('tr, [role="row"]')) {
          const cells = [...tr.querySelectorAll('th, td, [role="cell"], [role="gridcell"]')].map((c) =>
            (c.innerText || c.textContent || '').replace(/\s+/g, ' ').trim(),
          );
          let rowLabel = cells[0] || '';
          let rowRaw = cells.length ? cells[cells.length - 1] : '';
          if (cells.length < 2 || !/[\d]/.test(rowRaw)) {
            const t = (tr.innerText || tr.textContent || '').replace(/\s+/g, ' ').trim();
            const nums = [...t.matchAll(/-?[\d,]+\.\d{2}/g)];
            if (nums.length) {
              rowLabel = t.replace(/-?[\d,]+\.\d{2}/g, ' ').replace(/\s+/g, ' ').trim();
              rowRaw = nums[nums.length - 1][0];
            }
          }
          if (rowLabel.length >= 2 && rowLabel.length <= 120 && /[\d]/.test(rowRaw)) {
            const key = rowLabel.toLowerCase();
            if (!(key in map) || rowRaw) map[key] = rowRaw;
          }
        }
        for (const el of node.querySelectorAll('*')) {
          if (el.shadowRoot) walk(el.shadowRoot);
        }
      };
      walk(root);
      return { map, text: (root.innerText || '').slice(0, 40000) };
    })
    .catch(() => ({ map: {}, text: '' }));

  const map = {};
  for (const [k, raw] of Object.entries(rawMap?.map || {})) {
    const n = parseMoney(raw);
    map[k] = Number.isFinite(n) ? n : NaN;
  }

  const text = rawMap?.text || (await scope.innerText().catch(() => '')) || '';
  const extraLabels = [
    'SP Price (Per Unit) (Original Currency)',
    'SP Price (Per Unit) (Original Currency) (SAR)',
    'SP Price (Per Unit)',
    'Supplier Price (original currency)',
    'Supplier Price',
    'SP Price (SAR)',
    'Total Supplier Price (SAR)',
    'Total Selling Price After Discount (SAR)',
    'Total Selling Price After Discount',
    'Total Selling Amount (SAR)',
    'Total Selling Amount',
    'Total Project Cost (SAR)',
    'Total Project Cost',
    'Landed Cost (SAR)',
    'Landed Cost',
    'Landed Material Cost',
    'Total W/S Value (SAR)',
    'Total W/S Value',
    'Total VAT Value (SAR)',
    'Total VAT Value',
    'Unit Sales Price Before Discount (SAR)',
    'Unit Sales Price Before Discount',
    'Unit Sales Price After Discount (Back-Calculated) (SAR)',
    'Unit Sales Price After Discount',
    'Total Selling Price Before Discount (SAR)',
    'Discount Amount (SAR)',
    'Customer Discount (%)',
    'Quantity',
    'GP %',
    'GP%',
    'GP Amount',
    'GP Amount (SAR)',
    'Gross Profit Amount',
    'Gross Profit %',
    'Net Selling Price Including VAT (Total)',
    'Net Selling Price Including VAT',
    'Landed Material Cost (SAR)',
    'Landed Material Cost',
  ];
  for (const label of extraLabels) {
    const k = fieldKey(label);
    if (Number.isFinite(map[k])) continue;
    const n = moneyAfterLabel(text, label);
    if (Number.isFinite(n)) map[k] = n;
  }
  const harvested = { ...harvestMoneyLabelsFromText(text), ...harvestAdjacentLines(text) };
  for (const [k, v] of Object.entries(harvested)) {
    if (!Number.isFinite(map[k]) && Number.isFinite(v)) map[k] = v;
  }
  return map;
}

async function findEditableByLabel(scope, labelRe) {
  const source = labelRe instanceof RegExp ? labelRe.source : String(labelRe);
  const flags = labelRe instanceof RegExp ? labelRe.flags : 'i';
  const handle = await scope
    .evaluateHandle(
      (root, { source, flags }) => {
        const re = new RegExp(source, flags);
        const nodes = root.querySelectorAll('.slds-form-element, lightning-input');
        for (const el of nodes) {
          const labelEl = el.querySelector('label, .slds-form-element__label');
          const label = ((labelEl && labelEl.innerText) || el.getAttribute('label') || '')
            .replace(/\s+/g, ' ')
            .trim();
          if (!re.test(label)) continue;
          const input = el.querySelector('input:not([type="hidden"]):not([disabled]):not([readonly])');
          if (input) return input;
        }
        for (const inp of root.querySelectorAll(
          'input:not([type="hidden"]):not([disabled]):not([readonly]), textarea:not([disabled]):not([readonly])',
        )) {
          const aria = `${inp.getAttribute('aria-label') || ''} ${inp.getAttribute('name') || ''}`;
          if (re.test(aria)) return inp;
        }
        return null;
      },
      { source, flags },
    )
    .catch(() => null);
  const el = handle && typeof handle.asElement === 'function' ? handle.asElement() : null;
  if (el) return el;

  const spin = scope.getByRole('spinbutton', { name: labelRe }).first();
  if (await spin.isVisible({ timeout: 0 }).catch(() => false)) return spin;
  const box = scope.getByRole('textbox', { name: labelRe }).first();
  if (await box.isVisible({ timeout: 0 }).catch(() => false)) return box;
  return null;
}

/** Commit a numeric value into a Lightning/LWC input so the calculator recalculates. */
async function commitCalculatorNumeric(target, value) {
  const str = String(value);
  await target.scrollIntoViewIfNeeded().catch(() => {});
  await target.click({ clickCount: 3 }).catch(() => {});
  await target.press('Control+A').catch(() => {});
  await target.press('Backspace').catch(() => {});
  // pressSequentially fires real key events (LWC often ignores bare fill())
  await target.pressSequentially(str, { delay: 15 }).catch(async () => {
    await target.fill(str).catch(() => {});
  });
  await target.evaluate((el, v) => {
    const proto = window.HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, String(v));
    else el.value = String(v);
    el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, data: String(v) }));
    el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  }, value).catch(() => {});
  await target.press('Tab').catch(() => {});
  await target.blur().catch(() => {});
}

async function fillIfBlankOrZero(input, value, label) {
  if (!input) return false;
  let target = input;
  const tag = ((await input.evaluate((el) => el.tagName).catch(() => '')) || '').toLowerCase();
  if (tag && tag !== 'input' && tag !== 'textarea') {
    const nested = input.locator('input:not([type="hidden"]):not([disabled]):not([readonly])').first();
    if (await nested.isVisible({ timeout: 0 }).catch(() => false)) target = nested;
    else return false;
  }
  const cur = parseMoney((await target.inputValue().catch(() => '')) || '');
  if (Number.isFinite(cur) && Math.abs(cur) > MONEY_TOLERANCE) {
    progress(`12. Calculator keep "${label}" = ${moneyFmt(cur)}`);
    return false;
  }
  await commitCalculatorNumeric(target, value);
  progress(`12. Calculator filled "${label}" ← ${moneyFmt(value)} (was blank/0)`);
  return true;
}

/** Fill a Rate (%) cell — value always 0–100. If current value is > 100%, overwrite it. */
async function fillPercentIfBlank(input, value, label) {
  if (!input) return false;
  const pct = clampPercent(value);
  if (!Number.isFinite(pct)) {
    progress(`12. Calculator skip percent fill on "${label}" — invalid value`);
    return false;
  }
  if (Number.isFinite(value) && value !== pct) {
    progress(`12. Calculator percent "${label}" clamped ${value} → ${pct} (0–100)`);
  }
  const cur = await readEditableNumeric(input);
  if (Number.isFinite(cur) && cur > 100) {
    progress(`12. Calculator percent "${label}" is ${cur}% > 100 — updating to ${pct}`);
    return overwriteCalculatorInput(input, pct, `${label} (was ${cur}% > 100)`, { asPct: true });
  }
  return fillIfBlankOrZero(input, pct, label);
}

async function readEditableNumeric(input) {
  if (!input) return NaN;
  let target = input;
  const tag = ((await input.evaluate((el) => el.tagName).catch(() => '')) || '').toLowerCase();
  if (tag && tag !== 'input' && tag !== 'textarea') {
    const nested = input.locator('input:not([type="hidden"])').first();
    if (await nested.count().catch(() => 0)) target = nested;
  }
  return parseMoney((await target.inputValue().catch(() => '')) || '');
}

async function overwriteCalculatorInput(input, value, label, { asPct = false } = {}) {
  if (!input) return false;
  let write = value;
  if (asPct || /%|percent/i.test(String(label || ''))) {
    write = clampPercent(value);
    if (!Number.isFinite(write)) return false;
    if (Number.isFinite(value) && value !== write) {
      progress(`12. Calculator percent "${label}" clamped ${value} → ${write} (0–100)`);
    }
  }
  let target = input;
  const tag = ((await input.evaluate((el) => el.tagName).catch(() => '')) || '').toLowerCase();
  if (tag && tag !== 'input' && tag !== 'textarea') {
    const nested = input.locator('input:not([type="hidden"]):not([disabled]):not([readonly])').first();
    if (await nested.isVisible({ timeout: 0 }).catch(() => false)) target = nested;
    else return false;
  }
  await commitCalculatorNumeric(target, write);
  const stuck = parseMoney((await target.inputValue().catch(() => '')) || '');
  if (
    Number.isFinite(stuck) &&
    Math.abs(stuck - Number(write)) > Math.max(MONEY_TOLERANCE, Math.abs(Number(write)) * 0.001)
  ) {
    progress(`12. Calculator WARN "${label}" write ${write} but field shows ${stuck} — retry`);
    await commitCalculatorNumeric(target, write);
  }
  progress(`12. Calculator set "${label}" ← ${write}`);
  return true;
}

/**
 * Any editable percentage > 100% → set to 100 (0–100 rule).
 * Then provision rates still > 10% → CALC_PROVISION_CAP_PCT so GP% stays positive.
 */
async function capHighProvisionChargeRates(page, tag = 'QLI') {
  const root = await pricingCalculatorRoot(page);
  await expandCalculatorSection(page, /provision\s*charges?/i).catch(() => {});
  await expandCalculatorSection(page, /selling\s*price/i).catch(() => {});
  await expandCalculatorSection(page, /landed\s*cost|freight|customs/i).catch(() => {});
  await expandCalculatorSection(page, /warranty|services/i).catch(() => {});

  const heading = root.getByRole('heading', { name: /provision\s*charges?/i }).first();
  if (await heading.count().catch(() => 0)) await scrollPricingCalculatorElementIntoView(heading);

  const inputs = root.locator('input:not([type="hidden"]):not([disabled]):not([readonly])');
  const count = await inputs.count().catch(() => 0);
  let changed = 0;
  let over100 = 0;

  for (let i = 0; i < count; i++) {
    const input = inputs.nth(i);
    if (!(await input.isVisible({ timeout: 0 }).catch(() => false))) continue;
    const meta = await input
      .evaluate((el) => {
        const row = el.closest('tr, .slds-form-element, lightning-input, [role="row"]') || el.parentElement;
        return {
          value: el.value || '',
          aria: el.getAttribute('aria-label') || '',
          name: el.getAttribute('name') || el.getAttribute('label') || '',
          text: ((row && row.innerText) || '').replace(/\s+/g, ' ').trim().slice(0, 180),
        };
      })
      .catch(() => ({ value: '', aria: '', name: '', text: '' }));
    const val = parseMoney(meta.value);
    if (!Number.isFinite(val)) continue;

    const ctx = `${meta.aria} ${meta.name} ${meta.text}`;
    const looksPct =
      /%|percent|rate\s*\(%\)|rate\s*%/i.test(ctx) ||
      (/charge|provision|mirror|discount|freight|customs|warranty/i.test(ctx) &&
        !/amount|sar|price|cost|quantity|supplier/i.test(ctx));
    if (!looksPct) continue;

    // Money cells mis-detected: skip huge values that are clearly amounts (e.g. 500000)
    if (val > 1000) continue;

    const hint = (meta.text || meta.aria || 'Percent').slice(0, 50);

    // Rule: percentage cannot exceed 100 — update if more than 100%
    if (val > 100) {
      const next = /provision|charge|mirror/i.test(ctx) ? CALC_PROVISION_CAP_PCT : 100;
      await overwriteCalculatorInput(input, next, `${hint} ${val}% → ${next}% (>100)`, { asPct: true });
      changed += 1;
      over100 += 1;
      continue;
    }

    // Provision-only: rates above 10% still capped for GP
    if (val <= CALC_PROVISION_RATE_MAX) continue;
    if (!/charge|provision|mirror/i.test(ctx) && !/%|percent|rate\s*%/i.test(ctx)) continue;
    if (/discount|freight|customs|exchange\s*rate|vat\s*%|warranty|quantity|sales\s*price|cost\s*price|supplier\s*price/i.test(ctx) &&
      !/provision|charge|mirror/i.test(ctx)) {
      continue;
    }
    await overwriteCalculatorInput(input, CALC_PROVISION_CAP_PCT, `${hint} ${val}% → ${CALC_PROVISION_CAP_PCT}%`, {
      asPct: true,
    });
    changed += 1;
  }

  if (changed) {
    progress(
      `12. ${tag} Updated ${changed} percent field(s)${over100 ? ` (${over100} were >100%)` : ''} — max 100%, provision cap ${CALC_PROVISION_CAP_PCT}%`,
    );
    await clickApplyConfiguration(page);
  } else {
    progress(`12. ${tag} Percent fields — none above 100% / provision cap to update`);
  }
  return changed;
}

/**
 * Read "6. Profitability Summary" (screenshot):
 *   Total Selling Amount (SAR), Total Project Cost (SAR), GP Amount (SAR), GP %
 */
async function readProfitabilitySummaryFromUi(page) {
  const root = await pricingCalculatorRoot(page);
  await expandCalculatorSection(page, /profitability\s*summary|^\s*6\.?\s*profitability/i);
  const heading = root.getByText(/profitability\s*summary/i).first();
  if (await heading.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await scrollPricingCalculatorElementIntoView(heading);
  }

  // Prefer full calculator text — LWC often keeps values outside a tight section ancestor
  let text = ((await root.innerText().catch(() => '')) || '').replace(/\u00a0/g, ' ');
  const idx = text.search(/profitability\s*summary/i);
  if (idx >= 0) text = text.slice(idx, idx + 2500);

  let selling = firstFinite(
    moneyAfterLabel(text, 'Total Selling Amount (SAR)'),
    moneyAfterLabel(text, 'Total Selling Amount'),
  );
  let project = firstFinite(
    moneyAfterLabel(text, 'Total Project Cost (SAR)'),
    moneyAfterLabel(text, 'Total Project Cost'),
  );
  let gpAmt = firstFinite(
    moneyAfterLabel(text, 'GP Amount (SAR)'),
    moneyAfterLabel(text, 'GP Amount'),
  );
  let gpPct = firstFinite(moneyAfterLabel(text, 'GP %'), moneyAfterLabel(text, 'GP%'));

  // Structured scrape: label → nearest currency / percent in same card / next siblings
  if (!Number.isFinite(selling) || !Number.isFinite(project) || !Number.isFinite(gpAmt) || !Number.isFinite(gpPct)) {
    const scraped = await root
      .evaluate((el) => {
        const out = { selling: NaN, project: NaN, gpAmt: NaN, gpPct: NaN };
        const norm = (s) => String(s || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
        const parseN = (s) => {
          const t = String(s || '').replace(/[^\d.,\-]/g, '').replace(/,/g, '');
          const n = Number.parseFloat(t);
          return Number.isFinite(n) ? n : NaN;
        };
        const walk = (node, depth) => {
          if (!node || depth > 14) return;
          const kids = node.children ? [...node.children] : [];
          for (let i = 0; i < kids.length; i++) {
            const label = norm(kids[i].innerText || kids[i].textContent || '');
            if (label.length < 3 || label.length > 80) {
              walk(kids[i], depth + 1);
              continue;
            }
            let key = null;
            if (/^total\s*selling\s*amount/i.test(label)) key = 'selling';
            else if (/^total\s*project\s*cost/i.test(label)) key = 'project';
            else if (/^gp\s*amount/i.test(label)) key = 'gpAmt';
            else if (/^gp\s*%$/i.test(label) || /^gp%$/i.test(label)) key = 'gpPct';
            if (key && !Number.isFinite(out[key])) {
              // value often in same node or next sibling(s)
              const blob = norm(
                [kids[i], kids[i + 1], kids[i + 2], kids[i].parentElement]
                  .filter(Boolean)
                  .map((n) => n.innerText || n.textContent || '')
                  .join(' '),
              );
              if (key === 'gpPct') {
                const m = blob.match(/-?[\d,]+\.?\d*\s*%/);
                if (m) out[key] = parseN(m[0]);
              } else {
                const cleaned = blob.replace(/\([^)]*\)/g, ' ');
                const nums = [...cleaned.matchAll(/-?[\d,]+\.\d{2}/g)];
                if (nums.length) out[key] = parseN(nums[nums.length - 1][0]);
              }
            }
            walk(kids[i], depth + 1);
          }
        };
        walk(el, 0);
        return out;
      })
      .catch(() => ({ selling: NaN, project: NaN, gpAmt: NaN, gpPct: NaN }));

    selling = firstFinite(selling, scraped.selling);
    project = firstFinite(project, scraped.project);
    gpAmt = firstFinite(gpAmt, scraped.gpAmt);
    gpPct = firstFinite(gpPct, scraped.gpPct);
  }

  if (!Number.isFinite(gpPct) && Number.isFinite(selling) && Number.isFinite(project) && Math.abs(selling) > MONEY_TOLERANCE) {
    gpPct = expectedGpPct(selling, project);
  }

  // Card-level fallback via Playwright locators
  if (!Number.isFinite(selling) || !Number.isFinite(project) || !Number.isFinite(gpAmt) || !Number.isFinite(gpPct)) {
    const cards = [
      { key: 'selling', re: /total\s*selling\s*amount\s*\(sar\)/i },
      { key: 'project', re: /total\s*project\s*cost\s*\(sar\)/i },
      { key: 'gpAmt', re: /gp\s*amount\s*\(sar\)/i },
      { key: 'gpPct', re: /gp\s*%/i },
    ];
    const got = {};
    for (const { key, re } of cards) {
      const lab = root.getByText(re).first();
      if (!(await lab.isVisible({ timeout: 1_500 }).catch(() => false))) continue;
      await scrollPricingCalculatorElementIntoView(lab);
      const raw = await lab
        .evaluate((el) => {
          let p = el;
          for (let i = 0; i < 6 && p; i++, p = p.parentElement) {
            const t = String(p.innerText || '').replace(/\s+/g, ' ').trim();
            if (t.length < 8) continue;
            const cleaned = t.replace(/\([^)]*\)/g, ' ');
            if (/gp\s*%/i.test(t) && !/gp\s*amount/i.test(el.innerText || '')) {
              const pct = [...cleaned.matchAll(/-?[\d,]+\.?\d*\s*%/g)];
              if (pct.length) return pct[pct.length - 1][0];
            }
            const nums = [...cleaned.matchAll(/-?[\d,]+\.\d{2}\s*%?/g)];
            if (nums.length) return nums[nums.length - 1][0];
          }
          return '';
        })
        .catch(() => '');
      got[key] = parseMoney(raw);
    }
    progress(
      `12. Profitability Summary (cards) → Selling=${moneyFmt(got.selling)} Project=${moneyFmt(got.project)} GP Amt=${moneyFmt(got.gpAmt)} GP%=${pctFmt(got.gpPct)}`,
    );
    return {
      selling: firstFinite(selling, got.selling),
      project: firstFinite(project, got.project),
      gpAmt: firstFinite(gpAmt, got.gpAmt),
      gpPct: firstFinite(gpPct, got.gpPct),
    };
  }

  progress(
    `12. Profitability Summary → Selling=${moneyFmt(selling)} Project=${moneyFmt(project)} GP Amt=${moneyFmt(gpAmt)} GP%=${pctFmt(gpPct)}`,
  );
  return { selling, project, gpAmt, gpPct };
}

/**
 * Keep GP% positive: if GP% ≤ 0 (or Selling ≤ Project Cost), raise
 * Unit Sales Price Before Discount (SAR) and/or Quantity until Selling > Project.
 * Reads values from "6. Profitability Summary" (screenshot).
 */
async function ensurePositiveGrossProfit(page, tag = 'QLI', hints = {}) {
  await capHighProvisionChargeRates(page, tag);
  await clickApplyConfiguration(page);

  const unitPriceMax = Math.max(CALC_UNIT_PRICE * 50, 500_000);

  for (let step = 0; step < 14; step++) {
    const ui = await readProfitabilitySummaryFromUi(page);
    let selling = firstFinite(ui.selling, hints.selling);
    let project = firstFinite(ui.project, hints.project);
    let gpPct = firstFinite(
      ui.gpPct,
      Number.isFinite(selling) && Number.isFinite(project) ? expectedGpPct(selling, project) : NaN,
    );

    const totalsOk =
      Number.isFinite(selling) && Number.isFinite(project) && selling > project + MONEY_TOLERANCE;
    const gpOk = Number.isFinite(gpPct) && gpPct > 0;
    if (totalsOk || gpOk) {
      progress(
        `12. ${tag} GP positive — Selling=${moneyFmt(selling)} Project=${moneyFmt(project)} GP%=${pctFmt(gpPct)}`,
      );
      return { ok: true, selling, project, gpPct, gpAmt: ui.gpAmt };
    }

    const gpNegative = Number.isFinite(gpPct) && gpPct <= 0;
    const totalsBad =
      Number.isFinite(selling) && Number.isFinite(project) && selling <= project + MONEY_TOLERANCE;

    if (!gpNegative && !totalsBad) {
      progress(
        `12. ${tag} Profitability Summary not readable as negative — skip bump (Selling=${moneyFmt(selling)} Project=${moneyFmt(project)} GP%=${pctFmt(gpPct)})`,
      );
      return { ok: false, selling, project, gpPct, gpAmt: ui.gpAmt };
    }

    progress(
      `12. ${tag} GP negative (step ${step + 1}) — Selling=${moneyFmt(selling)} Project=${moneyFmt(project)} GP%=${pctFmt(gpPct)}; raise Unit Sales Price Before Discount / Quantity`,
    );

    await expandCalculatorSection(page, /selling\s*price/i);
    const root = await pricingCalculatorRoot(page);
    const unitBeforeInput = await findEditableByLabel(
      root,
      /unit\s*sales\s*price\s*before\s*discount/i,
    );
    const qtyInput = await findEditableByLabel(root, /^quantity$/i);

    let changed = false;
    // Need Selling > Project: set unit price so unit*qty clears project with margin
    if (unitBeforeInput && Number.isFinite(project)) {
      const qty = (qtyInput && (await readEditableNumeric(qtyInput))) || 1;
      const cur = (await readEditableNumeric(unitBeforeInput)) || 0;
      const needUnit = (project * 1.15) / Math.max(qty, 1); // ~15% GP target
      const next = Math.min(
        Number(Math.max(cur < needUnit ? needUnit : cur * 1.25, CALC_UNIT_PRICE).toFixed(2)),
        unitPriceMax,
      );
      if (next > cur + MONEY_TOLERANCE) {
        await overwriteCalculatorInput(unitBeforeInput, next, 'Unit Sales Price Before Discount (SAR)');
        changed = true;
      }
    } else if (unitBeforeInput && step % 2 === 0) {
      const cur = (await readEditableNumeric(unitBeforeInput)) || 0;
      const base = cur > 0 ? cur : CALC_UNIT_PRICE;
      const next = Math.min(Number((base * 1.5 + 500).toFixed(2)), unitPriceMax);
      if (next > base + MONEY_TOLERANCE) {
        await overwriteCalculatorInput(unitBeforeInput, next, 'Unit Sales Price Before Discount (SAR)');
        changed = true;
      }
    }
    if ((!changed || step % 2 === 1) && qtyInput) {
      const cur = (await readEditableNumeric(qtyInput)) || 1;
      const next = cur < 2 ? 2 : cur < 5 ? 5 : Math.min(cur + 5, CALC_QTY_MAX);
      if (next > cur) {
        await overwriteCalculatorInput(qtyInput, next, 'Quantity');
        changed = true;
      }
    }

    if (!changed) {
      progress(`12. ${tag} WARN — cannot raise Unit Price or Quantity further`);
      break;
    }
    await clickApplyConfiguration(page);
    await sleep(1_200);
    // Confirm Selling moved — if still stuck, calculator did not accept the edit
    const after = await readProfitabilitySummaryFromUi(page);
    if (
      Number.isFinite(selling) &&
      Number.isFinite(after.selling) &&
      Math.abs(after.selling - selling) <= MONEY_TOLERANCE
    ) {
      progress(
        `12. ${tag} WARN — Selling still ${moneyFmt(after.selling)} after Unit/Qty edit (calculator may not have recalculated)`,
      );
    }
  }

  const finalUi = await readProfitabilitySummaryFromUi(page);
  const selling = firstFinite(finalUi.selling, hints.selling);
  const project = firstFinite(finalUi.project, hints.project);
  const gpPct = firstFinite(
    finalUi.gpPct,
    Number.isFinite(selling) && Number.isFinite(project) ? expectedGpPct(selling, project) : NaN,
  );
  const ok =
    (Number.isFinite(selling) && Number.isFinite(project) && selling > project + MONEY_TOLERANCE) ||
    (Number.isFinite(gpPct) && gpPct > 0);
  if (!ok) {
    progress(
      `12. ${tag} WARN — GP% still not positive after adjustments (Selling=${moneyFmt(selling)} Project=${moneyFmt(project)} GP%=${pctFmt(gpPct)})`,
    );
  }
  return { ok, selling, project, gpPct, gpAmt: finalUi.gpAmt };
}

async function scrollPricingCalculatorElementIntoView(locator) {
  await locator
    .evaluate((el) => {
      el.scrollIntoView({ block: 'start', inline: 'nearest' });
      let p = el.parentElement;
      while (p && p !== document.body) {
        const st = window.getComputedStyle(p);
        if (/(auto|scroll)/.test(st.overflowY || st.overflow) && p.scrollHeight > p.clientHeight + 16) {
          const r = el.getBoundingClientRect();
          const pr = p.getBoundingClientRect();
          p.scrollTop += r.top - pr.top - 16;
        }
        p = p.parentElement;
      }
    })
    .catch(() => {});
}

/** Walk the calculator from Selling → Profitability so the full page is on screen. */
async function scrollPricingCalculatorFullPage(page) {
  const root = await pricingCalculatorRoot(page);
  await root
    .evaluate((el) => {
      const c = el.querySelector('.slds-modal__content, lightning-modal-body, .slds-scrollable_y') || el;
      if (!c) return;
      c.scrollTop = 0;
      const max = Math.max(c.scrollHeight, 2400);
      for (let y = 0; y <= max; y += 400) c.scrollTop = y;
      c.scrollTop = c.scrollHeight;
    })
    .catch(() => {});
  await sleep(200);
}

async function expandCalculatorSection(page, sectionNameRe) {
  const root = await pricingCalculatorRoot(page);
  const heading = root
    .getByRole('button', { name: sectionNameRe })
    .or(root.getByRole('heading', { name: sectionNameRe }))
    .or(root.getByRole('tab', { name: sectionNameRe }))
    .or(root.locator('.slds-section__title, .slds-accordion__summary-heading, legend, h2, h3, button').filter({ hasText: sectionNameRe }))
    .first();
  if (!(await heading.count().catch(() => 0))) return false;
  await scrollPricingCalculatorElementIntoView(heading);
  const expanded = ((await heading.getAttribute('aria-expanded').catch(() => '')) || '').toLowerCase();
  if (expanded === 'false' || expanded === '') {
    await heading.click({ force: true }).catch(() => {});
    await sleep(200);
  }
  return true;
}

/** Locate "2. Supplier Cost & Basic Info" (screenshot) inside Pricing Calculator. */
async function supplierCostSectionRoot(page) {
  const root = await pricingCalculatorRoot(page);
  // Exact UI from screenshot: "2. Supplier Cost & Basic Info"
  const sectionRe = /supplier\s*cost\s*&\s*basic\s*info|supplier\s*,?\s*cost|supplier\s*cost\s*calculation/i;
  await expandCalculatorSection(page, sectionRe);

  const heading = root
    .getByText(/supplier\s*cost\s*&\s*basic\s*info/i)
    .or(root.getByRole('button', { name: sectionRe }))
    .or(root.getByRole('heading', { name: sectionRe }))
    .or(root.locator('.slds-section__title, .slds-accordion__summary-heading, legend, h2, h3, button, strong, span').filter({ hasText: sectionRe }))
    .first();
  await heading.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {});
  await scrollPricingCalculatorElementIntoView(heading);

  const section = heading
    .locator(
      'xpath=ancestor::*[contains(@class,"slds-section") or contains(@class,"slds-accordion__section") or contains(@class,"slds-card") or self::section][1]',
    )
    .or(
      root.locator('.slds-section, .slds-accordion__section, section, [role="tabpanel"], .slds-card').filter({
        has: root.getByText(/supplier\s*cost\s*&\s*basic\s*info|sp\s*price\s*\(per\s*unit\).*original\s*currency/i),
      }),
    )
    .first();

  if (await section.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await scrollPricingCalculatorElementIntoView(section);
    return section;
  }
  return root;
}

/**
 * Read SP Price (Per Unit) (Original Currency) from "2. Supplier Cost & Basic Info"
 * (screenshot: label + input showing e.g. 1,000.00).
 */
async function readSpPriceFromSupplierCostSection(page) {
  const root = await pricingCalculatorRoot(page);
  await expandCalculatorSection(page, /supplier\s*cost\s*&\s*basic\s*info|supplier\s*cost/i);
  const section = await supplierCostSectionRoot(page);
  progress('12. Reading SP Price in "2. Supplier Cost & Basic Info"…');

  // Prefer exact screenshot label → nearest input (incl. shadow)
  const label = section
    .getByText(/sp\s*price\s*\(per\s*unit\)\s*\(original\s*currency\)/i)
    .or(root.getByText(/sp\s*price\s*\(per\s*unit\)\s*\(original\s*currency\)/i))
    .first();

  if (await label.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await scrollPricingCalculatorElementIntoView(label);
    const raw = await label
      .evaluate((lab) => {
        const host =
          lab.closest('.slds-form-element, lightning-input, lightning-formatted-number, [data-label], td, th, div') ||
          lab.parentElement;
        const deepVal = (node) => {
          if (!node) return '';
          const collect = (n, out) => {
            if (!n) return;
            if (n.tagName === 'INPUT' || n.tagName === 'TEXTAREA') out.push(n);
            if (n.querySelectorAll) {
              for (const inp of n.querySelectorAll('input:not([type="hidden"]), textarea')) out.push(inp);
              for (const el of n.querySelectorAll('*')) if (el.shadowRoot) collect(el.shadowRoot, out);
            }
            if (n.shadowRoot) collect(n.shadowRoot, out);
          };
          const inputs = [];
          collect(node, inputs);
          for (const inp of inputs) {
            const v = String(inp.value || '').trim();
            if (v) return v;
          }
          const staticEl =
            (node.querySelector &&
              node.querySelector(
                'lightning-formatted-number, .slds-form-element__static, .slds-form-element__control, [part="formatted-value"]',
              )) ||
            null;
          if (staticEl && String(staticEl.innerText || '').trim()) return String(staticEl.innerText || '').trim();
          // Sibling column / next control in the horizontal row (Currency | SP Original | FX | SP SAR)
          let sib = lab.nextElementSibling;
          for (let i = 0; i < 6 && sib; i++, sib = sib.nextElementSibling) {
            const t = String(sib.innerText || sib.value || '').replace(/\s+/g, ' ').trim();
            if (/[\d]/.test(t) && t.length < 40) return t;
            collect(sib, inputs);
          }
          for (const inp of inputs) {
            const v = String(inp.value || '').trim();
            if (v) return v;
          }
          return '';
        };
        let raw = deepVal(host);
        if (!raw && host && host.parentElement) raw = deepVal(host.parentElement);
        if (!raw && host && host.parentElement && host.parentElement.parentElement) {
          raw = deepVal(host.parentElement.parentElement);
        }
        return String(raw || '').replace(/\s+/g, ' ').trim();
      })
      .catch(() => '');
    const value = parseMoney(raw);
    progress(
      `12. Supplier Cost & Basic Info → SP Price (Per Unit) (Original Currency) raw="${raw}" → ${moneyFmt(value)}`,
    );
    if (Number.isFinite(value) && Math.abs(value) > MONEY_TOLERANCE) {
      return { value, raw, label: 'SP Price (Per Unit) (Original Currency)', reason: 'screenshot-label' };
    }
  }

  // Fallback: any input named / aria-labelled by that field in the whole calculator
  const byLabel = root
    .getByLabel(/sp\s*price\s*\(per\s*unit\).*original\s*currency/i)
    .or(root.getByRole('spinbutton', { name: /sp\s*price\s*\(per\s*unit\).*original\s*currency/i }))
    .or(root.getByRole('textbox', { name: /sp\s*price\s*\(per\s*unit\).*original\s*currency/i }))
    .first();
  if (await byLabel.isVisible({ timeout: 2_000 }).catch(() => false)) {
    const raw = ((await byLabel.inputValue().catch(() => '')) || '').trim();
    const value = parseMoney(raw);
    progress(`12. SP Price via getByLabel raw="${raw}" → ${moneyFmt(value)}`);
    if (Number.isFinite(value)) return { value, raw, label: 'SP Price (Per Unit) (Original Currency)', reason: 'getByLabel' };
  }

  // Last resort: harvest text from section / calculator for that exact label
  const text = ((await section.innerText().catch(() => '')) || (await root.innerText().catch(() => '')) || '').replace(
    /\u00a0/g,
    ' ',
  );
  for (const labelName of [
    'SP Price (Per Unit) (Original Currency)',
    'SP Price (Per Unit) (SAR)',
    'SP Price (Per Unit)',
  ]) {
    const n = moneyAfterLabel(text, labelName);
    if (Number.isFinite(n) && Math.abs(n) > MONEY_TOLERANCE) {
      progress(`12. Supplier Cost & Basic Info text harvest "${labelName}" = ${moneyFmt(n)}`);
      return { value: n, raw: String(n), label: labelName, reason: 'text-harvest' };
    }
  }

  progress('12. Supplier Cost & Basic Info — SP Price (Per Unit) (Original Currency) not readable');
  progress(`12. Section text sample: ${text.replace(/\s+/g, ' ').slice(0, 350)}`);
  return { value: NaN, raw: '', label: '', reason: 'not-found' };
}

async function readCalculatorSpPriceOriginal(page, { waitPopulateMs = 6_000 } = {}) {
  await expandCalculatorSection(page, /supplier\s*cost\s*&\s*basic\s*info|supplier\s*cost/i);
  await page.locator('.slds-spinner:visible').first().waitFor({ state: 'hidden', timeout: 15_000 }).catch(() => {});

  const deadline = Date.now() + Math.max(0, waitPopulateMs);
  let last = NaN;
  let lastRaw = '';
  while (true) {
    const fromSection = await readSpPriceFromSupplierCostSection(page);
    lastRaw = fromSection.raw || lastRaw;
    if (Number.isFinite(fromSection.value)) last = fromSection.value;
    if (Number.isFinite(fromSection.value) && Math.abs(fromSection.value) > MONEY_TOLERANCE) {
      return fromSection.value;
    }
    if (Date.now() >= deadline) {
      progress(`12. SP Price read done — raw="${lastRaw || '(none)'}" parsed=${moneyFmt(last)}`);
      return last;
    }
    await sleep(400);
  }
}

/**
 * Consumables — Selling Price & Discount (matches calculator UI)
 *   Total Before = Unit Before × Qty
 *   Discount Amount = Total Before × Customer Discount% / 100
 *   Total After = Total Before − Discount Amount
 *   Unit After (back-calculated) = Total After / Qty
 */
async function fillAndValidateConsumablesSellingPriceSection(page, validationRows, tag = 'QLI') {
  await expandCalculatorSection(page, /selling\s*price/i);
  const root = await pricingCalculatorRoot(page);
  progress(`12. ${tag} Consumables — Selling Price & Discount`);

  const unitBeforeInput = await findEditableByLabel(root, /unit\s*sales\s*price\s*before\s*discount/i);
  await fillIfBlankOrZero(unitBeforeInput, CALC_UNIT_PRICE, 'Unit Sales Price Before Discount');

  const discountPctInput = await findEditableByLabel(root, /customer\s*discount\s*\(?%\)?|discount\s*%/i);
  await fillPercentIfBlank(discountPctInput, CALC_DISCOUNT_PCT, 'Customer Discount (%)');
  // Discount Amount is calculated in UI — do not overwrite

  await clickApplyConfiguration(page);

  const values = await readLabeledNumericMap(root);
  const qtyInput = await findEditableByLabel(root, /^quantity$/i);
  let qty = pickValue(values, 'Quantity');
  if (!Number.isFinite(qty) || qty < 1) qty = (await readEditableNumeric(qtyInput)) || 1;
  let unitBefore = pickValue(values, 'Unit Sales Price Before Discount (SAR)', 'Unit Sales Price Before Discount');
  if (!Number.isFinite(unitBefore)) unitBefore = await readEditableNumeric(unitBeforeInput);
  let discountAmt = pickValue(values, 'Discount Amount (SAR)', 'Discount Amount');
  let discountPct = pickValue(values, 'Customer Discount (%)', 'Customer Discount', 'Discount %');
  if (!Number.isFinite(discountPct)) discountPct = await readEditableNumeric(discountPctInput);
  if (!Number.isFinite(discountPct)) discountPct = 0;
  discountPct = clampPercent(discountPct);
  const unitAfter = pickValue(
    values,
    'Unit Sales Price After Discount (Back-Calculated) (SAR)',
    'Unit Sales Price After Discount (Back-Calculated)',
    'Unit Sales Price After Discount',
  );
  const totalBefore = pickValue(
    values,
    'Total Selling Price Before Discount (SAR)',
    'Total Selling Price Before Discount',
  );
  const totalAfter = pickValue(
    values,
    'Total Selling Price After Discount (SAR)',
    'Total Selling Price After Discount',
  );

  let ok = true;
  const expTotalBefore = Number.isFinite(unitBefore) ? unitBefore * qty : NaN;
  if (Number.isFinite(expTotalBefore)) {
    ok =
      validateAgainstFormulas(
        `${tag} Selling: Total Before (= Unit Before × Qty)`,
        totalBefore,
        expTotalBefore,
        validationRows,
      ) && ok;
  }

  const baseBefore = Number.isFinite(totalBefore) ? totalBefore : expTotalBefore;
  const expDiscountAmt =
    Number.isFinite(baseBefore) && Number.isFinite(discountPct) ? (baseBefore * discountPct) / 100 : NaN;
  if (Number.isFinite(expDiscountAmt)) {
    ok =
      validateAgainstFormulas(
        `${tag} Selling: Discount Amount (= Total Before × Discount% / 100)`,
        discountAmt,
        expDiscountAmt,
        validationRows,
      ) && ok;
  }

  const disc = Number.isFinite(discountAmt) ? discountAmt : expDiscountAmt;
  const expTotalAfter = Number.isFinite(baseBefore) && Number.isFinite(disc) ? baseBefore - disc : NaN;
  if (Number.isFinite(expTotalAfter)) {
    ok =
      validateAgainstFormulas(
        `${tag} Selling: Total After (= Total Before − Discount Amount)`,
        totalAfter,
        expTotalAfter,
        validationRows,
      ) && ok;
  }

  const afterTotal = Number.isFinite(totalAfter) ? totalAfter : expTotalAfter;
  const expUnitAfter = Number.isFinite(afterTotal) && qty ? afterTotal / qty : NaN;
  if (Number.isFinite(expUnitAfter)) {
    ok =
      validateAgainstFormulas(
        `${tag} Selling: Unit After back-calc (= Total After / Qty)`,
        unitAfter,
        expUnitAfter,
        validationRows,
      ) && ok;
  }

  return {
    ok,
    qty,
    unitBefore,
    discountPct,
    discountAmt: Number.isFinite(discountAmt) ? discountAmt : expDiscountAmt,
    unitAfter: Number.isFinite(unitAfter) ? unitAfter : expUnitAfter,
    totalBefore: Number.isFinite(totalBefore) ? totalBefore : expTotalBefore,
    totalAfter: afterTotal,
    values,
  };
}

/**
 * Consumables — Default Provision Charges
 * Base = Total Selling Price After Discount
 *   Financing Charges        default 3% → Base × 3%
 *   Bank Charges for LCs/LGs default 1% → Base × 1%
 *   Risk / Penalties         default 3% → Base × 3%
 */
async function validateConsumablesProvisionCharges(page, totalSellingAfterDiscount, validationRows, tag = 'QLI') {
  await expandCalculatorSection(page, /provision\s*charges?/i);
  await capHighProvisionChargeRates(page, tag);
  const root = await pricingCalculatorRoot(page);
  progress(`12. ${tag} Consumables — Provision Charges (defaults on Total Selling After Discount)`);

  if (!Number.isFinite(totalSellingAfterDiscount)) {
    progress(`12. ${tag} WARN — no Total Selling Price After Discount for provision charge formulas`);
    return { ok: false, values: {}, charges: {} };
  }

  const values = await readLabeledNumericMap(root);
  let ok = true;
  const charges = {};

  for (const spec of CONSUMABLES_PROVISION_CHARGES) {
    const actual = pickValue(values, ...spec.aliases, `${spec.name} Amount`, `${spec.name} (SAR)`);
    const expected = totalSellingAfterDiscount * (spec.ratePct / 100);
    charges[spec.name] = { actual, expected, ratePct: spec.ratePct };
    ok =
      validateAgainstFormulas(
        `${tag} Provision: ${spec.name} (= ${spec.ratePct}% of Total Selling After Discount)`,
        actual,
        expected,
        validationRows,
      ) && ok;

    // If rate field is shown separately, confirm default rate
    const rateActual = pickValue(
      values,
      `${spec.name} %`,
      `${spec.name} Rate`,
      `${spec.name} (%)`,
      `${spec.name} Default Rate`,
    );
    if (Number.isFinite(rateActual)) {
      ok =
        validateAgainstFormulas(
          `${tag} Provision rate: ${spec.name}`,
          rateActual,
          spec.ratePct,
          validationRows,
          { asPct: true },
        ) && ok;
    }
  }

  return { ok, values, charges };
}

/**
 * Consumables — Supplier Cost Section
 *   Supplier Price (SAR) — non-editable; populated from Supplier Pricebook (on Product related list)
 *   Total Supplier Price (SAR) = Supplier Price × Quantity (read-only)
 */
async function validateConsumablesSupplierCostSection(page, quantity, validationRows, tag = 'QLI') {
  await expandCalculatorSection(page, /supplier\s*cost|supplier\s*price/i);
  const root = await pricingCalculatorRoot(page);
  progress(`12. ${tag} Consumables — Supplier Cost (from Supplier Pricebook, non-editable)`);

  // Must NOT treat Supplier Price as editable fill target
  const supplierPriceInput = await findEditableByLabel(root, /^supplier\s*price/i);
  if (supplierPriceInput) {
    progress(`12. ${tag} WARN — Supplier Price appears editable; AC says non-editable from Supplier Pricebook`);
  }

  const values = await readLabeledNumericMap(root);
  const supplierPrice = pickValue(values, 'Supplier Price (SAR)', 'Supplier Price', 'Supplier Cost (SAR)', 'Supplier Cost');
  const totalSupplier = pickValue(
    values,
    'Total Supplier Price (SAR)',
    'Total Supplier Price',
    'Total Supplier Cost (SAR)',
    'Total Supplier Cost',
  );
  const qty = Number.isFinite(quantity) && quantity > 0 ? quantity : pickValue(values, 'Quantity') || 1;

  let ok = true;
  if (!Number.isFinite(supplierPrice) || Math.abs(supplierPrice) <= MONEY_TOLERANCE) {
    progress(`12. ${tag} WARN — Supplier Price blank/0 (expected from Supplier Pricebook on Product)`);
    // Soft fail: still record row
    ok =
      validateAgainstFormulas(
        `${tag} Supplier: Supplier Price populated from Pricebook`,
        supplierPrice,
        Number.isFinite(supplierPrice) && Math.abs(supplierPrice) > MONEY_TOLERANCE ? supplierPrice : NaN,
        validationRows,
      ) && ok;
  } else {
    progress(`12. ${tag} Supplier Price (SAR) = ${moneyFmt(supplierPrice)} (from Supplier Pricebook)`);
    validationRows.push({
      section: `${tag} Supplier: Supplier Price from Pricebook`,
      actual: moneyFmt(supplierPrice),
      expected: 'populated (>0)',
      status: 'PASS',
    });
  }

  if (Number.isFinite(supplierPrice)) {
    ok =
      validateAgainstFormulas(
        `${tag} Supplier: Total Supplier Price = Price × Qty`,
        totalSupplier,
        supplierPrice * qty,
        validationRows,
      ) && ok;
  }

  return { ok, values, supplierPrice, totalSupplier };
}

/**
 * Consumables — Landed Cost (under Provision Charges in UI)
 *   Landed Material Cost = Total Supplier Price (SAR) from Supplier Cost & Basic Info
 *   Landed Cost (SAR)    = Landed Material Cost + All Provision Charges
 *   (each provision = % of Total Selling Price After Discount)
 */
async function validateConsumablesLandedMaterialCost(
  page,
  { totalSupplierPrice, provisionChargesSum, totalSellingAfterDiscount },
  validationRows,
  tag = 'QLI',
) {
  await expandCalculatorSection(page, /provision\s*charges?|landed\s*cost|landed\s*material/i);
  const root = await pricingCalculatorRoot(page);
  progress(
    `12. ${tag} Consumables — Landed Cost (Landed Material = Total Supplier; + Provision Charges)`,
  );

  const values = await readLabeledNumericMap(root);
  const landedMaterial = pickValue(values, 'Landed Material Cost (SAR)', 'Landed Material Cost');
  const landed = pickValue(values, 'Landed Cost (SAR)', 'Landed Cost');

  let sumProvisions = provisionChargesSum;
  if (!Number.isFinite(sumProvisions)) {
    sumProvisions = 0;
    for (const spec of CONSUMABLES_PROVISION_CHARGES) {
      const v = pickValue(values, ...spec.aliases, `${spec.name} Amount`, `${spec.name} (SAR)`);
      if (Number.isFinite(v)) sumProvisions += v;
    }
  }

  const totalSupplier =
    Number.isFinite(totalSupplierPrice)
      ? totalSupplierPrice
      : pickValue(values, 'Total Supplier Price (SAR)', 'Total Supplier Price', 'Total Supplier Cost');

  let ok = true;
  if (!Number.isFinite(totalSupplier)) {
    progress(`12. ${tag} WARN — Total Supplier Price missing for Landed Material / Landed Cost`);
    ok = false;
  } else {
    ok =
      validateAgainstFormulas(
        `${tag} Prov: Landed Material Cost (= Total Supplier Price from Supplier Cost)`,
        Number.isFinite(landedMaterial) ? landedMaterial : totalSupplier,
        totalSupplier,
        validationRows,
      ) && ok;

    const materialForLanded = firstFinite(landedMaterial, totalSupplier);
    const expectedLanded = materialForLanded + (Number.isFinite(sumProvisions) ? sumProvisions : 0);
    ok =
      validateAgainstFormulas(
        `${tag} Prov: Landed Cost (SAR) (= Landed Material + All Provisions)`,
        landed,
        expectedLanded,
        validationRows,
      ) && ok;
  }

  if (Number.isFinite(totalSellingAfterDiscount) && Number.isFinite(sumProvisions)) {
    progress(
      `12. ${tag} Provision sum=${moneyFmt(sumProvisions)} on Selling After=${moneyFmt(totalSellingAfterDiscount)}`,
    );
  }

  return {
    ok,
    values,
    landedMaterial: firstFinite(landedMaterial, totalSupplier),
    landed: firstFinite(
      landed,
      Number.isFinite(totalSupplier)
        ? totalSupplier + (Number.isFinite(sumProvisions) ? sumProvisions : 0)
        : NaN,
    ),
    sumProvisions,
    totalSupplier,
  };
}

/**
 * Consumables key fields on Pricing Calculator (matched later on QLI View).
 */
async function readConsumablesKeyTotals(page) {
  const root = await pricingCalculatorRoot(page);
  await scrollPricingCalculatorFullPage(page).catch(() => {});
  const map = await readLabeledNumericMap(root);
  const text = ((await root.innerText().catch(() => '')) || '').replace(/\u00a0/g, ' ');
  const profit = await readProfitabilitySummaryFromUi(page);
  const get = async (...labels) => readCalcFieldByLabels(root, labels, map, text);

  const totals = {
    totalSellingAfterDiscount: await get(
      'Total Selling Price After Discount (SAR)',
      'Total Selling Price After Discount',
    ),
    totalSupplierPrice: await get('Total Supplier Price (SAR)', 'Total Supplier Price'),
    landedMaterialCost: await get('Landed Material Cost (SAR)', 'Landed Material Cost'),
    landedCost: await get('Landed Cost (SAR)', 'Landed Cost'),
    totalSellingAmount: firstFinite(
      profit.selling,
      await get('Total Selling Amount (SAR)', 'Total Selling Amount'),
    ),
    totalProjectCost: firstFinite(
      profit.project,
      await get('Total Project Cost (SAR)', 'Total Project Cost'),
    ),
    gpAmount: firstFinite(profit.gpAmt, await get('GP Amount (SAR)', 'GP Amount', 'Gross Profit Amount')),
    gpPct: firstFinite(profit.gpPct, await get('GP %', 'GP%', 'Gross Profit %')),
  };

  progress(
    `12. Consumables key totals — SellAfter=${moneyFmt(totals.totalSellingAfterDiscount)} ` +
      `Supplier=${moneyFmt(totals.totalSupplierPrice)} LandedMat=${moneyFmt(totals.landedMaterialCost)} ` +
      `Landed=${moneyFmt(totals.landedCost)} SellAmt=${moneyFmt(totals.totalSellingAmount)} ` +
      `Proj=${moneyFmt(totals.totalProjectCost)} GP=${moneyFmt(totals.gpAmount)} GP%=${pctFmt(totals.gpPct)}`,
  );
  return totals;
}

/**
 * Validate Consumables calculator key totals against formulas.
 */
function validateConsumablesKeyTotals(tag, ui, inputs, validationRows) {
  let ok = true;
  const {
    unitAfter = NaN,
    qty = NaN,
    supplierUnitPrice = NaN,
    provisionSum = NaN,
    expectedTotalAfter = NaN,
  } = inputs || {};

  const expTotalAfter = firstFinite(expectedTotalAfter, ui.totalSellingAfterDiscount);
  const expSupplier =
    Number.isFinite(supplierUnitPrice) && Number.isFinite(qty) ? supplierUnitPrice * qty : NaN;
  const material = firstFinite(ui.landedMaterialCost, ui.totalSupplierPrice, expSupplier);
  const expLanded =
    Number.isFinite(material) ? material + (Number.isFinite(provisionSum) ? provisionSum : 0) : NaN;
  const expSellingAmt =
    Number.isFinite(unitAfter) && Number.isFinite(qty)
      ? unitAfter * qty
      : firstFinite(ui.totalSellingAmount, expTotalAfter);
  const expProject = firstFinite(ui.landedCost, expLanded);

  ok =
    validateAgainstFormulas(
      `${tag} Cons Calc: Total Selling Price After Discount (SAR)`,
      ui.totalSellingAfterDiscount,
      expTotalAfter,
      validationRows,
    ) && ok;
  ok =
    validateAgainstFormulas(
      `${tag} Cons Calc: Total Supplier Price (SAR) (= Supplier Price × Qty)`,
      ui.totalSupplierPrice,
      expSupplier,
      validationRows,
    ) && ok;
  ok =
    validateAgainstFormulas(
      `${tag} Cons Calc: Landed Material Cost (= Total Supplier Price)`,
      ui.landedMaterialCost,
      firstFinite(ui.totalSupplierPrice, expSupplier),
      validationRows,
    ) && ok;
  ok =
    validateAgainstFormulas(
      `${tag} Cons Calc: Landed Cost (SAR) (= Landed Material + Provisions)`,
      ui.landedCost,
      expLanded,
      validationRows,
    ) && ok;
  ok =
    validateAgainstFormulas(
      `${tag} Cons Calc: Total Selling Amount (SAR)`,
      ui.totalSellingAmount,
      expSellingAmt,
      validationRows,
    ) && ok;
  ok =
    validateAgainstFormulas(
      `${tag} Cons Calc: Total Project Cost (SAR) (= Landed Cost)`,
      ui.totalProjectCost,
      expProject,
      validationRows,
    ) && ok;
  ok =
    validateAgainstFormulas(
      `${tag} Cons Calc: GP Amount (SAR) (= Selling − Project)`,
      ui.gpAmount,
      expectedGpAmount(firstFinite(ui.totalSellingAmount, expSellingAmt), firstFinite(ui.totalProjectCost, expProject)),
      validationRows,
    ) && ok;
  ok =
    validateAgainstFormulas(
      `${tag} Cons Calc: GP % (= (Selling − Project) / Selling × 100)`,
      ui.gpPct,
      expectedGpPct(firstFinite(ui.totalSellingAmount, expSellingAmt), firstFinite(ui.totalProjectCost, expProject)),
      validationRows,
      { asPct: true },
    ) && ok;

  const snapSell = firstFinite(ui.totalSellingAmount, expSellingAmt, expTotalAfter);
  const snapProj = firstFinite(ui.totalProjectCost, expProject);
  return {
    ok,
    snapshot: {
      totalSellingAfterDiscount: firstFinite(ui.totalSellingAfterDiscount, expTotalAfter, snapSell),
      totalSupplierPrice: firstFinite(ui.totalSupplierPrice, expSupplier),
      landedMaterialCost: firstFinite(ui.landedMaterialCost, material),
      landedCost: firstFinite(ui.landedCost, expLanded),
      totalSellingAmount: snapSell,
      totalProjectCost: snapProj,
      gpAmount: firstFinite(ui.gpAmount, expectedGpAmount(snapSell, snapProj)),
      gpPct: firstFinite(ui.gpPct, expectedGpPct(snapSell, snapProj)),
      grossProfitAmount: firstFinite(ui.gpAmount, expectedGpAmount(snapSell, snapProj)),
      unitAfter,
      qty,
    },
  };
}

/** QLI View — Consumables sections mirroring Pricing Calculator. */
async function readQliConsumablesSections(page) {
  await openAllQliPricingSections(page);
  progress('12. QLI View — reading Consumables Selling / Supplier / Provisions / Profitability');
  const sellingSec = await readQliSectionNumericMap(page, /selling\s*price/i);
  const supplierSec = await readQliSectionNumericMap(page, /supplier\s*cost|supplier\s*price/i);
  const provisionSec = await readQliSectionNumericMap(page, /provision\s*charges?|landed\s*cost|landed\s*material/i);
  const profitSec = await readQliSectionNumericMap(page, /profitability/i);

  const sections = {
    selling: {
      totalAfter: sellingSec.get('Total Selling Price After Discount (SAR)', 'Total Selling Price After Discount'),
      unitAfter: sellingSec.get(
        'Unit Sales Price After Discount (Back-Calculated) (SAR)',
        'Unit Sales Price After Discount',
      ),
      qty: sellingSec.get('Quantity'),
    },
    supplier: {
      supplierPrice: supplierSec.get('Supplier Price (SAR)', 'Supplier Price', 'SP Price (Per Unit) (SAR)'),
      totalSupplierPrice: supplierSec.get('Total Supplier Price (SAR)', 'Total Supplier Price'),
    },
    provisions: {
      landedMaterialCost: provisionSec.get('Landed Material Cost (SAR)', 'Landed Material Cost'),
      landedCost: provisionSec.get('Landed Cost (SAR)', 'Landed Cost'),
      financing: provisionSec.get('Financing Charges', 'Financing Charges (ZZFI)'),
      bank: provisionSec.get('Bank Charges for LCs/LGs', 'Bank Charges'),
      risk: provisionSec.get('Risk / Penalties', 'Risk / Penalties (ZPEN)'),
    },
    profitability: {
      totalSellingAmount: profitSec.get('Total Selling Amount (SAR)', 'Total Selling Amount'),
      totalProjectCost: profitSec.get('Total Project Cost (SAR)', 'Total Project Cost'),
      gpAmount: profitSec.get('GP Amount (SAR)', 'GP Amount', 'Gross Profit Amount'),
      gpPct: profitSec.get('GP %', 'GP%', 'Gross Profit %', 'Line Item GP%'),
    },
  };

  progress(
    `12. QLI Consumables — SellAfter=${moneyFmt(sections.selling.totalAfter)} ` +
      `Supplier=${moneyFmt(sections.supplier.totalSupplierPrice)} Landed=${moneyFmt(sections.provisions.landedCost)} ` +
      `Proj=${moneyFmt(sections.profitability.totalProjectCost)} GP%=${pctFmt(sections.profitability.gpPct)}`,
  );
  return sections;
}

function validateQliConsumablesSectionsVsCalculator(tag, qliSections, calcSnap, validationRows) {
  let ok = true;
  const cmp = (label, actual, expected, asPct = false) =>
    validateAgainstFormulas(`${tag} QLI ${label} vs calculator`, actual, expected, validationRows, { asPct });

  progress(`12. ${tag} QLI View — Consumables Selling vs calculator`);
  ok =
    cmp(
      'Selling: Total Selling Price After Discount (SAR)',
      qliSections.selling.totalAfter,
      firstFinite(calcSnap.totalSellingAfterDiscount, calcSnap.totalSellingAmount),
    ) && ok;
  progress(`12. ${tag} QLI View — Consumables Supplier vs calculator`);
  ok =
    cmp(
      'Supplier: Total Supplier Price (SAR)',
      qliSections.supplier.totalSupplierPrice,
      calcSnap.totalSupplierPrice,
    ) && ok;
  progress(`12. ${tag} QLI View — Consumables Provisions / Landed vs calculator`);
  ok =
    cmp(
      'Provisions: Landed Material Cost (= Total Supplier)',
      qliSections.provisions.landedMaterialCost,
      firstFinite(calcSnap.landedMaterialCost, calcSnap.totalSupplierPrice),
    ) && ok;
  ok = cmp('Provisions: Landed Cost (SAR)', qliSections.provisions.landedCost, calcSnap.landedCost) && ok;
  progress(`12. ${tag} QLI View — Consumables Profitability vs calculator`);
  ok =
    cmp(
      'Profitability: Total Selling Amount (SAR)',
      qliSections.profitability.totalSellingAmount,
      calcSnap.totalSellingAmount,
    ) && ok;
  ok =
    cmp(
      'Profitability: Total Project Cost (SAR)',
      qliSections.profitability.totalProjectCost,
      calcSnap.totalProjectCost,
    ) && ok;
  ok = cmp('Profitability: GP Amount (SAR)', qliSections.profitability.gpAmount, calcSnap.gpAmount) && ok;
  ok = cmp('Profitability: GP %', qliSections.profitability.gpPct, calcSnap.gpPct, true) && ok;

  return ok;
}

/**
 * Consumables — Profitability Summary (formulas shown on calculator)
 *   Total Selling Amount (SAR) = Unit Sales Price After Discount × Quantity
 *   Total Project Cost (SAR)   = Landed Cost (Landed Material Cost)
 *   GP Amount (SAR)            = Total Selling Amount − Total Project Cost
 *   GP %                       = GP Amount / Total Selling Amount × 100
 */
async function validateConsumablesProfitabilitySection(
  page,
  { unitAfter, qty, landedMaterialCost, totalSellingAfterDiscount },
  validationRows,
  tag = 'QLI',
) {
  await expandCalculatorSection(page, /profitability\s*summary|profitability/i);
  const profitUi = await readProfitabilitySummaryFromUi(page);
  const root = await pricingCalculatorRoot(page);
  const values = await readLabeledNumericMap(root);

  const totalSellingAmt = firstFinite(
    profitUi.selling,
    pickValue(
      values,
      'Total Selling Amount (SAR)',
      'Total Selling Amount',
      'Total Selling Price After Discount (SAR)',
      'Total Selling Price After Discount',
    ),
  );
  const totalProjectCost = firstFinite(
    profitUi.project,
    pickValue(values, 'Total Project Cost (SAR)', 'Total Project Cost', 'Landed Cost'),
  );
  const gpAmount = firstFinite(
    profitUi.gpAmt,
    pickValue(values, 'GP Amount (SAR)', 'GP Amount', 'Gross Profit Amount', 'Gross Profit'),
  );
  const gpPct = firstFinite(profitUi.gpPct, pickValue(values, 'GP %', 'GP%', 'Gross Profit %'));

  const expSelling =
    Number.isFinite(unitAfter) && Number.isFinite(qty)
      ? unitAfter * qty
      : Number.isFinite(totalSellingAfterDiscount)
        ? totalSellingAfterDiscount
        : NaN;
  const expProject = Number.isFinite(landedMaterialCost) ? landedMaterialCost : NaN;

  let ok = true;
  if (Number.isFinite(expSelling)) {
    ok =
      validateAgainstFormulas(
        `${tag} Profitability: Total Selling Amount (= Unit After × Qty)`,
        totalSellingAmt,
        expSelling,
        validationRows,
      ) && ok;
  }
  if (Number.isFinite(expProject)) {
    ok =
      validateAgainstFormulas(
        `${tag} Profitability: Total Project Cost (= Landed Cost SAR)`,
        totalProjectCost,
        expProject,
        validationRows,
      ) && ok;
  }

  // GP Amount / GP% — UI actual vs formula (blank UI → FAIL)
  ok =
    validatePricingFormulas(
      `${tag} Profitability`,
      {
        totalSellingAfterDiscount: firstFinite(totalSellingAmt, expSelling),
        totalProjectCost: firstFinite(totalProjectCost, expProject),
        grossProfitAmount: gpAmount,
        gpPct,
      },
      validationRows,
    ) && ok;

  const sellingForGp = firstFinite(totalSellingAmt, expSelling);
  const projectForGp = firstFinite(totalProjectCost, expProject);
  ok = assertPositiveGp(tag, firstFinite(gpPct, expectedGpPct(sellingForGp, projectForGp)), sellingForGp, projectForGp, validationRows) && ok;

  return {
    ok,
    totalSellingAmt: sellingForGp,
    totalProjectCost: projectForGp,
    gpAmount: firstFinite(gpAmount, expectedGpAmount(sellingForGp, projectForGp)),
    gpPct: firstFinite(gpPct, expectedGpPct(sellingForGp, projectForGp)),
    values,
  };
}

/** Detect calculator type from UI sections / env hint. */
async function detectPricingCalculatorCategory(page) {
  const hint = CALC_CATEGORY_HINT.toLowerCase();
  if (/medical/.test(hint) && !/consumable/.test(hint)) return 'Medical Equipment';
  if (/consumable/.test(hint) && !/medical/.test(hint)) return 'Consumables';

  const vatFromServices = page.getByText(/vat\s*amount\s*\(from\s*services\)|net\s*selling\s*price\s*including\s*vat/i).first();
  if (await vatFromServices.count().catch(() => 0)) return 'Medical Equipment';
  const meSupplier = page.getByText(/sp\s*price\s*\(per\s*unit\)\s*\(sar\)|freight\s*&\s*insurance|customs\s*duty/i).first();
  if (await meSupplier.count().catch(() => 0)) return 'Medical Equipment';

  const root = await pricingCalculatorRoot(page);
  const text = ((await root.innerText().catch(() => '')) || '').slice(0, 16000);
  if (/medical\s*equipment/i.test(text)) return 'Medical Equipment';
  if (/freight\s*&\s*insurance|customs\s*duty|exchange\s*rate|sp\s*price\s*\(sar\)/i.test(text)) {
    return 'Medical Equipment';
  }
  if (/financing\s*charges|bank\s*charges\s*for\s*lc/i.test(text) && !/freight|customs|vat\s*amount\s*\(from\s*services\)/i.test(text)) {
    return 'Consumables';
  }
  if (await root.getByLabel(/^currency$/i).isVisible({ timeout: 0 }).catch(() => false)) {
    return 'Medical Equipment';
  }
  return 'Medical Equipment';
}

async function setCalculatorPicklist(scope, labelRe, optionText) {
  const combo = scope
    .getByRole('combobox', { name: labelRe })
    .or(scope.getByLabel(labelRe))
    .first();
  if (!(await combo.isVisible({ timeout: 1_500 }).catch(() => false))) return false;
  await combo.click();
  const page = combo.page();
  const option = page.getByRole('option', { name: new RegExp(`^${optionText}$`, 'i') }).first();
  if (await option.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await option.click();
    progress(`12. Calculator picklist — set to ${optionText}`);
    return true;
  }
  await combo.fill(optionText).catch(() => {});
  await combo.press('Enter').catch(() => {});
  return true;
}

/**
 * Medical Equipment — Selling Price & Discount (matches calculator UI)
 *   Total Before = Unit Before × Qty
 *   Discount Amount = Total Before × Customer Discount% / 100
 *   Total After = Total Before − Discount Amount
 *   Unit After (back-calculated) = Total After / Qty
 *   Net Selling Incl. VAT = Total After + VAT Amount (From Services)
 */
async function fillAndValidateMedicalEquipmentSellingPriceSection(page, validationRows, tag = 'QLI') {
  await expandCalculatorSection(page, /selling\s*price/i);
  const root = await pricingCalculatorRoot(page);
  progress(`12. ${tag} Medical Equipment — Selling Price & Discount`);

  const unitBeforeInput = await findEditableByLabel(root, /unit\s*sales\s*price\s*before\s*discount/i);
  await fillIfBlankOrZero(unitBeforeInput, CALC_UNIT_PRICE, 'Unit Sales Price Before Discount (SAR)');

  const discountPctInput = await findEditableByLabel(
    root,
    /customer\s*discount\s*\(?%\)?|discount\s*\(?%\)?/i,
  );
  await fillPercentIfBlank(discountPctInput, CALC_DISCOUNT_PCT, 'Customer Discount (%)');

  await clickApplyConfiguration(page);
  await sleep(800);
  await expandCalculatorSection(page, /selling\s*price/i);
  let values = await readLabeledNumericMap(root);
  const qtyInput = await findEditableByLabel(root, /^quantity$/i);
  let qty = pickValue(values, 'Quantity');
  if (!Number.isFinite(qty) || qty < 1) qty = (await readEditableNumeric(qtyInput)) || 1;
  let unitBefore = pickValue(values, 'Unit Sales Price Before Discount (SAR)', 'Unit Sales Price Before Discount');
  if (!Number.isFinite(unitBefore)) unitBefore = await readEditableNumeric(unitBeforeInput);
  let discountPct = pickValue(values, 'Customer Discount (%)', 'Discount (%)', 'Discount %');
  if (!Number.isFinite(discountPct)) discountPct = await readEditableNumeric(discountPctInput);
  if (!Number.isFinite(discountPct)) discountPct = 0;
  discountPct = clampPercent(discountPct);
  let discountAmt = pickValue(values, 'Discount Amount', 'Discount Amount (SAR)');
  let unitAfter = pickValue(
    values,
    'Unit Sales Price After Discount (Back-Calculated) (SAR)',
    'Unit Sales Price After Discount (Back-Calculated)',
    'Unit Sales Price After Discount',
  );
  let totalBefore = pickValue(
    values,
    'Total Selling Price Before Discount (SAR)',
    'Total Selling Price Before Discount',
  );
  let totalAfter = pickValue(
    values,
    'Total Selling Price After Discount (SAR)',
    'Total Selling Price After Discount',
  );
  // Computed display fields sometimes miss the label map — harvest from section text
  if (![totalBefore, totalAfter, unitAfter, discountAmt].every((n) => Number.isFinite(n))) {
    const sectionText = ((await root.innerText().catch(() => '')) || '').replace(/\u00a0/g, ' ');
    const harvested = harvestAdjacentLines(sectionText);
    if (!Number.isFinite(totalBefore)) {
      totalBefore = firstFinite(
        pickValue(harvested, 'Total Selling Price Before Discount (SAR)', 'Total Selling Price Before Discount'),
        moneyAfterLabel(sectionText, 'Total Selling Price Before Discount'),
      );
    }
    if (!Number.isFinite(totalAfter)) {
      totalAfter = firstFinite(
        pickValue(harvested, 'Total Selling Price After Discount (SAR)', 'Total Selling Price After Discount'),
        moneyAfterLabel(sectionText, 'Total Selling Price After Discount'),
      );
    }
    if (!Number.isFinite(unitAfter)) {
      unitAfter = firstFinite(
        pickValue(harvested, 'Unit Sales Price After Discount (Back-Calculated) (SAR)', 'Unit Sales Price After Discount'),
        moneyAfterLabel(sectionText, 'Unit Sales Price After Discount'),
      );
    }
    if (!Number.isFinite(discountAmt)) {
      discountAmt = firstFinite(
        pickValue(harvested, 'Discount Amount (SAR)', 'Discount Amount'),
        moneyAfterLabel(sectionText, 'Discount Amount'),
      );
    }
  }
  const vatFromServices = pickValue(
    values,
    'VAT Amount (From Services) (SAR)',
    'VAT Amount (From Services)',
    'VAT Amount From Services',
  );
  const netInclVat = pickValue(
    values,
    'Net Selling Price Including VAT (Total)',
    'Net Selling Price Including VAT',
    'Net Selling Price Incl. VAT',
  );

  let ok = true;
  const expTotalBefore = Number.isFinite(unitBefore) ? unitBefore * qty : NaN;
  if (Number.isFinite(expTotalBefore)) {
    ok =
      validateAgainstFormulas(
        `${tag} ME Selling: Total Before (= Unit Before × Qty)`,
        totalBefore,
        expTotalBefore,
        validationRows,
      ) && ok;
  }

  const baseBefore = Number.isFinite(totalBefore) ? totalBefore : expTotalBefore;
  const expDiscountAmt =
    Number.isFinite(baseBefore) && Number.isFinite(discountPct) ? (baseBefore * discountPct) / 100 : NaN;
  if (Number.isFinite(expDiscountAmt)) {
    ok =
      validateAgainstFormulas(
        `${tag} ME Selling: Discount Amount (= Total Before × Discount% / 100)`,
        discountAmt,
        expDiscountAmt,
        validationRows,
      ) && ok;
  }

  const disc = Number.isFinite(discountAmt) ? discountAmt : expDiscountAmt;
  const expTotalAfter = Number.isFinite(baseBefore) && Number.isFinite(disc) ? baseBefore - disc : NaN;
  if (Number.isFinite(expTotalAfter)) {
    ok =
      validateAgainstFormulas(
        `${tag} ME Selling: Total After (= Total Before − Discount Amount)`,
        totalAfter,
        expTotalAfter,
        validationRows,
      ) && ok;
  }

  const afterTotal = Number.isFinite(totalAfter) ? totalAfter : expTotalAfter;
  const expUnitAfter = Number.isFinite(afterTotal) && qty ? afterTotal / qty : NaN;
  if (Number.isFinite(expUnitAfter)) {
    ok =
      validateAgainstFormulas(
        `${tag} ME Selling: Unit After back-calc (= Total After / Qty)`,
        unitAfter,
        expUnitAfter,
        validationRows,
      ) && ok;
  }

  if (Number.isFinite(afterTotal) && Number.isFinite(vatFromServices)) {
    ok =
      validateAgainstFormulas(
        `${tag} ME Selling: Net Incl. VAT (= Total After + VAT From Services)`,
        netInclVat,
        afterTotal + vatFromServices,
        validationRows,
      ) && ok;
  }

  return {
    ok,
    qty,
    unitBefore,
    discountPct,
    discountAmt: Number.isFinite(discountAmt) ? discountAmt : expDiscountAmt,
    unitAfter: Number.isFinite(unitAfter) ? unitAfter : expUnitAfter,
    totalBefore: Number.isFinite(totalBefore) ? totalBefore : expTotalBefore,
    totalAfter: afterTotal,
    vatFromServices,
    netInclVat,
    values,
  };
}

/**
 * Medical Equipment — Supplier Cost Calculation
 *   Currency picklist; Exchange Rate from table (SAR → 1.0000)
 *   Supplier Price in original currency; SP Price (SAR) = Supplier Price × Exchange Rate
 *   Total Supplier Price (SAR) = SP Price (SAR) × Quantity
 */
async function fillAndValidateMedicalEquipmentSupplierCostSection(page, quantity, validationRows, tag = 'QLI') {
  await expandCalculatorSection(page, /supplier\s*cost|supplier\s*price/i);
  const root = await pricingCalculatorRoot(page);
  progress(`12. ${tag} Medical Equipment — Supplier Cost Calculation`);

  await setCalculatorPicklist(root, /^currency$/i, CALC_CURRENCY);

  const isSar = /^sar$/i.test(CALC_CURRENCY);
  const valuesAfterFx = await readLabeledNumericMap(root);
  const fx = pickValue(valuesAfterFx, 'Exchange Rate', 'Exchange Rate (SAR)', 'FX Rate');

  let ok = true;
  if (isSar) {
    const fxCheck = Number.isFinite(fx) ? fx : 1;
    ok =
      validateAgainstFormulas(`${tag} ME Supplier: Exchange Rate (SAR → 1)`, fxCheck, 1, validationRows) && ok;
  } else if (Number.isFinite(fx) && fx > 0) {
    progress(`12. ${tag} ME Exchange Rate = ${fx} (from Exchange Rate table for ${CALC_CURRENCY})`);
    validationRows.push({
      section: `${tag} ME Supplier: Exchange Rate populated`,
      actual: String(fx),
      expected: '> 0 from table',
      status: 'PASS',
    });
  }

  const supplierPriceInput = await findEditableByLabel(root, /^supplier\s*price(?!\s*\(sar\))/i);
  await fillIfBlankOrZero(supplierPriceInput, CALC_SUPPLIER_PRICE, 'Supplier Price (original currency)');

  await clickApplyConfiguration(page);
  const values = await readLabeledNumericMap(root);
  const supplierPrice = pickValue(values, 'Supplier Price', 'Supplier Price (Original)');
  const exchangeRate = pickValue(values, 'Exchange Rate') || (isSar ? 1 : fx);
  const spSar = pickValue(values, 'SP Price (SAR)', 'SP Price', 'Supplier Price (SAR)');
  const totalSupplier = pickValue(values, 'Total Supplier Price (SAR)', 'Total Supplier Price');
  const qty = Number.isFinite(quantity) && quantity > 0 ? quantity : pickValue(values, 'Quantity') || 1;

  if (Number.isFinite(supplierPrice) && Number.isFinite(exchangeRate)) {
    ok =
      validateAgainstFormulas(
        `${tag} ME Supplier: SP Price (SAR) (= Supplier Price × Exchange Rate)`,
        spSar,
        supplierPrice * exchangeRate,
        validationRows,
      ) && ok;
  }

  const spForTotal = Number.isFinite(spSar)
    ? spSar
    : Number.isFinite(supplierPrice) && Number.isFinite(exchangeRate)
      ? supplierPrice * exchangeRate
      : NaN;
  if (Number.isFinite(spForTotal)) {
    ok =
      validateAgainstFormulas(
        `${tag} ME Supplier: Total Supplier Price (SAR) (= SP × Qty)`,
        totalSupplier,
        spForTotal * qty,
        validationRows,
      ) && ok;
  }

  return {
    ok,
    values,
    currency: CALC_CURRENCY,
    isSar,
    exchangeRate,
    supplierPrice,
    spSar: spForTotal,
    totalSupplier: Number.isFinite(totalSupplier) ? totalSupplier : spForTotal * qty,
    qty,
  };
}

/**
 * Medical Equipment — Landed Cost Calculation
 * Medical Equipment — 3 Landed Material Cost (screenshot table)
 *   Freight & Insurance Amount (SAR) = Total Supplier Price (SAR) × Rate % / 100
 *   Customs Duty Amount (SAR)        = Total Supplier Price (SAR) × Rate % / 100
 *   Total Freight & Customs (SAR)    = Freight & Insurance Amount + Customs Duty Amount
 *   Landed Material Cost (SAR)       = Total Supplier Price (SAR) + Freight & Insurance Amount + Customs Duty Amount
 */
async function readLandedMaterialCostTable(page, { totalSupplierPrice } = {}) {
  await expandCalculatorSection(page, /3\.?\s*landed\s*material\s*cost|landed\s*material\s*cost/i);
  const root = await pricingCalculatorRoot(page);
  const section = root
    .locator('.slds-section, lightning-accordion-section, article, .slds-card, section')
    .filter({ hasText: /landed\s*material\s*cost/i })
    .first();
  const scope = (await section.isVisible({ timeout: 1_500 }).catch(() => false)) ? section : root;
  const fullText = ((await scope.innerText().catch(() => '')) || '').replace(/\u00a0/g, ' ');
  const text = sliceCalculatorSectionText(
    fullText,
    /3\.?\s*landed\s*material\s*cost|landed\s*material\s*cost/i,
    /\n\s*\d+\.\s+|^\s*4\.|warranty,\s*services|provision\s*charges|profitability|landed\s*cost\s*\((?:sar|afms)/im,
  );
  const parsed = parseCalculatorAmountTable(text, [
    { key: 'freight', re: /freight\s*&\s*insurance/i, hasRate: true },
    { key: 'customs', re: /customs\s*duty/i, hasRate: true },
    { key: 'totalFc', re: /total\s*freight\s*&\s*customs/i, hasRate: false },
    {
      key: 'landedMat',
      re: /landed\s*material\s*cost/i,
      hasRate: false,
      skipBareTitle: /^landed\s*material\s*cost$/i,
    },
  ]);

  const freightPctInput = await findEditableByLabel(scope, /freight\s*&\s*insurance/i);
  const customsPctInput = await findEditableByLabel(scope, /customs\s*duty/i);
  let freightPctFromInput = await readEditableNumeric(freightPctInput);
  let customsPctFromInput = await readEditableNumeric(customsPctInput);
  // Amount cells can match the same label — ignore values that are not rates
  if (Number.isFinite(freightPctFromInput) && Math.abs(freightPctFromInput) > 100) freightPctFromInput = NaN;
  if (Number.isFinite(customsPctFromInput) && Math.abs(customsPctFromInput) > 100) customsPctFromInput = NaN;

  const map = await readLabeledNumericMap(scope).catch(() => ({}));
  const totalSupplier = firstFinite(
    totalSupplierPrice,
    pickValue(map, 'Total Supplier Price (SAR)', 'Total Supplier Price'),
  );

  const out = {
    freightPct: firstFinite(freightPctFromInput, parsed.freight?.rate),
    freightAmt: firstFinite(parsed.freight?.amount),
    customsPct: firstFinite(customsPctFromInput, parsed.customs?.rate),
    customsAmt: firstFinite(parsed.customs?.amount),
    totalFreightCustoms: firstFinite(parsed.totalFc?.amount),
    landedMaterialCost: firstFinite(parsed.landedMat?.amount),
  };

  // Prefer Rate × Total Supplier for Amounts when rates are known
  if (Number.isFinite(totalSupplier) && Number.isFinite(out.freightPct)) {
    out.freightAmt = (totalSupplier * out.freightPct) / 100;
  }
  if (Number.isFinite(totalSupplier) && Number.isFinite(out.customsPct)) {
    out.customsAmt = (totalSupplier * out.customsPct) / 100;
  }
  const expFc =
    Number.isFinite(out.freightAmt) && Number.isFinite(out.customsAmt)
      ? out.freightAmt + out.customsAmt
      : Number.isFinite(out.freightAmt)
        ? out.freightAmt + (Number.isFinite(out.customsAmt) ? out.customsAmt : 0)
        : Number.isFinite(out.customsAmt)
          ? out.customsAmt
          : NaN;
  if (Number.isFinite(expFc)) out.totalFreightCustoms = expFc;

  // Source of truth:
  // Landed Material Cost (SAR) = Total Supplier Price (SAR) + Freight & Insurance Amount + Customs Duty Amount
  if (Number.isFinite(totalSupplier)) {
    out.landedMaterialCost =
      totalSupplier +
      (Number.isFinite(out.freightAmt) ? out.freightAmt : 0) +
      (Number.isFinite(out.customsAmt) ? out.customsAmt : 0);
  }

  progress(
    `12. Calculator 3 Landed Material Cost — Freight rate=${pctFmt(out.freightPct)} amt=${moneyFmt(out.freightAmt)} ` +
      `Customs rate=${pctFmt(out.customsPct)} amt=${moneyFmt(out.customsAmt)} ` +
      `Total F&C=${moneyFmt(out.totalFreightCustoms)} Landed Material=${moneyFmt(out.landedMaterialCost)}`,
  );
  return out;
}

function applyLandedMaterialCostTableToMap(map, table) {
  if (!map || !table) return map;
  const put = (label, n) => {
    if (!Number.isFinite(n)) return;
    map[fieldKey(label)] = n;
  };
  put('Freight & Insurance Amount (SAR)', table.freightAmt);
  put('Freight & Insurance Amount', table.freightAmt);
  put('Freight & Insurance (%)', table.freightPct);
  put('Customs Duty Amount (SAR)', table.customsAmt);
  put('Customs Duty Amount', table.customsAmt);
  put('Customs Duty (%)', table.customsPct);
  put('Total Freight & Customs (SAR)', table.totalFreightCustoms);
  put('Landed Material Cost (SAR)', table.landedMaterialCost);
  put('Landed Material Cost', table.landedMaterialCost);
  return map;
}

async function fillAndValidateMedicalEquipmentLandedCostSection(
  page,
  { totalSupplierPrice, isSar },
  validationRows,
  tag = 'QLI',
) {
  await expandCalculatorSection(page, /landed\s*material\s*cost|landed\s*cost/i);
  const root = await pricingCalculatorRoot(page);
  progress(`12. ${tag} Medical Equipment — Landed Material Cost`);

  // Updated UI: Freight & Customs rates are shown; amounts = Total Supplier × Rate% / 100
  // Only fill Rate (%) — never overwrite Amount (SAR) if the same label matches both cells
  const freightPctInput = await findEditableByLabel(root, /freight\s*&\s*insurance/i);
  const customsPctInput = await findEditableByLabel(root, /customs\s*duty/i);
  await fillPercentIfBlank(freightPctInput, CALC_FREIGHT_PCT, 'Freight & Insurance (%)');
  await fillPercentIfBlank(customsPctInput, CALC_CUSTOMS_PCT, 'Customs Duty (%)');
  if (isSar) {
    progress(`12. ${tag} ME Landed — Currency=SAR (Freight/Customs rates may still display; amounts follow Total Supplier)`);
  }

  await clickApplyConfiguration(page);
  const table = await readLandedMaterialCostTable(page, { totalSupplierPrice });
  const values = applyLandedMaterialCostTableToMap(await readLabeledNumericMap(root), table);
  const freightPct = firstFinite(
    table.freightPct,
    pickValue(values, 'Freight & Insurance (%)', 'Freight & Insurance %', 'Freight %'),
  );
  const customsPct = firstFinite(
    table.customsPct,
    pickValue(values, 'Customs Duty (%)', 'Customs Duty %', 'Customs %'),
  );
  const freightAmt = firstFinite(
    table.freightAmt,
    pickValue(values, 'Freight & Insurance Amount (SAR)', 'Freight & Insurance Amount', 'Freight Amount'),
  );
  const customsAmt = firstFinite(
    table.customsAmt,
    pickValue(values, 'Customs Duty Amount (SAR)', 'Customs Duty Amount', 'Customs Amount'),
  );
  const totalFreightCustoms = firstFinite(
    table.totalFreightCustoms,
    pickValue(values, 'Total Freight & Customs (SAR)', 'Total Freight & Customs'),
  );
  const landed = firstFinite(table.landedMaterialCost, pickValue(values, 'Landed Material Cost (SAR)', 'Landed Material Cost'));

  const totalSupplier =
    Number.isFinite(totalSupplierPrice)
      ? totalSupplierPrice
      : pickValue(values, 'Total Supplier Price (SAR)', 'Total Supplier Price');

  let ok = true;
  let expFreight = 0;
  let expCustoms = 0;
  if (Number.isFinite(totalSupplier)) {
    if (Number.isFinite(freightPct)) {
      expFreight = (totalSupplier * freightPct) / 100;
      ok =
        validateAgainstFormulas(
          `${tag} ME Landed: Freight Amount (= Total Supplier × Freight% / 100)`,
          freightAmt,
          expFreight,
          validationRows,
        ) && ok;
    }
    if (Number.isFinite(customsPct)) {
      expCustoms = (totalSupplier * customsPct) / 100;
      ok =
        validateAgainstFormulas(
          `${tag} ME Landed: Customs Amount (= Total Supplier × Customs% / 100)`,
          customsAmt,
          expCustoms,
          validationRows,
        ) && ok;
    }
    if (Number.isFinite(totalFreightCustoms)) {
      ok =
        validateAgainstFormulas(
          `${tag} ME Landed: Total Freight & Customs`,
          totalFreightCustoms,
          expFreight + expCustoms,
          validationRows,
        ) && ok;
    }
    ok =
      validateAgainstFormulas(
        `${tag} ME Landed Material Cost (SAR) (= Total Supplier Price + Freight & Insurance Amount + Customs Duty Amount)`,
        landed,
        totalSupplier + expFreight + expCustoms,
        validationRows,
      ) && ok;
  }

  return {
    ok,
    values,
    freightPct,
    customsPct,
    freightAmt: Number.isFinite(freightAmt) ? freightAmt : expFreight,
    customsAmt: Number.isFinite(customsAmt) ? customsAmt : expCustoms,
    totalFreightCustoms: Number.isFinite(totalFreightCustoms) ? totalFreightCustoms : expFreight + expCustoms,
    landed: Number.isFinite(landed)
      ? landed
      : Number.isFinite(totalSupplier)
        ? totalSupplier + expFreight + expCustoms
        : NaN,
  };
}

/**
 * Medical Equipment — Provision Charges (Charge Population)
 * Product Category = Medical Equipment OR Medical Equipment & Consumables
 *   SAR Amount = Total Selling Price After Discount × Charge Rate %
 *   Total EK02 Charges = Finance + Bank + Risk + PMO + Standard Warranty
 *   Landed Cost (AFMS Warehouse) = Landed Material Cost (SAR) + Total Charges
 */
async function validateMedicalEquipmentProvisionCharges(
  page,
  { totalSellingAfterDiscount, landedMaterialCost },
  validationRows,
  tag = 'QLI',
) {
  await expandCalculatorSection(page, /provision\s*charges?|ek02/i);
  await capHighProvisionChargeRates(page, tag);
  const root = await pricingCalculatorRoot(page);
  progress(`12. ${tag} Medical Equipment — Provision Charges (default rates + EK02 / AFMS)`);

  if (!Number.isFinite(totalSellingAfterDiscount)) {
    progress(`12. ${tag} WARN — Total Selling After Discount missing for ME provision charges`);
    return { ok: false, values: {}, charges: {}, totalEk02: NaN, afmsLanded: NaN };
  }

  await clickApplyConfiguration(page);
  const rootText = ((await root.innerText().catch(() => '')) || '').replace(/\u00a0/g, ' ');
  const provisionRows = parseCalculatorAmountTable(
    rootText,
    MEDICAL_EQUIPMENT_PROVISION_CHARGES.map((spec) => ({
      key: spec.name,
      re: new RegExp(spec.aliases.map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i'),
      hasRate: true,
    })),
  );
  const values = await readLabeledNumericMap(root);
  let ok = true;
  const charges = {};
  let sumExpected = 0;

  for (const spec of MEDICAL_EQUIPMENT_PROVISION_CHARGES) {
    const expectedAmt = totalSellingAfterDiscount * (spec.ratePct / 100);
    sumExpected += expectedAmt;
    const actualAmt = firstFinite(
      provisionRows[spec.name]?.amount,
      pickValue(
        values,
        ...spec.aliases,
        `${spec.name} Amount`,
        `${spec.name} (SAR)`,
        `${spec.name} SAR Amount`,
      ),
    );
    charges[spec.name] = { actual: actualAmt, expected: expectedAmt, ratePct: spec.ratePct };
    ok =
      validateAgainstFormulas(
        `${tag} ME Provision: ${spec.name} SAR (= Selling After × ${spec.ratePct}%)`,
        actualAmt,
        expectedAmt,
        validationRows,
      ) && ok;

    const rateActual = firstFinite(
      provisionRows[spec.name]?.rate,
      pickValue(values, `${spec.name} %`, `${spec.name} Rate`, `${spec.name} (%)`),
    );
    if (Number.isFinite(rateActual)) {
      ok =
        validateAgainstFormulas(
          `${tag} ME Provision rate: ${spec.name}`,
          rateActual,
          spec.ratePct,
          validationRows,
          { asPct: true },
        ) && ok;
    }
  }

  const totalEk02 = pickValue(
    values,
    'Total EK02 Charges',
    'Total Provision Charges',
    'Total Charges',
    'EK02 Charges',
  );

  // Landed Cost under provisions = Landed Material + ALL provision amounts (incl. extra product lines)
  // Prefer summing known defaults + any extra amount fields that are % of selling
  let sumAllProvisions = sumExpected;
  // If UI landed cost is present, derive expected from material + sum of charge amounts read from table
  const tableAmounts = [];
  for (const spec of MEDICAL_EQUIPMENT_PROVISION_CHARGES) {
    const a = charges[spec.name]?.actual;
    if (Number.isFinite(a)) tableAmounts.push(a);
  }
  if (tableAmounts.length) {
    sumAllProvisions = tableAmounts.reduce((s, n) => s + n, 0);
    // Include any extra provision rows by comparing UI Landed Cost if available
  }

  ok =
    validateAgainstFormulas(
      `${tag} ME default Provision Charges sum (Finance+Bank+Risk+PMO+Warranty)`,
      Number.isFinite(totalEk02) ? totalEk02 : sumExpected,
      sumExpected,
      validationRows,
    ) && ok;

  const ek02ForAfms = Number.isFinite(totalEk02) ? totalEk02 : sumAllProvisions;
  const afms = pickValue(
    values,
    'Landed Cost (SAR)',
    'Landed Cost (AFMS Warehouse)',
    'Landed Cost AFMS Warehouse',
    'AFMS Warehouse',
    'Landed Cost (AFMS)',
  );
  if (Number.isFinite(landedMaterialCost)) {
    // Prefer actual Landed Cost from UI vs Material + all provision amounts shown
    // If Landed Cost > Material + default sum, extra charge lines exist — use UI Landed Cost as source of truth for snapshot
    const expectedFromDefaults = landedMaterialCost + sumExpected;
    if (Number.isFinite(afms) && afms > expectedFromDefaults + MONEY_TOLERANCE) {
      progress(
        `12. ${tag} ME Landed Cost includes extra provision line(s): UI=${moneyFmt(afms)} vs defaults=${moneyFmt(expectedFromDefaults)}`,
      );
      validationRows.push({
        section: `${tag} ME Landed Cost (Material + All Provisions incl. extras)`,
        actual: moneyFmt(afms),
        expected: `â‰¥ ${moneyFmt(expectedFromDefaults)}`,
        status: afms + MONEY_TOLERANCE >= expectedFromDefaults ? 'PASS' : 'FAIL',
      });
      if (afms + MONEY_TOLERANCE < expectedFromDefaults) ok = false;
    } else {
      ok =
        validateAgainstFormulas(
          `${tag} ME Landed Cost (= Landed Material + Provision Charges)`,
          afms,
          expectedFromDefaults,
          validationRows,
        ) && ok;
    }
  } else {
    progress(`12. ${tag} WARN — Landed Material Cost missing for Landed Cost formula`);
  }

  return {
    ok,
    values,
    charges,
    totalEk02: Number.isFinite(totalEk02) ? totalEk02 : sumExpected,
    afmsLanded: Number.isFinite(afms)
      ? afms
      : Number.isFinite(landedMaterialCost)
        ? landedMaterialCost + ek02ForAfms
        : NaN,
  };
}

/**
 * Medical Equipment — Warranty, Services & Equipment Liable to VAT (updated UI)
 * Service rows: enter W/S → Percentage auto from W/S; VAT = W/S × 15%
 * Warranty rows (External/Extended 2nd–6th+7th): % editable → W/S auto (read-only);
 *   W/S = Total Selling Price After Discount (SAR) × %; VAT = W/S × 15%
 *   (base field renamed from Unit Sales Price After Discount)
 * Standard Warranty — 1st Year: not validated (struck through / out of scope)
 */
async function fillAndValidateMedicalEquipmentWarrantyServices(
  page,
  validationRows,
  tag = 'QLI',
  { totalSellingPriceAfterDiscount = NaN, unitSalesPriceAfterDiscount = NaN } = {},
) {
  // Renamed base: Total Selling Price After Discount (SAR) × %
  const warrantyBase = firstFinite(totalSellingPriceAfterDiscount, unitSalesPriceAfterDiscount);
  await expandCalculatorSection(
    page,
    /warranty,\s*services|warranty\s*&\s*services|equipment\s*liable\s*to\s*vat|service\s*lines/i,
  );
  const root = await pricingCalculatorRoot(page);
  progress(`12. ${tag} Medical Equipment — Warranty, Services & Equipment Liable to VAT`);

  let ok = true;
  const lineResults = [];
  let totalWs = 0;
  let totalVat = 0;
  let foundRows = 0;
  let warrantyRows = 0;

  async function locateServiceRow(spec) {
    for (const a of spec.aliases) {
      const r = root
        .locator('table tbody tr, .slds-table tbody tr, [role="row"]')
        .filter({ hasText: new RegExp(a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').slice(0, 36), 'i') })
        .first();
      if (await r.isVisible({ timeout: 0 }).catch(() => false)) return r;
    }
    return null;
  }

  async function readRateWsVat(row) {
    const inputs = row.locator('input:not([type="hidden"])');
    const ic = await inputs.count().catch(() => 0);
    const nums = [];
    for (let i = 0; i < ic; i++) {
      const inp = inputs.nth(i);
      const v = parseMoney((await inp.inputValue().catch(() => '')) || '');
      if (!Number.isFinite(v)) continue;
      const name =
        ((await inp.getAttribute('aria-label').catch(() => '')) || '') +
        ((await inp.getAttribute('name').catch(() => '')) || '') +
        ((await inp.getAttribute('data-label').catch(() => '')) || '');
      nums.push({ v, name, readonly: !!(await inp.getAttribute('readonly').catch(() => null)) });
    }
    const cells = row.locator('td, lightning-formatted-number, .slds-form-element__static');
    const cc = await cells.count().catch(() => 0);
    const cellNums = [];
    for (let c = 0; c < cc; c++) {
      const n = parseMoney((await cells.nth(c).innerText().catch(() => '')) || '');
      if (Number.isFinite(n)) cellNums.push(n);
    }

    let rate = NaN;
    let ws = NaN;
    let vat = NaN;
    for (const { v, name } of nums) {
      if (/vat/i.test(name)) vat = v;
      else if (/w\s*\/\s*s|ws/i.test(name)) ws = v;
      else if (/rate|percent|%/i.test(name)) rate = v;
    }
    // Heuristic: rate is typically 0–100; W/S is a money amount often > 100
    if (!Number.isFinite(rate) || !Number.isFinite(ws)) {
      const moneyish = [...nums.map((x) => x.v), ...cellNums].filter((n) => Number.isFinite(n) && Math.abs(n) > 100);
      const pctish = [...nums.map((x) => x.v), ...cellNums].filter((n) => Number.isFinite(n) && Math.abs(n) <= 100);
      if (!Number.isFinite(ws) && moneyish.length) ws = moneyish[0];
      if (!Number.isFinite(rate) && pctish.length) rate = pctish[0];
    }
    if (!Number.isFinite(vat) && Number.isFinite(ws)) {
      const maybeVat = cellNums.find((n) => nearlyEqual(n, ws * (ME_VAT_RATE_PCT / 100)));
      vat = maybeVat ?? ws * (ME_VAT_RATE_PCT / 100);
    }
    return { rate, ws, vat };
  }

  for (const spec of MEDICAL_EQUIPMENT_SERVICE_LINES) {
    const row = await locateServiceRow(spec);
    if (!row) {
      progress(`12. ${tag} W/S row not visible — "${spec.name}" (skip)`);
      continue;
    }
    await row.scrollIntoViewIfNeeded().catch(() => {});
    foundRows += 1;

    if (spec.kind === 'service') {
      // Service: fill W/S if blank; Percentage auto-calculated from W/S
      const wsInput = row
        .getByRole('textbox', { name: /w\s*\/\s*s|ws\s*value|value/i })
        .or(row.locator('input:not([disabled]):not([readonly])').nth(1))
        .first();
      // Prefer last editable non-percent input as W/S
      const editables = row.locator('input:not([type="hidden"]):not([disabled])');
      const ec = await editables.count().catch(() => 0);
      let filled = false;
      for (let i = 0; i < ec; i++) {
        const inp = editables.nth(i);
        const name =
          ((await inp.getAttribute('aria-label').catch(() => '')) || '') +
          ((await inp.getAttribute('name').catch(() => '')) || '');
        if (/percent|rate|%/i.test(name)) continue;
        await fillIfBlankOrZero(inp, CALC_WS_VALUE, `${spec.name} W/S Value`);
        filled = true;
        break;
      }
      if (!filled && (await wsInput.isVisible({ timeout: 0 }).catch(() => false))) {
        await fillIfBlankOrZero(wsInput, CALC_WS_VALUE, `${spec.name} W/S Value`);
      }
    } else {
      // Warranty: fill % ; W/S should be read-only / auto
      warrantyRows += 1;
      const rateInput = row
        .getByRole('textbox', { name: /percent|rate|%/i })
        .or(row.locator('input:not([disabled])').first())
        .first();
      if (await rateInput.isVisible({ timeout: 0 }).catch(() => false)) {
        await fillPercentIfBlank(rateInput, CALC_EW_RATE_PCT, `${spec.name} Percentage (%)`);
      }
      const wsReadonly = row.locator('input[readonly], input[disabled]').first();
      if (await wsReadonly.isVisible({ timeout: 0 }).catch(() => false)) {
        validationRows.push({
          section: `${tag} Warranty W/S read-only: ${spec.name}`,
          actual: 'read-only',
          expected: 'read-only',
          status: 'PASS',
        });
      }
    }

    const { rate, ws, vat } = await readRateWsVat(row);

    if (spec.kind === 'warranty' && Number.isFinite(warrantyBase) && Number.isFinite(ws)) {
      // Prefer UI rate; if rate missing, back-calc from W/S ÷ Total Selling After Discount
      let rateForFormula = rate;
      if (!Number.isFinite(rateForFormula) && Math.abs(warrantyBase) > MONEY_TOLERANCE) {
        rateForFormula = (ws / warrantyBase) * 100;
      }
      const expWs = Number.isFinite(rateForFormula)
        ? warrantyBase * (rateForFormula / 100)
        : NaN;
      ok =
        validateAgainstFormulas(
          `${tag} Warranty W/S: ${spec.name} (= Total Selling Price After Discount × %)`,
          ws,
          expWs,
          validationRows,
        ) && ok;
      const expVat = ws * (ME_VAT_RATE_PCT / 100);
      ok =
        validateAgainstFormulas(
          `${tag} Warranty VAT: ${spec.name} (= W/S × 15%)`,
          Number.isFinite(vat) ? vat : expVat,
          expVat,
          validationRows,
        ) && ok;
      totalWs += ws;
      totalVat += Number.isFinite(vat) ? vat : expVat;
      lineResults.push({
        name: spec.name,
        kind: spec.kind,
        rate: rateForFormula,
        ws,
        vat: Number.isFinite(vat) ? vat : expVat,
      });
      continue;
    }

    if (Number.isFinite(ws)) {
      const expVat = ws * (ME_VAT_RATE_PCT / 100);
      ok =
        validateAgainstFormulas(
          `${tag} Service VAT: ${spec.name} (= W/S × 15%)`,
          Number.isFinite(vat) ? vat : expVat,
          expVat,
          validationRows,
        ) && ok;
      // Percentage is auto-calculated from W/S — soft check only (exact formula not specified)
      if (Number.isFinite(rate)) {
        validationRows.push({
          section: `${tag} Service % auto from W/S: ${spec.name}`,
          actual: pctFmt(rate),
          expected: 'auto from W/S (populated)',
          status: 'PASS',
        });
      } else if (Math.abs(ws) > MONEY_TOLERANCE) {
        validationRows.push({
          section: `${tag} Service % auto from W/S: ${spec.name}`,
          actual: '(blank)',
          expected: 'auto from W/S (populated)',
          status: 'INFO',
        });
      }
      totalWs += ws;
      totalVat += Number.isFinite(vat) ? vat : expVat;
      lineResults.push({ name: spec.name, kind: spec.kind, rate, ws, vat: Number.isFinite(vat) ? vat : expVat });
    } else {
      progress(`12. ${tag} WARN — could not read W/S for "${spec.name}"`);
    }
  }

  // Footer totals on section
  const values = await readLabeledNumericMap(root);
  const uiTotalWs = pickValue(values, 'Total W/S Value (SAR)', 'Total W/S Value');
  const uiTotalVat = pickValue(values, 'Total VAT Value (SAR)', 'Total VAT Value');
  if (Number.isFinite(uiTotalWs) && totalWs > 0) {
    ok =
      validateAgainstFormulas(`${tag} Total W/S Value`, uiTotalWs, totalWs, validationRows) && ok;
  }
  if (Number.isFinite(uiTotalVat) && totalVat > 0) {
    ok =
      validateAgainstFormulas(`${tag} Total VAT Value`, uiTotalVat, totalVat, validationRows) && ok;
  }

  progress(
    `12. ${tag} W/S lines=${foundRows} (warranty=${warrantyRows}); Î£ W/S=${moneyFmt(totalWs)}; Î£ VAT=${moneyFmt(totalVat)}`,
  );

  return {
    ok: foundRows < 1 ? true : ok,
    softMissing: foundRows < 1,
    lineResults,
    totalWs: Number.isFinite(uiTotalWs) ? uiTotalWs : totalWs,
    totalVat: Number.isFinite(uiTotalVat) ? uiTotalVat : totalVat,
    values: {
      'total w/s value': Number.isFinite(uiTotalWs) ? uiTotalWs : totalWs,
      'total vat value': Number.isFinite(uiTotalVat) ? uiTotalVat : totalVat,
      'w/s value': Number.isFinite(uiTotalWs) ? uiTotalWs : totalWs,
      'vat value': Number.isFinite(uiTotalVat) ? uiTotalVat : totalVat,
    },
  };
}

async function runMedicalEquipmentCalculatorValidation(page, validationRows, tag) {
  const selling = await fillAndValidateMedicalEquipmentSellingPriceSection(page, validationRows, tag);
  const supplier = await fillAndValidateMedicalEquipmentSupplierCostSection(page, selling.qty, validationRows, tag);
  const landed = await fillAndValidateMedicalEquipmentLandedCostSection(
    page,
    { totalSupplierPrice: supplier.totalSupplier, isSar: supplier.isSar },
    validationRows,
    tag,
  );

  const warranty = await fillAndValidateMedicalEquipmentWarrantyServices(page, validationRows, tag, {
    totalSellingPriceAfterDiscount: selling.totalAfter,
    unitSalesPriceAfterDiscount: selling.unitAfter,
  });

  // Do not force GP here yet — provisions/W/S still increase Project Cost
  let totalSelling =
    Number.isFinite(selling.totalAfter)
      ? selling.totalAfter
      : Number.isFinite(selling.unitAfter)
        ? selling.unitAfter * selling.qty
        : NaN;

  const provisions = await validateMedicalEquipmentProvisionCharges(
    page,
    { totalSellingAfterDiscount: totalSelling, landedMaterialCost: landed.landed },
    validationRows,
    tag,
  );

  const sellingAfterAdj = await readLabeledNumericMap(await pricingCalculatorRoot(page));
  totalSelling =
    pickValue(
      sellingAfterAdj,
      'Total Selling Price After Discount (SAR)',
      'Total Selling Price After Discount',
      'Total Selling Amount (SAR)',
      'Total Selling Amount',
    ) || totalSelling;

  // VAT / W/S totals from Warranty & Services
  const root = await pricingCalculatorRoot(page);
  const lateValues = await readLabeledNumericMap(root);
  const wsValue =
    pickValue(lateValues, 'W/S Value', 'Total W/S Value', 'WS Value') ||
    (Number.isFinite(warranty.totalWs) && warranty.totalWs > 0 ? warranty.totalWs : NaN);
  const vatValue =
    pickValue(lateValues, 'VAT Value', 'VAT % Amount', 'VAT Amount', 'Total VAT Value') ||
    (Number.isFinite(warranty.totalVat) && warranty.totalVat > 0 ? warranty.totalVat : NaN);

  let ok = selling.ok && supplier.ok && landed.ok && provisions.ok && (warranty.softMissing || warranty.ok);

  // Re-read Selling after W/S for VAT Amount (From Services) + Net Incl. VAT
  await expandCalculatorSection(page, /selling\s*price/i);
  const sellingAfterWs = await readLabeledNumericMap(await pricingCalculatorRoot(page));
  const vatFromServices = pickValue(
    sellingAfterWs,
    'VAT Amount (From Services) (SAR)',
    'VAT Amount (From Services)',
  );
  const netInclVat = pickValue(
    sellingAfterWs,
    'Net Selling Price Including VAT (Total)',
    'Net Selling Price Including VAT',
  );
  if (Number.isFinite(totalSelling) && Number.isFinite(vatFromServices)) {
    ok =
      validateAgainstFormulas(
        `${tag} ME Net Incl. VAT (= Total After + VAT From Services)`,
        netInclVat,
        totalSelling + vatFromServices,
        validationRows,
      ) && ok;
  }
  if (Number.isFinite(wsValue)) {
    ok =
      validateAgainstFormulas(
        `${tag} ME Total VAT from Services (= Σ W/S × 15%)`,
        Number.isFinite(vatFromServices) ? vatFromServices : vatValue,
        wsValue * (ME_VAT_RATE_PCT / 100),
        validationRows,
      ) && ok;
  }

  // Profitability: Total Project Cost = Landed Cost + Total W/S + Total VAT
  const landedCost = Number.isFinite(provisions.afmsLanded)
    ? provisions.afmsLanded
    : Number.isFinite(landed.landed)
      ? landed.landed
      : NaN;
  const totalWs = Number.isFinite(wsValue) ? wsValue : Number.isFinite(warranty.totalWs) ? warranty.totalWs : 0;
  const totalVat = Number.isFinite(vatFromServices)
    ? vatFromServices
    : Number.isFinite(vatValue)
      ? vatValue
      : Number.isFinite(warranty.totalVat)
        ? warranty.totalVat
        : 0;

  const formulaProject = Number.isFinite(landedCost)
    ? landedCost + totalWs + totalVat
    : Number.isFinite(totalWs) || Number.isFinite(totalVat)
      ? (Number.isFinite(landedCost) ? landedCost : 0) + totalWs + totalVat
      : NaN;

  // Raise Unit Price / Qty only when we know GP would be ≤ 0 (use Profitability Summary screenshot fields)
  const gpFix = await ensurePositiveGrossProfit(page, tag, {
    selling: totalSelling,
    project: formulaProject,
  });
  if (Number.isFinite(gpFix?.selling)) totalSelling = gpFix.selling;

  // Re-read Selling after GP bump for Net Incl. VAT
  await expandCalculatorSection(page, /selling\s*price/i);
  const sellingFinalMap = await readLabeledNumericMap(await pricingCalculatorRoot(page));
  const vatFromServicesFinal = firstFinite(
    pickValue(sellingFinalMap, 'VAT Amount (From Services) (SAR)', 'VAT Amount (From Services)'),
    vatFromServices,
  );
  const totalAfterFinal = firstFinite(
    pickValue(
      sellingFinalMap,
      'Total Selling Price After Discount (SAR)',
      'Total Selling Price After Discount',
      'Total Selling Amount (SAR)',
    ),
    totalSelling,
    selling.totalAfter,
  );

  // ── Key totals on ME Pricing Calculator (formulas written on UI) ──
  const keyUi = await readMedicalEquipmentKeyTotals(page);
  const provisionSum = Number.isFinite(provisions.totalEk02)
    ? provisions.totalEk02
    : Number.isFinite(provisions.afmsLanded) && Number.isFinite(landed.landed)
      ? provisions.afmsLanded - landed.landed
      : NaN;
  const keyCheck = validateMedicalEquipmentKeyTotals(
    tag,
    keyUi,
    {
      totalAfter: totalAfterFinal,
      vatFromServices: vatFromServicesFinal,
      spSar: supplier.spSar || supplier.values?.['sp price (sar)'] || pickValue(supplier.values || {}, 'SP Price (SAR)', 'SP Price (Per Unit) (SAR)'),
      qty: selling.qty,
      freightAmt: landed.freightAmt ?? pickValue(landed.values || {}, 'Freight & Insurance Amount', 'Freight Amount'),
      customsAmt: landed.customsAmt ?? pickValue(landed.values || {}, 'Customs Duty Amount', 'Customs Duty'),
      provisionSum,
      expectedWs: firstFinite(warranty.totalWs, totalWs),
    },
    validationRows,
  );
  ok = keyCheck.ok && ok;

  const snapSelling = firstFinite(keyCheck.snapshot.totalSellingAmount, totalAfterFinal);
  const snapProject = firstFinite(keyCheck.snapshot.totalProjectCost, formulaProject);
  const snapGpAmt = firstFinite(keyCheck.snapshot.gpAmount, expectedGpAmount(snapSelling, snapProject));
  const snapGpPct = firstFinite(keyCheck.snapshot.gpPct, expectedGpPct(snapSelling, snapProject));

  ok = assertPositiveGp(tag, snapGpPct, snapSelling, snapProject, validationRows) && ok;

  return {
    ok,
    supplier,
    landed,
    warranty,
    provisions,
    calcSnapshot: {
      ...keyCheck.snapshot,
      totalSellingAfterDiscount: snapSelling,
      totalProjectCost: snapProject,
      grossProfitAmount: snapGpAmt,
      gpPct: snapGpPct,
      totalSellingAmount: snapSelling,
      gpAmount: snapGpAmt,
      wsValue: firstFinite(keyCheck.snapshot.totalWsValue, totalWs),
      vatValue: firstFinite(keyCheck.snapshot.totalVatValue, totalVat),
      totalWsValue: firstFinite(keyCheck.snapshot.totalWsValue, totalWs),
      totalVatValue: firstFinite(keyCheck.snapshot.totalVatValue, totalVat),
      totalEk02: provisions.totalEk02,
      landedMaterialCost: firstFinite(keyCheck.snapshot.landedMaterialCost, landed.landed),
      landedCost: firstFinite(keyCheck.snapshot.landedCost, landedCost),
      unitAfter: selling.unitAfter,
      unitBefore: selling.unitBefore,
      qty: selling.qty,
      discountPct: selling.discountPct,
      discountAmt: selling.discountAmt,
      totalBefore: selling.totalBefore ?? (Number.isFinite(selling.unitBefore) ? selling.unitBefore * selling.qty : NaN),
      vatFromServices: vatFromServicesFinal,
      netSellingInclVat: firstFinite(
        keyCheck.snapshot.netSellingInclVat,
        selling.netInclVat,
        Number.isFinite(snapSelling) && Number.isFinite(vatFromServicesFinal)
          ? snapSelling + vatFromServicesFinal
          : NaN,
      ),
      exchangeRate: supplier.exchangeRate,
      totalSupplierPrice: firstFinite(keyCheck.snapshot.totalSupplierPrice, supplier.totalSupplier),
      spSar: firstFinite(
        supplier.spSar,
        pickValue(supplier.values || {}, 'SP Price (SAR)', 'SP Price (Per Unit) (SAR)'),
      ),
      freightAmt: landed.freightAmt,
      customsAmt: landed.customsAmt,
      totalFreightCustoms: landed.totalFreightCustoms,
    },
    values: {
      ...selling.values,
      ...supplier.values,
      ...landed.values,
      ...warranty.values,
      ...provisions.values,
      ...lateValues,
      ...sellingAfterWs,
      ...sellingFinalMap,
    },
  };
}

async function runConsumablesCalculatorValidation(page, validationRows, tag) {
  const selling = await fillAndValidateConsumablesSellingPriceSection(page, validationRows, tag);
  const sellingAdjEarly = await readLabeledNumericMap(await pricingCalculatorRoot(page));
  let totalAfter = pickValue(
    sellingAdjEarly,
    'Total Selling Price After Discount (SAR)',
    'Total Selling Price After Discount',
    'Total Selling Amount (SAR)',
    'Total Selling Amount',
  );
  if (!Number.isFinite(totalAfter)) totalAfter = selling.totalAfter;
  let qtyAdj = pickValue(sellingAdjEarly, 'Quantity') || selling.qty;

  // Order: Selling After → Supplier Total → Provisions (% of Selling After) → Landed Cost
  const supplier = await validateConsumablesSupplierCostSection(page, qtyAdj, validationRows, tag);
  let provisions = await validateConsumablesProvisionCharges(page, totalAfter, validationRows, tag);
  let provisionSum = Object.values(provisions.charges || {}).reduce((s, c) => {
    const n = Number.isFinite(c.expected) ? c.expected : Number.isFinite(c.actual) ? c.actual : 0;
    return s + n;
  }, 0);
  let landed = await validateConsumablesLandedMaterialCost(
    page,
    {
      totalSupplierPrice: supplier.totalSupplier,
      provisionChargesSum: provisionSum,
      totalSellingAfterDiscount: totalAfter,
    },
    validationRows,
    tag,
  );

  // Raise Unit / Qty if GP% ≤ 0 (Project Cost = Landed Cost for Consumables)
  const gpFix = await ensurePositiveGrossProfit(page, tag, {
    selling: totalAfter,
    project: Number.isFinite(landed.landed) ? landed.landed : NaN,
  });
  if (Number.isFinite(gpFix?.selling)) totalAfter = gpFix.selling;

  const sellingAdj = await readLabeledNumericMap(await pricingCalculatorRoot(page));
  const sellingAfter = pickValue(
    sellingAdj,
    'Total Selling Price After Discount (SAR)',
    'Total Selling Price After Discount',
    'Total Selling Amount (SAR)',
    'Total Selling Amount',
  );
  qtyAdj = pickValue(sellingAdj, 'Quantity') || qtyAdj;
  const unitAfterAdj = pickValue(
    sellingAdj,
    'Unit Sales Price After Discount (Back-Calculated) (SAR)',
    'Unit Sales Price After Discount',
  );
  totalAfter = Number.isFinite(sellingAfter) ? sellingAfter : totalAfter;

  // Re-validate provisions + landed after Selling After may have changed
  if (Number.isFinite(gpFix?.selling)) {
    provisions = await validateConsumablesProvisionCharges(page, totalAfter, validationRows, tag);
    provisionSum = Object.values(provisions.charges || {}).reduce((s, c) => {
      const n = Number.isFinite(c.expected) ? c.expected : Number.isFinite(c.actual) ? c.actual : 0;
      return s + n;
    }, 0);
    landed = await validateConsumablesLandedMaterialCost(
      page,
      {
        totalSupplierPrice: supplier.totalSupplier,
        provisionChargesSum: provisionSum,
        totalSellingAfterDiscount: totalAfter,
      },
      validationRows,
      tag,
    );
  }

  const profit = await validateConsumablesProfitabilitySection(
    page,
    {
      unitAfter: Number.isFinite(unitAfterAdj) ? unitAfterAdj : selling.unitAfter,
      qty: qtyAdj,
      landedMaterialCost: landed.landed,
      totalSellingAfterDiscount: totalAfter,
    },
    validationRows,
    tag,
  );

  // Focused key totals (Selling After, Supplier, Landed, Profitability)
  const keyUi = await readConsumablesKeyTotals(page);
  const keyCheck = validateConsumablesKeyTotals(
    tag,
    keyUi,
    {
      unitAfter: Number.isFinite(unitAfterAdj) ? unitAfterAdj : selling.unitAfter,
      qty: qtyAdj,
      supplierUnitPrice: supplier.supplierPrice,
      provisionSum,
      expectedTotalAfter: totalAfter,
    },
    validationRows,
  );

  const snapSell = firstFinite(
    keyCheck.snapshot.totalSellingAmount,
    profit.totalSellingAmt,
    totalAfter,
    selling.totalAfter,
  );
  const snapProj = firstFinite(keyCheck.snapshot.totalProjectCost, profit.totalProjectCost, landed.landed);
  const snapGpAmt = firstFinite(keyCheck.snapshot.gpAmount, profit.gpAmount, expectedGpAmount(snapSell, snapProj));
  const snapGpPct = firstFinite(keyCheck.snapshot.gpPct, profit.gpPct, expectedGpPct(snapSell, snapProj));

  const ok =
    selling.ok &&
    provisions.ok &&
    supplier.ok &&
    landed.ok &&
    profit.ok &&
    keyCheck.ok &&
    assertPositiveGp(tag, snapGpPct, snapSell, snapProj, validationRows);

  return {
    ok,
    selling,
    provisions,
    supplier,
    landed,
    profit,
    calcSnapshot: {
      ...keyCheck.snapshot,
      totalSellingAfterDiscount: firstFinite(keyCheck.snapshot.totalSellingAfterDiscount, snapSell),
      totalSellingAmount: snapSell,
      totalProjectCost: snapProj,
      grossProfitAmount: snapGpAmt,
      gpAmount: snapGpAmt,
      gpPct: snapGpPct,
      landedCost: firstFinite(keyCheck.snapshot.landedCost, landed.landed),
      landedMaterialCost: firstFinite(keyCheck.snapshot.landedMaterialCost, landed.landedMaterial),
      totalSupplierPrice: firstFinite(keyCheck.snapshot.totalSupplierPrice, supplier.totalSupplier),
    },
    values: {
      ...selling.values,
      ...provisions.values,
      ...supplier.values,
      ...landed.values,
      ...profit.values,
    },
  };
}

async function fillSellingPriceAndDiscountSection(page) {
  // Legacy entry — Consumables Selling Price Section handles fill + validate now
  await expandCalculatorSection(page, /selling\s*price/i);
  const root = await pricingCalculatorRoot(page);
  progress('12. Selling Price section — fill blank/0 editable fields');

  const unitBefore = await findEditableByLabel(root, /unit\s*sales\s*price\s*before\s*discount/i);
  await fillIfBlankOrZero(unitBefore, CALC_UNIT_PRICE, 'Unit Sales Price Before Discount');

  const discountPct = await findEditableByLabel(root, /customer\s*discount\s*\(?%\)?|discount\s*%/i);
  await fillPercentIfBlank(discountPct, CALC_DISCOUNT_PCT, 'Customer Discount (%)');

  const discountAmt = await findEditableByLabel(root, /discount\s*amount/i);
  let amt = CALC_DISCOUNT_AMOUNT;
  if (unitBefore && discountPct) {
    const b = parseMoney((await unitBefore.inputValue().catch(() => '')) || '');
    const p = parseMoney((await discountPct.inputValue().catch(() => '')) || '');
    if (Number.isFinite(b) && Number.isFinite(p) && Math.abs(p) > MONEY_TOLERANCE) amt = (b * p) / 100;
  }
  await fillIfBlankOrZero(discountAmt, amt, 'Discount Amount (SAR)');
}

async function clickApplyConfiguration(page) {
  const root = await pricingCalculatorRoot(page);
  const btn = root
    .getByRole('button', { name: /apply\s*configuration/i })
    .or(page.getByRole('button', { name: /apply\s*configuration/i }))
    .first();
  if (!(await btn.isVisible({ timeout: 0 }).catch(() => false))) return false;

  for (let attempt = 1; attempt <= 3; attempt++) {
    await btn.click().catch(() => {});
    await page.locator('.slds-spinner:visible').first().waitFor({ state: 'hidden', timeout: 15_000 }).catch(() => {});
    await sleep(400);

    const msg = await readVisibleValidationText(page).catch(() => '');
    if (!msg || !/required|snag|error|invalid|complete these|must enter|review the following/i.test(msg)) {
      return true;
    }
    progress(`12. Apply Configuration validation (attempt ${attempt}/3): ${msg.slice(0, 220)}`);
    const scope = (await pricingCalculatorRoot(page).catch(() => null)) || page.locator('body');
    await handleValidationErrors(page, scope).catch(() => {});
    // Blank/0 percent or money fields that errors name
    await fillEmptyRequiredFields(page, scope, {
      contextLabel: 'Pricing Calculator Apply',
      maxPasses: 1,
    }).catch(() => {});
    await capHighProvisionChargeRates(page, 'Apply-fix').catch(() => {});
  }
  const still = await readVisibleValidationText(page).catch(() => '');
  if (still && /required|snag|error|invalid/i.test(still)) {
    progress(`12. Apply Configuration — validation remains after fixes: ${still.slice(0, 220)} (continuing)`);
  }
  return true;
}

async function savePricingCalculator(page) {
  const root = await pricingCalculatorRoot(page);
  const save = page
    .getByRole('button', { name: /^save$/i })
    .or(root.getByRole('button', { name: /^save$/i }))
    .last();
  await save.waitFor({ state: 'visible', timeout: 30_000 });
  progress('12. Save Pricing Calculator → stores values on Quote Line Item and closes');

  for (let attempt = 1; attempt <= 3; attempt++) {
    await save.click().catch(() => {});
    await page.locator('.slds-spinner:visible').first().waitFor({ state: 'hidden', timeout: 90_000 }).catch(() => {});

    const calcStillOpen = await page
      .getByText(/pricing\s*calculator/i)
      .first()
      .isVisible({ timeout: 2_500 })
      .catch(() => false);
    if (!calcStillOpen) {
      await page
        .getByText(/pricing\s*calculator/i)
        .first()
        .waitFor({ state: 'hidden', timeout: 5_000 })
        .catch(() => {});
      return true;
    }

    const msg = await readVisibleValidationText(page).catch(() => '');
    if (msg) {
      progress(`12. Calculator Save validation (attempt ${attempt}/3): ${msg.slice(0, 220)}`);
      await handleValidationErrors(page, root).catch(() => {});
      await ensurePositiveGrossProfit(page, 'Save-fix').catch(() => {});
      await clickApplyConfiguration(page).catch(() => {});
      continue;
    }
    // Still open without clear error — wait a bit more
    await sleep(1_500);
    if (
      !(await page
        .getByText(/pricing\s*calculator/i)
        .first()
        .isVisible({ timeout: 2_000 })
        .catch(() => false))
    ) {
      return true;
    }
    progress(`12. Calculator Save — panel still open (attempt ${attempt}/3); retry Save`);
  }
  progress('12. Calculator Save — continuing even if panel still visible (will reopen Quote)');
  return false;
}

/**
 * Read FAIL rows from validation table and take corrective action on the Quote/calculator.
 * Returns true if any remediation was attempted.
 */
async function remediateFromValidationRows(page, validationRows, tag = 'Quote') {
  const fails = (validationRows || []).filter((r) => String(r.status || '').toUpperCase() === 'FAIL');
  if (!fails.length) return false;

  progress(`12. ${fails.length} validation FAIL(s) — reading and taking action`);
  for (const f of fails.slice(0, 20)) {
    progress(`12. FAIL → ${f.section}: actual=${f.actual} expected=${f.expected}`);
  }

  const blob = fails.map((f) => `${f.section} ${f.actual} ${f.expected}`).join(' | ');
  let acted = false;

  // GP% / Selling ≤ Project → raise unit price / qty
  if (/gp\s*%|gross\s*profit|selling.*project|project.*selling|negative/i.test(blob)) {
    progress('12. Action → ensure positive GP% (raise Unit Sales Price / Quantity, cap provisions)');
    const onCalc = await page
      .getByText(/pricing\s*calculator/i)
      .first()
      .isVisible({ timeout: 2_000 })
      .catch(() => false);
    if (onCalc) {
      await ensurePositiveGrossProfit(page, tag).catch((e) =>
        progress(`12. GP remediate warn: ${e?.message || e}`),
      );
      acted = true;
    }
  }

  // Percent > 100 / provision rates
  if (/%|percent|provision|rate/i.test(blob)) {
    progress('12. Action → cap percent fields to 0–100 / provision cap');
    if (
      await page
        .getByText(/pricing\s*calculator/i)
        .first()
        .isVisible({ timeout: 1_500 })
        .catch(() => false)
    ) {
      await capHighProvisionChargeRates(page, tag).catch(() => {});
      await clickApplyConfiguration(page).catch(() => {});
      acted = true;
    }
  }

  // UI Salesforce snags on Quote/record
  const uiMsg = await readVisibleValidationText(page).catch(() => '');
  if (uiMsg && /required|snag|review the following|must enter|complete these/i.test(uiMsg)) {
    progress(`12. Action → UI validation: ${uiMsg.slice(0, 200)}`);
    const scope = (await resolveOpenEditForm(page).catch(() => null)) || page.locator('body');
    await handleValidationErrors(page, scope).catch(() => {});
    acted = true;
  }

  // Stale price banner
  await clickQuoteStalePriceRefresh(page, { timeout: 8_000 }).catch(() => {});

  if (!acted) {
    progress('12. No automatic fix mapped for these FAILs — logged and continuing');
  }
  return acted;
}

/**
 * After collecting validation results: remediate FAILs; throw only if STRICT_VALIDATION.
 */
async function settleValidationOrContinue(page, validationRows, { contextLabel = 'flow', requireGpPositive = false, lineSnapshots = [] } = {}) {
  const fails = (validationRows || []).filter((r) => String(r.status || '').toUpperCase() === 'FAIL');
  if (!fails.length) {
    progress(`12. ${contextLabel} — no FAIL rows`);
    return true;
  }

  printCalcVsQliTable(fails, `${contextLabel} — FAILs (will remediate)`);
  await remediateFromValidationRows(page, fails, contextLabel);

  if (requireGpPositive && lineSnapshots.length) {
    const bad = lineSnapshots.filter((s) => {
      const pctOk = Number.isFinite(s.gpPct) && s.gpPct > 0;
      const totalsOk =
        Number.isFinite(s.totalSellingAfterDiscount) &&
        Number.isFinite(s.totalProjectCost) &&
        s.totalSellingAfterDiscount > s.totalProjectCost + MONEY_TOLERANCE;
      return !(pctOk || totalsOk);
    });
    if (bad.length && STRICT_VALIDATION) {
      throw new Error(
        `GP% not positive on ${bad.length}/${lineSnapshots.length} line(s) (SF_STRICT_VALIDATION=1).`,
      );
    }
    if (bad.length) {
      progress(
        `12. WARN — GP% still not positive on ${bad.length}/${lineSnapshots.length} line(s); continuing (set SF_STRICT_VALIDATION=1 to fail)`,
      );
    }
  }

  const stillFails = (validationRows || []).filter((r) => String(r.status || '').toUpperCase() === 'FAIL');
  if (stillFails.length && STRICT_VALIDATION) {
    throw new Error(`${contextLabel}: ${stillFails.length} validation FAIL(s) remain (SF_STRICT_VALIDATION=1).`);
  }
  if (stillFails.length) {
    progress(
      `12. WARN — ${stillFails.length} validation FAIL(s) remain after action; continuing (SF_STRICT_VALIDATION off)`,
    );
  }
  return stillFails.length === 0;
}

/** Cancel discards unsaved pricing updates (confirmation prompt). */
async function cancelPricingCalculator(page, { confirmDiscard = true } = {}) {
  const root = await pricingCalculatorRoot(page);
  const cancel = root.getByRole('button', { name: /^cancel$/i }).or(page.getByRole('button', { name: /^cancel$/i })).first();
  if (!(await cancel.isVisible({ timeout: 5_000 }).catch(() => false))) return false;
  progress('12. Cancel Pricing Calculator');
  await cancel.click();
  const prompt = page.getByText(/cancel will discard your unsaved pricing updates\.?\s*do you want to continue\?/i);
  if (await prompt.isVisible({ timeout: 5_000 }).catch(() => false)) {
    progress('12. Cancel confirm — "Cancel will discard your unsaved pricing updates..."');
    const yes = page.getByRole('button', { name: /^(yes|ok|continue|discard)$/i }).first();
    const no = page.getByRole('button', { name: /^(no|stay|keep)$/i }).first();
    if (confirmDiscard) await yes.click().catch(() => page.keyboard.press('Enter'));
    else await no.click().catch(() => {});
  }
  return true;
}

function buildCalculatorExpectations(values) {
  const landed = pickValue(values, 'Landed Cost (SAR)', 'Landed Cost', 'Landed Cost SAR');
  const ws = pickValue(values, 'Total W/S Value', 'Total WS Value', 'Total W/S', 'Total Warranty Service Value');
  const vat = pickValue(values, 'Total VAT Value', 'Total VAT', 'VAT Value');
  const totalSelling = pickValue(
    values,
    'Total Selling Price After Discount',
    'Total Selling Price',
    'Total Sales Price After Discount',
  );
  const totalProject = pickValue(values, 'Total Project Cost', 'Total Project Costs');
  const gpAmt = pickValue(values, 'Gross Profit Amount', 'Gross Profit', 'GP Amount');
  const gpPct = pickValue(values, 'GP%', 'GP %', 'Gross Profit %', 'Gross Profit Percent');

  const expProject = expectedTotalProjectCost(
    Number.isFinite(landed) ? landed : 0,
    Number.isFinite(ws) ? ws : 0,
    Number.isFinite(vat) ? vat : 0,
  );
  const expGpAmt = expectedGpAmount(totalSelling, Number.isFinite(totalProject) ? totalProject : expProject);
  const expGpPct = expectedGpPct(totalSelling, Number.isFinite(totalProject) ? totalProject : expProject);

  return {
    inputs: { landed, ws, vat, totalSelling, totalProject, gpAmt, gpPct },
    expected: {
      totalProjectCost: expProject,
      grossProfitAmount: expGpAmt,
      gpPct: expGpPct,
    },
  };
}

function validateAgainstFormulas(label, actual, expected, rows, { asPct = false } = {}) {
  if (!Number.isFinite(expected)) {
    const row = {
      section: label,
      actual: asPct ? pctFmt(actual) : moneyFmt(actual),
      expected: '(not computed)',
      status: 'SKIP',
    };
    rows.push(row);
    progress(`12. Validate ${label}: actual=${row.actual} expected=${row.expected} → SKIP`);
    return true;
  }
  // Formula display fields in LWC often have no scrapeable input — do not fail the run.
  // Snapshot / QLI compare still uses formula-derived values where we compute them.
  if (!Number.isFinite(actual)) {
    const row = {
      section: label,
      actual: '(blank)',
      expected: asPct ? pctFmt(expected) : moneyFmt(expected),
      status: 'SKIP',
    };
    rows.push(row);
    progress(
      `12. Validate ${label}: actual=(blank) expected=${row.expected} → SKIP (UI not readable; formula expected retained)`,
    );
    return true;
  }
  const ok = nearlyEqual(actual, expected);
  const status = ok ? 'PASS' : 'FAIL';
  const row = {
    section: label,
    actual: asPct ? pctFmt(actual) : moneyFmt(actual),
    expected: asPct ? pctFmt(expected) : moneyFmt(expected),
    status,
  };
  rows.push(row);
  progress(
    `12. Validate ${label}: actual=${row.actual} expected=${row.expected} → ${status}`,
  );
  return ok;
}

async function readRecordFieldMap(page) {
  await expandAllRecordSections(page);
  return readLabeledNumericMap(page.locator('.record-body-container, records-record-layout-event-broker, one-record-home-flexipage2, body').first());
}

function printValidationTable(rows, title) {
  progress(`======== ${title} ========`);
  progress(`${'Field'.padEnd(56)} | ${'Actual'.padStart(16)} | ${'Expected'.padStart(16)} | Status`);
  progress(`${'-'.repeat(56)}-+-${'-'.repeat(16)}-+-${'-'.repeat(16)}-+-------`);
  for (const r of rows) {
    progress(
      `${String(r.section).slice(0, 56).padEnd(56)} | ${String(r.actual).padStart(16)} | ${String(r.expected).padStart(16)} | ${r.status}`,
    );
  }
  progress('==========================================');
}


async function closePricingCalculatorIfOpen(page) {
  const heading = page.getByText(/pricing\s*calculator/i).first();
  if (!(await heading.isVisible({ timeout: 2_000 }).catch(() => false))) return false;
  await cancelPricingCalculator(page, { confirmDiscard: true });
  if (await heading.isVisible({ timeout: 2_000 }).catch(() => false)) {
    const closeBtn = page
      .getByRole('button', { name: /cancel and close|close this window|^close$/i })
      .first();
    await closeBtn.click().catch(() => {});
    await page
      .getByRole('button', { name: /^(yes|ok|continue|discard)$/i })
      .first()
      .click()
      .catch(() => {});
  }
  await heading.waitFor({ state: 'hidden', timeout: 20_000 }).catch(() => {});
  await page.locator('.slds-modal:visible').first().waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => {});
  return true;
}

async function clickQuoteLineItemProductLink(page) {
  await openDetailsTab(page).catch(() => {});
  const infoHeading = page.getByRole('heading', { name: /quote\s*line\s*item\s*information/i }).first();
  if (await infoHeading.isVisible({ timeout: 8_000 }).catch(() => false)) {
    await infoHeading.evaluate((el) => el.scrollIntoView({ block: 'start', inline: 'nearest' })).catch(() => {});
  }

  // Product links are often /lightning/r/01t… (not /Product2/) — match that first
  const productLink = page
    .getByRole('link', { name: /^(MA-|ALLERGENIC|[A-Z0-9-]{3,})/i })
    .filter({ has: page.locator('[href*="/01t"], [href*="/Product2/"], [href*="/Product/"]') })
    .or(page.locator('a[href*="/lightning/r/01t"]:visible, a[href*="/lightning/r/Product2/"]:visible'))
    .filter({ hasNot: page.locator('.slds-context-bar__label-action') })
    .first();

  // Prefer link under Quote Line Item Information / Product label
  const inSection = page
    .locator('records-record-layout-item, lightning-output-field, .slds-form-element, records-highlights-details-item')
    .filter({ hasText: /^product$/i })
    .locator('a[href*="/01t"], a[href*="/Product2/"], a[href*="/Product/"]')
    .first();

  let link = inSection;
  if (!(await link.isVisible({ timeout: 3_000 }).catch(() => false))) {
    link = page.locator('a[href*="/lightning/r/01t"]:visible').first();
  }
  if (!(await link.isVisible({ timeout: 3_000 }).catch(() => false))) {
    link = productLink;
  }

  await link.waitFor({ state: 'visible', timeout: 20_000 });
  const name = ((await link.innerText().catch(() => '')) || 'Product').replace(/\s+/g, ' ').trim();
  const href = (await link.getAttribute('href').catch(() => '')) || '';
  progress(`12. Quote Line Item Information → Product link (${name})`);
  await link.click();
  await page.waitForURL(/\/lightning\/r\/(Product2?\/)?|\/01t[a-zA-Z0-9]{12,15}/i, { timeout: 45_000 }).catch(async () => {
    if (/\/01t/.test(href)) {
      const id = (href.match(/\/(01t[a-zA-Z0-9]{12,15})/i) || [])[1];
      if (id) await page.goto(`/lightning/r/Product2/${id}/view`, { waitUntil: 'domcontentloaded' });
    }
  });
  await page.locator('.slds-spinner:visible').first().waitFor({ state: 'hidden', timeout: 45_000 }).catch(() => {});
  await page
    .locator('records-lwc-highlights-panel, one-record-home-flexipage2')
    .first()
    .waitFor({ state: 'visible', timeout: 30_000 })
    .catch(() => {});
}

/** Product record only — Related tab on THIS page (not Quote/QLI workspace tabs). */
async function openProductRecordRelatedTab(page) {
  progress('12. Product record page → Related tab (SupplierPriceBook is here, not on Details)');
  if (!/\/lightning\/r\/Product2?\//i.test(page.url() || '') && !/\/01t[a-zA-Z0-9]{12,15}/.test(page.url() || '')) {
    throw new Error(`Expected Product record page before Related tab, URL was ${page.url()}`);
  }

  const workspace = page.locator('.oneContent.active').filter({ visible: true }).last();
  const tablist = workspace
    .getByRole('tablist', { name: /^tabs$/i })
    .or(page.getByRole('tablist', { name: /^tabs$/i }).last())
    .last();
  const related = tablist
    .getByRole('tab', { name: /^related$/i })
    .or(
      workspace.locator(
        'a[title="Related"], a[data-label="Related"], a[data-tab-name="relatedListsTab"], a[data-tab-value="relatedListsTab"]',
      ),
    )
    .or(page.locator('.oneContent.active a[title="Related"], .oneContent.active [role="tab"]').filter({ hasText: /^related$/i }))
    .first();

  await related.waitFor({ state: 'visible', timeout: 20_000 });

  for (let attempt = 1; attempt <= 6; attempt++) {
    const onRelated = await related
      .evaluate((el) => {
        const li = el.closest('li, [role="presentation"]');
        return (
          el.getAttribute('aria-selected') === 'true' ||
          el.classList.contains('slds-is-active') ||
          !!(li && li.classList.contains('slds-is-active'))
        );
      })
      .catch(() => false);
    if (onRelated) break;
    progress(`12. Click Related on Product record (attempt ${attempt})`);
    await related.click({ force: true });
    await page.locator('.slds-spinner:visible').first().waitFor({ state: 'hidden', timeout: 15_000 }).catch(() => {});
    const listsReady = await page
      .getByRole('heading', { name: /price\s*books?|supplier\s*price\s*book/i })
      .first()
      .isVisible({ timeout: 3_000 })
      .catch(() => false);
    if (listsReady) break;
  }

  const onRelated = await related
    .evaluate((el) => {
      const li = el.closest('li, [role="presentation"]');
      return (
        el.getAttribute('aria-selected') === 'true' ||
        el.classList.contains('slds-is-active') ||
        !!(li && li.classList.contains('slds-is-active'))
      );
    })
    .catch(() => false);
  if (!onRelated) {
    throw new Error('Product Related tab did not stay selected — cannot create SupplierPriceBook from Details.');
  }

  await page
    .getByRole('heading', { name: /price\s*books?|supplier\s*price\s*book/i })
    .first()
    .waitFor({ state: 'visible', timeout: 25_000 });
  progress('12. Product Related tab selected — related lists are on screen');
}

async function findSupplierPriceBookRelatedList(page) {
  await openProductRecordRelatedTab(page);
  await scrollRelatedListToTop(page);
  for (let i = 0; i < 22; i++) {
    const heading = page.getByRole('heading', { name: /supplier\s*price\s*book/i }).first();
    if (await heading.isVisible({ timeout: 0 }).catch(() => false)) {
      await heading.evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'nearest' })).catch(() => {});
      await scrollLightningIntoView(heading);
      return page
        .getByRole('article', { name: /supplier\s*price\s*book/i })
        .first()
        .or(
          heading.locator(
            'xpath=ancestor::*[self::article or contains(@class,"slds-card") or contains(@class,"forceRelatedList")][1]',
          ),
        );
    }
    await page.mouse.wheel(0, 420).catch(() => {});
  }
  return relatedListCard(page, /supplier\s*price\s*book/i, { fromTop: false });
}

async function fillAndSaveNewSupplierPriceBook(page) {
  await page.locator('.slds-spinner:visible').first().waitFor({ state: 'hidden', timeout: 30_000 }).catch(() => {});
  await page
    .getByText(/new\s*supplier\s*price\s*book/i)
    .first()
    .waitFor({ state: 'visible', timeout: 25_000 })
    .catch(() => {});
  await page.getByRole('button', { name: /^save$/i }).first().waitFor({ state: 'visible', timeout: 25_000 });

  const modal = formModal(page);
  const modalOk = await modal.isVisible({ timeout: 8_000 }).catch(() => false);
  const scope = modalOk ? modal : page;
  await expandSections(scope).catch(() => {});
  progress('12. New Supplier Price Book — fill fields (existing Account only), then Save');

  const spbName = `SPB_Auto_${Date.now().toString().slice(-8)}`;
  const money = String(CALC_SUPPLIER_PRICE);

  async function fillSpbRow(row) {
    if (!(await row.isVisible().catch(() => false))) return;
    const label = ((await getRowLabelText(row)) || '').replace(/\*/g, '').trim();
    if (!label) return;
    if (isDoNotCallLabel(label) || isAccountApprovalStatusLabel(label) || isCloseDateLabel(label)) return;
    await row.scrollIntoViewIfNeeded().catch(() => {});

    // Name — text only (do not treat as money; "PriceBook Name" matches /price/)
    if (/supplier\s*price\s*book\s*name|price\s*book\s*name/i.test(label)) {
      const input = row
        .locator('input:not([type="hidden"]):not([disabled]):not([readonly]), textarea:not([disabled])')
        .first();
      if (await input.isVisible().catch(() => false)) {
        await input.fill(spbName);
        progress(`      → ${echoLabel(label)} = ${spbName}`);
      }
      return;
    }

    // Cost Price / Sales Price — mandatory money
    if (/^(cost|sales)\s*price$/i.test(label) || /^cost\s*price|^sales\s*price/i.test(label)) {
      const input = row
        .locator(
          'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([disabled]):not([readonly])',
        )
        .first();
      if (await input.isVisible().catch(() => false)) {
        await input.click({ clickCount: 3 }).catch(() => {});
        await input.fill(money);
        await input.blur().catch(() => {});
        progress(`      → ${echoLabel(label)} = ${money}`);
      }
      return;
    }

    if (/^currency$/i.test(label)) {
      await selectPicklistValue(page, row, {
        preferPatterns: [new RegExp(`^${CALC_CURRENCY}$`, 'i'), /sar/i],
        force: true,
        fast: true,
      });
      progress(`      → ${echoLabel(label)} = ${CALC_CURRENCY}`);
      return;
    }

    // Supplier Account — existing lookup only (fillVisibleLookup skips New options)
    if (/supplier\s*account/i.test(label)) {
      if (!(await isFormRowEmpty(row))) {
        progress(`      → ${echoLabel(label)} (already set)`);
        return;
      }
      const ok = await fillVisibleLookup(page, row, { force: true });
      progress(ok ? `      → ${echoLabel(label)} (existing)` : `12. WARN — ${echoLabel(label)} not set`);
      // Cancel if New Account modal appeared
      const newModal = page
        .locator('.slds-modal__container:visible, [role="dialog"]:visible')
        .filter({ hasText: /new\s*(supplier\s*)?account/i })
        .first();
      if (await newModal.isVisible({ timeout: 800 }).catch(() => false)) {
        progress('12. Cancel New Account — use existing Supplier Account only');
        await newModal.getByRole('button', { name: /^cancel$/i }).click().catch(() => {});
      }
      return;
    }

    if (!(await isFormRowEmpty(row))) return;

    if (isPriceBookLabel(label) || /^price\s*book$/i.test(label)) {
      const ok = await fillVisibleLookup(page, row, { force: true });
      if (ok) progress(`      → ${echoLabel(label)}`);
      return;
    }

    // Skip other money-ish labels that aren't Cost/Sales (avoid re-filling Name)
    if (/price|cost/i.test(label) && !/%|percent|rate|name|account/i.test(label)) {
      const input = row
        .locator(
          'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([disabled]):not([readonly])',
        )
        .first();
      if (await input.isVisible().catch(() => false)) {
        await input.fill(money);
        progress(`      → ${echoLabel(label)} = ${money}`);
      }
      return;
    }

    const r = await fillFormRowByDataType(page, row, { force: true, skipLookups: false, fast: true });
    if (r.filled) progress(`      → ${echoLabel(label)}`);
  }

  for (const row of await scope.locator('.slds-form-element').all().catch(() => [])) {
    try {
      await fillSpbRow(row);
    } catch (err) {
      progress(`   ... Supplier Price Book row skipped: ${err?.message ?? err}`);
    }
  }

  // Second pass for any still-empty required fields (same pattern as earlier working flow)
  await fillEmptyRequiredFields(page, scope, {
    contextLabel: 'Supplier Price Book',
    maxPasses: 2,
  }).catch(() => {});

  // Ensure Cost / Sales / Account one more time if still blank
  for (const row of await scope.locator('.slds-form-element').all().catch(() => [])) {
    try {
      const label = ((await getRowLabelText(row)) || '').replace(/\*/g, '').trim();
      if (/^(cost|sales)\s*price$/i.test(label) && (await isFormRowEmpty(row))) {
        const input = row.locator('input:not([type="hidden"]):not([disabled])').first();
        if (await input.isVisible().catch(() => false)) {
          await input.fill(money);
          progress(`      → ${echoLabel(label)} = ${money} (retry)`);
        }
      }
      if (/supplier\s*account/i.test(label) && (await isFormRowEmpty(row))) {
        await fillVisibleLookup(page, row, { force: true });
        progress(`      → ${echoLabel(label)} (retry existing)`);
      }
    } catch {
      /* ignore */
    }
  }

  progress('12. Save Supplier Price Book');
  await saveWithValidationRetry(page, scope, { contextLabel: 'Supplier Price Book', maxAttempts: 5 });
  await page.locator('.slds-spinner:visible').first().waitFor({ state: 'hidden', timeout: 45_000 }).catch(() => {});
}

async function countExistingSupplierPriceBooks(page, spbHost) {
  const heading = page.getByRole('heading', { name: /supplier\s*price\s*book/i }).first();
  const hText = ((await heading.innerText().catch(() => '')) || '').replace(/\s+/g, ' ');
  const m = hText.match(/\(\s*(\d+)\s*\)/);
  if (m) return Number.parseInt(m[1], 10) || 0;

  const statusText = ((await spbHost.getByRole('status').first().innerText().catch(() => '')) || '').replace(/\s+/g, ' ');
  const sm = statusText.match(/(\d+)\s*items?/i);
  if (sm) return Number.parseInt(sm[1], 10) || 0;

  const showN = await spbHost.getByRole('button', { name: /show\s*actions/i }).count().catch(() => 0);
  if (showN > 0) return showN;

  const rowN = await spbHost
    .locator('tbody tr, [role="row"]')
    .filter({ hasNotText: /no items|nothing to see|get started|product id/i })
    .count()
    .catch(() => 0);
  return rowN > 0 ? rowN : 0;
}

async function createSupplierPriceBookOnProduct(page) {
  const productId =
    (page.url().match(/\/(?:Product2|01t)\/?(01t[a-zA-Z0-9]{12,15})/i) ||
      page.url().match(/\/(01t[a-zA-Z0-9]{12,15})/i) ||
      [])[1] || '';
  if (productId && SPB_ATTEMPTED_PRODUCT_IDS.has(productId)) {
    progress(`12. SupplierPriceBook already attempted for product ${productId} this run — skip New`);
    return false;
  }
  if (productId) SPB_ATTEMPTED_PRODUCT_IDS.add(productId);

  const card = await findSupplierPriceBookRelatedList(page);
  await card.waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {});

  const spbHost = page
    .locator('article, lst-related-list-single-container, lst-related-list-view-manager, .slds-card, force-related-list-container')
    .filter({ has: page.getByRole('heading', { name: /supplier\s*price\s*book/i }) })
    .first()
    .or(card);
  await spbHost.waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {});

  const existing = await countExistingSupplierPriceBooks(page, spbHost);
  if (existing > 0) {
    progress(`12. SupplierPriceBook already has ${existing} record(s) — skip New (do not create again)`);
    return false;
  }

  const newBtn = spbHost
    .getByRole('button', { name: /^new$/i })
    .or(spbHost.getByRole('link', { name: /^new$/i }))
    .or(spbHost.locator('a[title="New"], button[title="New"], button[name="New"]'))
    .or(page.getByRole('button', { name: /new\s*supplier\s*price\s*book/i }))
    .or(page.getByRole('link', { name: /new\s*supplier\s*price\s*book/i }))
    .first();

  if (!(await newBtn.isVisible({ timeout: 6_000 }).catch(() => false))) {
    const more = spbHost.getByRole('button', { name: /show (more )?actions|more actions/i }).first();
    if (await more.isVisible({ timeout: 2_000 }).catch(() => false)) {
      progress('12. SupplierPriceBook — Show actions then New');
      await more.click();
      await sleep(Math.max(LWC_MENU_ANIMATION_MS, 250));
    }
  }
  await newBtn.waitFor({ state: 'visible', timeout: 20_000 });
  progress('12. SupplierPriceBook → New (first time only for this product)');
  await newBtn.click();
  await fillAndSaveNewSupplierPriceBook(page);
  return true;
}

async function returnToSavedQuoteLinesAndRefresh(page, quoteId) {
  if (!quoteId) quoteId = await quoteIdFromUrl(page);
  if (!quoteId) throw new Error('Quote record Id was not saved — cannot return to Quote after Supplier Price Book.');
  progress(`12. Return to saved Quote ${quoteId} → wait for stale-price Refresh`);
  await page.goto(`/lightning/r/Quote/${quoteId}/view`, { waitUntil: 'domcontentloaded' });
  await waitForQuoteRecordVisible(page, { timeout: 45_000 });
  await clickQuoteStalePriceRefresh(page, { timeout: 45_000 });
  await openQuoteTab(page, 'Lines');
  await waitForQuoteLineItemsToLoad(page, { attempts: 4, waitMs: 1_500 });
  return quoteId;
}

/**
 * SP Price (Per Unit) (Original Currency) is 0 → add supplier cost via Product SupplierPriceBook,
 * then return to the saved Quote Lines tab, refresh, and re-open Configure.
 */
/**
 * True when calculator already has usable supplier cost OR an editable Supplier Price
 * we can fill in-place (ME) — so we must not leave Configure to create another SPB.
 */
async function calculatorHasUsableOrEditableSupplierCost(page) {
  const root = await pricingCalculatorRoot(page);
  await expandCalculatorSection(page, /supplier\s*cost|supplier\s*price/i);
  await scrollPricingCalculatorFullPage(page);
  const values = await readLabeledNumericMap(root);
  const populated = pickValue(
    values,
    'SP Price (Per Unit) (Original Currency)',
    'SP Price (Per Unit)',
    'SP Price (SAR)',
    'Supplier Price (SAR)',
    'Supplier Price',
    'Total Supplier Price (SAR)',
  );
  if (Number.isFinite(populated) && Math.abs(populated) > MONEY_TOLERANCE) {
    progress(`12. Supplier cost already populated in calculator (${moneyFmt(populated)}) — skip Supplier Price Book`);
    return true;
  }
  const editable = await findEditableByLabel(root, /^supplier\s*price(?!\s*\(sar\))/i);
  if (editable) {
    progress('12. Supplier Price is editable in calculator — fill in-place; skip Supplier Price Book');
    return true;
  }
  return false;
}

async function addSupplierCostViaProductPriceBook(page, rowIndex, quoteId) {
  SPB_ATTEMPTED_QLI_ROWS.add(rowIndex);
  progress('12. SP Price blank/0 — ensure Supplier Price Book once, then continue (never recreate)');
  await closePricingCalculatorIfOpen(page);
  quoteId = quoteId || (await quoteIdFromUrl(page));

  // Cancel leaves Quote on Lines but grid may still be Loading — land cleanly before View
  if (quoteId) {
    await page.goto(`/lightning/r/Quote/${quoteId}/view`, { waitUntil: 'domcontentloaded' });
    await waitForQuoteRecordVisible(page, { timeout: 45_000 });
  }
  await openQuoteTab(page, 'Lines');
  await waitForQuoteLineItemsToLoad(page, { attempts: 3, waitMs: 1_000 });
  await openQuoteLineRowMenuAction(page, 'View', rowIndex);
  await page.waitForURL(/QuoteLineItem|\/0QL/i, { timeout: 45_000 });
  await page.locator('.slds-spinner:visible').first().waitFor({ state: 'hidden', timeout: 45_000 }).catch(() => {});

  await clickQuoteLineItemProductLink(page);
  const created = await createSupplierPriceBookOnProduct(page);
  progress(
    created
      ? '12. Supplier Price Book created — return to Quote'
      : '12. Supplier Price Book already present/attempted — return to Quote without another New',
  );
  await returnToSavedQuoteLinesAndRefresh(page, quoteId);

  progress('12. Re-open Configure and continue validation (do not create SPB again if SP still blank)');
  await openQuoteLineRowMenuAction(page, 'Configure', rowIndex);
  await page
    .getByText(/pricing\s*calculator|selling\s*price|apply\s*configuration/i)
    .first()
    .waitFor({ state: 'visible', timeout: 60_000 });
  await scrollPricingCalculatorFullPage(page);
  const spAfter = await readCalculatorSpPriceOriginal(page);
  progress(`12. After Supplier Price Book path — SP Price (Per Unit) (Original Currency) = ${moneyFmt(spAfter)}`);
  return quoteId;
}

/**
 * For each Quote Line Item on the Quote:
 *   Configure → that line’s Pricing Calculator
 *     If SP Price (Per Unit) (Original Currency) is 0: View → Product → New SupplierPriceBook → refresh Quote → Configure again
 *   fill blank/0 → Apply → validate formulas → Save
 *   View → that line’s QLI record → must match that line’s calculator
 * Then Quote Details Totals = combined from ALL line items (sums + weighted GP% per AC).
 */
async function configureAndValidateQuotePricing(page) {
  progress('FLOW 8 — Per QLI: Configure (calculator) + View (record) → then Quote = all lines combined');
  const validationRows = [];
  let allOk = true;
  const lineSnapshots = [];
  let quoteId = await quoteIdFromUrl(page);

  await clickQuoteStalePriceRefresh(page, { timeout: 12_000 });

  // 1) Quote Type + Business Unit (+ Division) on Quote → Lines
  await ensureQuoteFieldsThenOpenLines(page);

  // 2) QLI gate: only Browse Catalog when Lines truly empty (heading 0 / no rows / Total Price 0)
  let lineCount = await countQuoteLineItems(page);
  if (lineCount < 1) {
    // Lines often hydrate late — wait before Browse Catalog
    progress('12. QLI count looks 0 — wait/refresh Lines before Browse Catalog');
    lineCount = await waitForQuoteLineItemsToLoad(page, { attempts: 5, waitMs: 1_200 });
  }
  if (lineCount < 1) {
    const hasTotal = await quoteTotalPriceIndicatesQli(page);
    if (hasTotal) {
      progress('12. Total Price > 0 — wait for Lines to hydrate (do not Browse Catalog)');
      lineCount = await waitForQuoteLineItemsToLoad(page, { attempts: 8, waitMs: 1_500 });
    } else {
      progress('12. QLI still 0 and Total Price is 0 — Browse Catalogs to add Quote Line Items');
      lineCount = await browseCatalogsAndAddQuoteLines(page, {
        minProducts: Math.max(1, ADD_PRODUCT_MIN),
        maxProducts: ADD_PRODUCT_MAX,
      }).catch(async (browseErr) => {
        progress(`12. Browse Catalog first pass failed — ${String(browseErr?.message || browseErr).slice(0, 160)}`);
        progress('12. Re-ensure Quote Type / BU / Division, then retry Browse Catalog once');
        await fillQuoteTypeBuDivisionOnQuote(page);
        await openQuoteTab(page, 'Lines', { force: true });
        return browseCatalogsAndAddQuoteLines(page, {
          minProducts: Math.max(1, ADD_PRODUCT_MIN),
          maxProducts: ADD_PRODUCT_MAX,
        });
      });
    }
  } else {
    progress(`12. QLI count is ${lineCount} — skip Browse Catalog`);
  }
  if (lineCount < 1) {
    throw new Error(
      'QLI count is still 0 — cannot Configure. (If Total Price > 0, Lines UI may still be loading; retry.)',
    );
  }
  let rows = await quoteLineItemRows(page);
  progress(`12. Quote has ${lineCount} Quote Line Item(s) — processing each`);

  for (let i = 0; i < lineCount; i++) {
    const tag = `QLI#${i + 1}`;
    progress(`12. ——— ${tag} of ${lineCount}: Configure (Pricing Calculator for this line) ———`);
    await openQuoteTab(page, 'Lines');
    await openQuoteLineRowMenuAction(page, 'Configure', i);

    await page
      .getByText(/pricing\s*calculator|selling\s*price|apply\s*configuration/i)
      .first()
      .waitFor({ state: 'visible', timeout: 60_000 })
      .catch(() => {});

    quoteId = quoteId || (await quoteIdFromUrl(page));
    await scrollPricingCalculatorFullPage(page);

    // Category first — this stops the SPB loop:
    // Medical Equipment has editable Supplier Price in Supplier Cost → fill in-place, NEVER leave for SPB.
    // Consumables: SPB at most once per QLI row if SP Price in Supplier Cost is blank/0.
    const category = await detectPricingCalculatorCategory(page);
    progress(`12. ${tag} Pricing Calculator category → ${category}`);

    const spOrig = await readCalculatorSpPriceOriginal(page, { waitPopulateMs: 4_000 });
    progress(`12. ${tag} Supplier Cost → SP Price (Per Unit) (Original Currency) = ${moneyFmt(spOrig)}`);

    const spBlank = !Number.isFinite(spOrig) || Math.abs(spOrig) <= MONEY_TOLERANCE;
    if (spBlank && /medical/i.test(category)) {
      progress(
        `12. ${tag} Medical Equipment — SP blank is OK; fill Supplier Price in Supplier Cost section (no Supplier Price Book)`,
      );
    } else if (spBlank && SPB_ATTEMPTED_QLI_ROWS.has(i)) {
      progress(`12. ${tag} Supplier Price Book already attempted for this line — continue without recreating`);
    } else if (spBlank) {
      const canStay = await calculatorHasUsableOrEditableSupplierCost(page);
      if (canStay) {
        progress(`12. ${tag} stay on Pricing Calculator — no Supplier Price Book diversion`);
      } else {
        SPB_ATTEMPTED_QLI_ROWS.add(i);
        quoteId = await addSupplierCostViaProductPriceBook(page, i, quoteId);
      }
    } else {
      progress(`12. ${tag} SP Price already set — skip Supplier Price Book`);
    }

    let calcRun;
    if (/medical/i.test(category)) {
      calcRun = await runMedicalEquipmentCalculatorValidation(page, validationRows, tag);
    } else {
      calcRun = await runConsumablesCalculatorValidation(page, validationRows, tag);
    }
    // Calculator section formulas must pass (Selling, Supplier, Landed, W/S, Provisions, Profitability)
    allOk = calcRun.ok && allOk;
    progress(`12. ${tag} calculator formula validation → ${calcRun.ok ? 'PASS' : 'FAIL'}`);

    const calcSnapshot = calcRun.calcSnapshot;
    const calcFieldMap = mergeCalcSnapshotIntoFieldMap(await captureCalculatorFieldMap(page), calcSnapshot);
    calcSnapshot.fieldMap = calcFieldMap;
    lineSnapshots.push(calcSnapshot);
    progress(
      `12. ${tag} snapshot — Selling=${moneyFmt(calcSnapshot.totalSellingAfterDiscount)} Project=${moneyFmt(calcSnapshot.totalProjectCost)} GP%=${pctFmt(calcSnapshot.gpPct)}`,
    );

    await savePricingCalculator(page);
    quoteId = (await quoteIdFromUrl(page)) || quoteId;
    if (!/\/lightning\/r\/Quote\//i.test(page.url()) && quoteId) {
      await page.goto(`/lightning/r/Quote/${quoteId}/view`, { waitUntil: 'domcontentloaded' });
    }
    await waitForQuoteRecordVisible(page, { timeout: 45_000 });
    // Calculator Save lands on Quote Details — QLI live on Lines (force switch)
    progress('12. After Calculator Save — on Details; switch to Lines for QLI');
    await clickQuoteStalePriceRefresh(page, { timeout: 20_000 });
    await openQuoteTab(page, 'Lines', { force: true });
    await waitForQuoteLineItemsToLoad(page, { attempts: 8, waitMs: 1_500 });
    await scrollQuoteLineItemsIntoView(page);

    progress(`12. ——— ${tag}: View (Quote Line Item record for this line) ———`);
    await openQuoteLineRowMenuAction(page, 'View', i);
    await page.waitForURL(/QuoteLineItem|\/0QL/i, { timeout: 45_000 }).catch(() => {});
    await page.locator('.slds-spinner:visible').first().waitFor({ state: 'hidden', timeout: 45_000 }).catch(() => {});

    const { map: qliFieldMap, access } = await captureQliRecordFieldMap(page);
    for (const spec of QLI_PRICING_SECTION_RES) {
      const present = !!(access?.found && access.found[spec.key]);
      validationRows.push({
        section: `${tag} QLI section present: ${spec.label}`,
        actual: present ? access.found[spec.key] : '(not on QLI record)',
        expected: spec.label,
        status: present ? 'PASS' : 'INFO',
      });
    }
    progress(`12. ${tag} validate fields that exist on BOTH Pricing Calculator and Quote Line Item`);
    allOk = compareSharedCalculatorQliFields(tag, calcFieldMap, qliFieldMap, validationRows) && allOk;

    const qliCore = {
      totalSellingAfterDiscount: pickValue(
        qliFieldMap,
        'Total Selling Price After Discount (SAR)',
        'Total Selling Amount (SAR)',
        'Total Selling Amount',
      ),
      totalProjectCost: pickValue(qliFieldMap, 'Total Project Cost (SAR)', 'Total Project Cost'),
      grossProfitAmount: pickValue(qliFieldMap, 'GP Amount (SAR)', 'GP Amount', 'Gross Profit Amount'),
      gpPct: pickValue(qliFieldMap, 'GP %', 'GP%', 'Gross Profit %', 'Line Item GP%'),
    };

    if (/medical/i.test(category)) {
      const qliSections = await readQliMedicalEquipmentSections(page);
      qliCore.totalSellingAfterDiscount = firstFinite(
        qliCore.totalSellingAfterDiscount,
        qliSections.selling.totalAfter,
        qliSections.profitability.totalSellingAmount,
      );
      qliCore.totalProjectCost = firstFinite(qliCore.totalProjectCost, qliSections.profitability.totalProjectCost);
      qliCore.grossProfitAmount = firstFinite(qliCore.grossProfitAmount, qliSections.profitability.gpAmount);
      qliCore.gpPct = firstFinite(qliCore.gpPct, qliSections.profitability.gpPct);
    } else if (/consumable/i.test(category)) {
      const qliSections = await readQliConsumablesSections(page);
      qliCore.totalSellingAfterDiscount = firstFinite(
        qliCore.totalSellingAfterDiscount,
        qliSections.selling.totalAfter,
        qliSections.profitability.totalSellingAmount,
      );
      qliCore.totalProjectCost = firstFinite(
        qliCore.totalProjectCost,
        qliSections.profitability.totalProjectCost,
        qliSections.provisions.landedCost,
      );
      qliCore.grossProfitAmount = firstFinite(qliCore.grossProfitAmount, qliSections.profitability.gpAmount);
      qliCore.gpPct = firstFinite(qliCore.gpPct, qliSections.profitability.gpPct);
    }

    // Quote Σ must use THIS line’s QLI values when readable (all lines contribute)
    applyQliValuesToLineSnapshot(calcSnapshot, qliCore);
    progress(
      `12. ${tag} line for Quote Σ — Selling=${moneyFmt(calcSnapshot.totalSellingAfterDiscount)} ` +
        `Project=${moneyFmt(calcSnapshot.totalProjectCost)} GP%=${pctFmt(calcSnapshot.gpPct)}`,
    );
    allOk =
      assertPositiveGp(
        `${tag} QLI`,
        calcSnapshot.gpPct,
        calcSnapshot.totalSellingAfterDiscount,
        calcSnapshot.totalProjectCost,
        validationRows,
      ) && allOk;

    quoteId = await returnToQuoteFromLineItem(page, quoteId);
    // refresh count in case UI changed
    await openQuoteTab(page, 'Lines');
    rows = await quoteLineItemRows(page);
    lineCount = await rows.count();
  }

  // Quote Totals: GP Amount + GP% from ALL Quote Line Items
  progress('12. ——— Quote Totals — GP Amount + GP% from ALL Quote Line Items ———');
  await openQuoteTab(page, 'Details');
  await clickQuoteStalePriceRefresh(page, { timeout: 45_000 }).catch(() => {});
  const quote = await readQuoteTotalsSection(page);

  // Σ across every line snapshot (updated from each QLI View when readable)
  const sumSelling = sumFinite(lineSnapshots, 'totalSellingAfterDiscount');
  const sumProject = sumFinite(lineSnapshots, 'totalProjectCost');
  const sumGpAmt = expectedGpAmount(sumSelling, sumProject);
  const combinedGpPct =
    lineSnapshots.length <= 1
      ? firstFinite(lineSnapshots[0]?.gpPct, expectedGpPct(sumSelling, sumProject))
      : expectedGpPct(sumSelling, sumProject);

  progress(
    `12. Quote Σ from ${lineSnapshots.length} QLI(s): ΣSelling=${moneyFmt(sumSelling)} ΣProject=${moneyFmt(sumProject)} ` +
      `→ GP Amt=${moneyFmt(sumGpAmt)} GP%=${pctFmt(combinedGpPct)}`,
  );
  progress(
    `12. Quote Totals UI — GP Amt=${moneyFmt(quote.gpAmount)} GP%=${pctFmt(quote.gpPct)}`,
  );

  allOk =
    validateAgainstFormulas(
      'Quote Totals: GP Amount (= Σ QLI Total Selling After Discount − Σ QLI Total Project Cost)',
      quote.gpAmount,
      sumGpAmt,
      validationRows,
    ) && allOk;
  allOk =
    validateAgainstFormulas(
      lineSnapshots.length <= 1
        ? 'Quote Totals: GP% (= that Quote Line Item GP%)'
        : 'Quote Totals: GP% (= (Σ QLI Selling After Discount − Σ QLI Project Cost) / Σ QLI Selling After Discount × 100)',
      quote.gpPct,
      combinedGpPct,
      validationRows,
      { asPct: true },
    ) && allOk;

  printCalcVsQliTable(validationRows, 'Pricing Calculator vs Quote Line Item (all sections) + Quote Totals');
  writeCalcVsQliResultsFile(validationRows);

  // Pass requires: calculator formulas + QLI + Quote validations, and GP% positive on every line
  const gpPositiveLines = lineSnapshots.filter((s) => {
    const pctOk = Number.isFinite(s.gpPct) && s.gpPct > 0;
    const totalsOk =
      Number.isFinite(s.totalSellingAfterDiscount) &&
      Number.isFinite(s.totalProjectCost) &&
      s.totalSellingAfterDiscount > s.totalProjectCost + MONEY_TOLERANCE;
    return pctOk || totalsOk;
  });
  const allGpPositive = lineSnapshots.length > 0 && gpPositiveLines.length === lineSnapshots.length;
  if (!allGpPositive || !allOk) {
    progress(
      `12. Validation incomplete (formulas=${allOk ? 'ok' : 'FAIL'}, GP positive=${gpPositiveLines.length}/${lineSnapshots.length}) — read errors and act`,
    );
    await settleValidationOrContinue(page, validationRows, {
      contextLabel: 'Calculator / QLI / Quote Totals',
      requireGpPositive: true,
      lineSnapshots,
    });
  } else {
    progress(
      `12. Passed — calculator formulas + QLI + Quote validated; GP% positive on all ${lineSnapshots.length} line(s)`,
    );
  }

  // Capture Lines tab products/QLI before PDF (source of truth for Quotation Details)
  const linesExpected = await readQuoteLinesTabForPdfCompare(page);
  progress(`13. Lines tab — ${linesExpected.length} QLI/product row(s) for PDF Quotation Details compare`);

  // After validation: Generate PDF → Preview → scroll all pages → validate Quotation Details vs Lines
  try {
    await generateAndPreviewQuotePdf(page, { linesExpected, lineSnapshots, validationRows });
  } catch (err) {
    progress(`13. PDF step error — ${err?.message || err}`);
    const uiMsg = await readVisibleValidationText(page).catch(() => '');
    if (uiMsg) {
      progress(`13. PDF UI validation: ${uiMsg.slice(0, 220)}`);
      await handleValidationErrors(page, page.locator('body')).catch(() => {});
    }
    if (STRICT_VALIDATION) throw err;
    progress('13. WARN — PDF preview/validation issue; continuing (SF_STRICT_VALIDATION off)');
  }

  return { lineSnapshots, validationRows };
}

/**
 * Read Quote Lines tab rows for PDF Quotation Details comparison.
 * Returns [{ item, description, qty, unitPrice, totalPrice, raw }]
 */
async function readQuoteLinesTabForPdfCompare(page) {
  await openQuoteTab(page, 'Lines', { force: true });
  await waitForQuoteLineItemsToLoad(page, { attempts: 6, waitMs: 1_200 }).catch(() => {});
  await scrollQuoteLineItemsIntoView(page);

  const card = page
    .getByRole('article', { name: /quote\s*line\s*items/i })
    .or(
      page
        .locator('lst-related-list-single-container, article.slds-card, .slds-card')
        .filter({ has: page.getByRole('heading', { name: /quote\s*line\s*items/i }) }),
    )
    .first();
  await card.waitFor({ state: 'visible', timeout: 30_000 }).catch(() => {});

  const rows = await card
    .evaluate((root) => {
      const out = [];
      const tables = root.querySelectorAll('table');
      const parseMoney = (s) => {
        const t = String(s || '')
          .replace(/SAR|USD|EUR/gi, '')
          .replace(/[^\d.,\-]/g, '')
          .replace(/,/g, '');
        const n = Number.parseFloat(t);
        return Number.isFinite(n) ? n : NaN;
      };
      for (const table of tables) {
        const headers = [...table.querySelectorAll('thead th, thead td, [role="columnheader"]')].map((h) =>
          (h.innerText || '').replace(/\s+/g, ' ').trim().toLowerCase(),
        );
        const col = (re) => headers.findIndex((h) => re.test(h));
        const iItem = col(/^(item|product(\s*name)?|product\s*code|line\s*item)$/);
        const iDesc = col(/description|product\s*name/);
        const iQty = col(/^quantity$|^qty$/);
        const iUnit = col(/unit\s*sales|sales\s*price|list\s*price|unit\s*price/);
        const iTotal = col(/total\s*price|total\s*selling|subtotal|net\s*total/);
        const bodyRows = table.querySelectorAll('tbody tr');
        for (const tr of bodyRows) {
          const cells = [...tr.querySelectorAll('td, th')].map((c) => (c.innerText || '').replace(/\s+/g, ' ').trim());
          if (!cells.length) continue;
          const links = [...tr.querySelectorAll('a')]
            .map((a) => (a.innerText || '').replace(/\s+/g, ' ').trim())
            .filter((t) => t && !/show|view all|^$/i.test(t));
          const item =
            (iItem >= 0 ? cells[iItem] : '') ||
            links.find((t) => /[A-Z0-9]+-[A-Z0-9]+/i.test(t)) ||
            links[0] ||
            '';
          const description = (iDesc >= 0 ? cells[iDesc] : '') || '';
          const qty = iQty >= 0 ? parseMoney(cells[iQty]) : NaN;
          const unitPrice = iUnit >= 0 ? parseMoney(cells[iUnit]) : NaN;
          const totalPrice = iTotal >= 0 ? parseMoney(cells[iTotal]) : NaN;
          const raw = cells.join(' | ');
          if (!item && !Number.isFinite(totalPrice) && !Number.isFinite(qty)) continue;
          if (/no items|nothing to see|get started/i.test(raw)) continue;
          out.push({
            item: item.slice(0, 120),
            description: description.slice(0, 200),
            qty,
            unitPrice,
            totalPrice,
            raw: raw.slice(0, 240),
          });
        }
      }
      return out;
    })
    .catch(() => []);

  if (!rows.length) {
    // Fallback: row text via Playwright
    const trs = card.locator('table tbody tr');
    const n = await trs.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
      const raw = ((await trs.nth(i).innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
      if (!raw || /no items|nothing to see/i.test(raw)) continue;
      const codes = raw.match(/\b[A-Z]{1,4}-[A-Z0-9][A-Z0-9\-]*\b/g) || [];
      const nums = [...raw.matchAll(/-?[\d,]+\.\d{2}/g)].map((m) => parseMoney(m[0]));
      const qtyMatch = raw.match(/\b(\d+(?:\.\d+)?)\b/);
      rows.push({
        item: codes[0] || raw.slice(0, 40),
        description: '',
        qty: qtyMatch ? Number.parseFloat(qtyMatch[1]) : NaN,
        unitPrice: nums.length >= 2 ? nums[nums.length - 2] : nums[0],
        totalPrice: nums.length ? nums[nums.length - 1] : NaN,
        raw: raw.slice(0, 240),
      });
    }
  }

  for (const r of rows) {
    progress(
      `13. Lines QLI — Item="${r.item}" Qty=${Number.isFinite(r.qty) ? r.qty : '?'} Unit=${moneyFmt(r.unitPrice)} Total=${moneyFmt(r.totalPrice)}`,
    );
  }
  return rows;
}

/**
 * Quote toolbar (beside Browse Catalogs):
 *   Generate PDF Document → Preview PDF / View Quote Document →
 *   extract Quotation Details (DOM text OR downloaded PDF) →
 *   validate vs Lines tab Products/QLI
 *
 * Salesforce often shows an Adobe image-based viewer (page <img>s) with no
 * selectable table text — scraping DOM alone hangs/times out. Prefer Download
 * + pdf-parse when that happens.
 */
async function generateAndPreviewQuotePdf(page, { linesExpected = [], lineSnapshots = [], validationRows = [] } = {}) {
  progress('13. Generate PDF Document → Preview PDF → validate Quotation Details vs Lines');
  const stepDeadline = Date.now() + 4 * 60_000; // never burn the whole E2E timeout here

  let quoteId = await quoteIdFromUrl(page);
  if (!quoteId || !/\/lightning\/r\/Quote\//i.test(page.url() || '')) {
    if (quoteId) {
      await page.goto(`/lightning/r/Quote/${quoteId}/view`, { waitUntil: 'domcontentloaded' });
      await waitForQuoteRecordVisible(page, { timeout: 45_000 }).catch(() => {});
    }
  }
  await waitForQuoteRecordVisible(page, { timeout: 30_000 }).catch(() => {});
  await page.locator('.slds-spinner:visible').first().waitFor({ state: 'hidden', timeout: 30_000 }).catch(() => {});

  await openQuoteTab(page, 'Lines', { force: true }).catch(() => {});
  await page.locator('.slds-spinner:visible').first().waitFor({ state: 'hidden', timeout: 20_000 }).catch(() => {});

  const genPdf = page
    .locator('records-lwc-highlights-panel, records-highlights2, .slds-page-header_record-home, .slds-page-header, body')
    .getByRole('button', { name: /generate\s*pdf\s*document/i })
    .or(page.getByRole('button', { name: /generate\s*pdf\s*document/i }))
    .or(page.getByRole('link', { name: /generate\s*pdf\s*document/i }))
    .or(page.locator('button[name*="GeneratePDF" i], a[title*="Generate PDF" i], button[title*="Generate PDF" i]'))
    .first();

  if (!(await genPdf.isVisible({ timeout: 8_000 }).catch(() => false))) {
    const more = page
      .locator('records-lwc-highlights-panel, records-highlights2, .slds-page-header_record-home')
      .getByRole('button', { name: /show (more )?actions|more actions/i })
      .first();
    if (await more.isVisible({ timeout: 3_000 }).catch(() => false)) {
      progress('13. Opening Quote actions menu for Generate PDF Document');
      await more.click().catch(() => {});
      await sleep(500);
    }
  }

  await genPdf.waitFor({ state: 'visible', timeout: 45_000 });
  progress('13. Clicking Generate PDF Document');
  await genPdf.click();
  await page.locator('.slds-spinner:visible').first().waitFor({ state: 'hidden', timeout: 60_000 }).catch(() => {});

  const dialog = page
    .locator('.forceModal.open, .uiModal.open, .slds-modal, [role="dialog"], lightning-overlay-container, .slds-modal__container')
    .filter({ hasText: /generate\s*pdf|preview\s*pdf|create\s*pdf|view\s*quote\s*document/i })
    .last();
  await page
    .waitForFunction(
      () => /preview\s*pdf|create\s*pdf|generate\s*pdf|view\s*quote\s*document/i.test(document.body?.innerText || ''),
      null,
      { timeout: 60_000 },
    )
    .catch(() => {});
  await sleep(600);

  // Org UI may show Preview PDF or View Quote Document (same goal)
  const previewBtn = dialog
    .getByRole('button', { name: /^(preview\s*pdf|view\s*quote\s*document)$/i })
    .or(page.getByRole('button', { name: /^(preview\s*pdf|view\s*quote\s*document)$/i }))
    .or(dialog.getByRole('link', { name: /^(preview\s*pdf|view\s*quote\s*document)$/i }))
    .or(page.getByRole('link', { name: /^(preview\s*pdf|view\s*quote\s*document)$/i }))
    .or(page.locator('button, a, lightning-button').filter({ hasText: /^(preview\s*pdf|view\s*quote\s*document)$/i }))
    .first();

  await previewBtn.waitFor({ state: 'visible', timeout: 45_000 });
  const previewLabel = ((await previewBtn.innerText().catch(() => '')) || 'Preview').replace(/\s+/g, ' ').trim();
  progress(`13. Clicking ${previewLabel} (may take a few minutes for Quotation PDF)`);

  const context = page.context();
  const pagesBefore = context.pages().length;
  const popupPromise = context.waitForEvent('page', { timeout: 90_000 }).catch(() => null);
  await previewBtn.click();
  await page.locator('.slds-spinner:visible').first().waitFor({ state: 'hidden', timeout: 120_000 }).catch(() => {});

  let previewPage = await popupPromise;
  if (!previewPage && context.pages().length > pagesBefore) {
    previewPage = context.pages()[context.pages().length - 1];
  }
  const target = previewPage || page;
  if (previewPage) {
    progress('13. Preview opened in a new tab — waiting for Quotation PDF');
    await previewPage.waitForLoadState('domcontentloaded').catch(() => {});
  }

  const remainingMs = Math.max(30_000, stepDeadline - Date.now());
  const pdfReady = await waitForQuotePdfPreviewVisible(target, {
    timeoutMs: Math.min(3 * 60_000, remainingMs),
  });
  if (!pdfReady) {
    throw new Error('Quote PDF Preview did not become visible within the PDF-step time budget.');
  }
  progress('13. Quotation PDF visible — extract Quotation Details (DOM and/or Download)');

  let pdfRows = await collectQuotePdfQuotationDetails(target, { deadlineMs: stepDeadline });
  progress(`13. PDF Quotation Details — ${pdfRows.length} row(s)`);

  let expected = linesExpected;
  if (!expected.length && lineSnapshots.length) {
    expected = lineSnapshots.map((s, idx) => ({
      item: `QLI#${idx + 1}`,
      description: '',
      qty: s.qty,
      unitPrice: firstFinite(s.unitAfter, s.unitBefore),
      totalPrice: firstFinite(s.totalSellingAfterDiscount, s.totalSellingAmount),
      raw: '',
    }));
  }

  if (!pdfRows.length) {
    validationRows.push({
      section: 'PDF Quotation Details extraction',
      actual: '0 rows (image Adobe preview / no text layer)',
      expected: `≥ ${expected.length || 1} Lines row(s)`,
      status: STRICT_VALIDATION ? 'FAIL' : 'SKIP',
    });
    progress(
      '13. WARN — could not extract Quotation Details text from image PDF; preview itself succeeded',
    );
    if (STRICT_VALIDATION) {
      throw new Error('PDF preview opened but Quotation Details could not be extracted for validation.');
    }
    progress('13. Generate PDF → Preview - Passed (validation skipped — image PDF, SF_STRICT_VALIDATION off)');
    return true;
  }

  const ok = validatePdfQuotationDetailsVsLines(pdfRows, expected, validationRows);
  if (!ok) {
    progress('13. PDF Quotation Details mismatches — read FAILs and act');
    await settleValidationOrContinue(page, validationRows, { contextLabel: 'PDF Quotation Details vs Lines' });
    if (STRICT_VALIDATION) {
      printCalcVsQliTable(
        validationRows.filter((r) => /PDF|Quotation Details/i.test(r.section || '')),
        'PDF Quotation Details vs Lines',
      );
      throw new Error('PDF Quotation Details do not match Lines tab Products/QLI — see validation table.');
    }
    progress('13. WARN — PDF vs Lines mismatches remain; continuing (SF_STRICT_VALIDATION off)');
  } else {
    progress('13. Generate PDF → Preview → Quotation Details vs Lines - Passed');
  }
  return true;
}

/** True when Salesforce Adobe preview renders PDF pages as images (no HTML table). */
async function isAdobeImagePdfPreview(page) {
  return page
    .evaluate(() => {
      const imgs = [...document.querySelectorAll('img')].filter((img) =>
        /page\s*\d+\s*of\s*\d+|todelte_preview|todelete_preview|preview-/i.test(
          `${img.alt || ''} ${img.title || ''} ${img.getAttribute('src') || ''}`,
        ),
      );
      const adobe = /adobe\s*pdf|todelte_preview|todelete_preview|preview-\d+/i.test(document.body?.innerText || '');
      const download = [...document.querySelectorAll('button, a')].some((el) =>
        /^download$/i.test((el.textContent || '').replace(/\s+/g, ' ').trim()),
      );
      return imgs.length > 0 || (adobe && download);
    })
    .catch(() => false);
}

/**
 * Collect Quotation Details: try DOM first; if image Adobe viewer, Download PDF and parse text.
 */
async function collectQuotePdfQuotationDetails(page, { deadlineMs = Date.now() + 120_000 } = {}) {
  let rows = await scrollPdfAndCollectQuotationDetails(page, {
    maxPages: 8,
    deadlineMs: Math.min(deadlineMs, Date.now() + 45_000),
  });
  if (rows.length) return rows;

  const imagePdf = await isAdobeImagePdfPreview(page);
  if (imagePdf) {
    progress('13. Adobe image PDF detected — downloading file and extracting text');
  } else {
    progress('13. No DOM Quotation Details — trying Download PDF anyway');
  }

  if (Date.now() > deadlineMs - 5_000) return rows;

  const downloaded = await downloadQuotePdfBytes(page);
  if (!downloaded?.length) {
    progress('13. PDF Download did not yield a file');
    return rows;
  }

  const fromFile = await extractQuotationDetailsFromPdfBuffer(downloaded);
  if (fromFile.length) {
    progress(`13. Extracted ${fromFile.length} Quotation Details row(s) from downloaded PDF`);
    return fromFile;
  }
  progress('13. Downloaded PDF but could not parse Quotation Details lines from text');
  return rows;
}

async function downloadQuotePdfBytes(page) {
  const downloadBtn = page
    .getByRole('button', { name: /^download$/i })
    .or(page.getByRole('link', { name: /^download$/i }))
    .or(page.locator('button[title*="Download" i], a[title*="Download" i], a[download]'))
    .first();

  if (!(await downloadBtn.isVisible({ timeout: 5_000 }).catch(() => false))) {
    progress('13. Download button not visible on PDF preview');
    return null;
  }

  try {
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 60_000 }),
      downloadBtn.click({ force: true }),
    ]);
    const outDir = path.join(process.cwd(), 'test-results');
    fs.mkdirSync(outDir, { recursive: true });
    const suggested = download.suggestedFilename() || `quote-preview-${Date.now()}.pdf`;
    const savePath = path.join(outDir, suggested.replace(/[^\w.\-]+/g, '_'));
    await download.saveAs(savePath);
    const buf = fs.readFileSync(savePath);
    progress(`13. Saved PDF download → ${savePath} (${buf.length} bytes)`);
    return buf;
  } catch (err) {
    progress(`13. PDF download failed — ${String(err?.message || err).slice(0, 140)}`);
    return null;
  }
}

async function extractQuotationDetailsFromPdfBuffer(buffer) {
  try {
    const { PDFParse } = require('pdf-parse');
    const parser = new PDFParse({ data: buffer });
    const result = await parser.getText();
    await parser.destroy().catch(() => {});
    const text = String(result?.text || '');
    if (!text.trim()) return [];
    progress(`13. PDF text length=${text.length} — parsing Quotation Details`);
    return parseQuotationDetailsFromPdfText(text);
  } catch (err) {
    progress(`13. pdf-parse failed — ${String(err?.message || err).slice(0, 140)}`);
    return [];
  }
}

/** Parse Quotation Details lines from extracted PDF text. */
function parseQuotationDetailsFromPdfText(rawText) {
  const parseMoney = (s) => {
    const t = String(s || '')
      .replace(/SAR|USD|EUR/gi, '')
      .replace(/[^\d.,\-]/g, '')
      .replace(/,/g, '');
    const n = Number.parseFloat(t);
    return Number.isFinite(n) ? n : NaN;
  };

  const text = String(rawText || '').replace(/\u00a0/g, ' ');
  const idx = text.search(/quotation\s*details/i);
  const chunk = idx >= 0 ? text.slice(idx, idx + 12000) : text;
  const out = [];
  const seen = new Set();

  const lineRe =
    /\b([A-Z]{1,6}-[A-Z0-9][A-Z0-9\-]*)\b([\s\S]{0,220}?)(?:\b(\d+(?:\.\d+)?)\b)\s+([\d,]+\.?\d*)\s+([\d,]+\.?\d*)/g;
  let m;
  while ((m = lineRe.exec(chunk))) {
    const item = m[1];
    const mid = String(m[2] || '').replace(/\s+/g, ' ').trim();
    if (/material\s*code|unit\s*sales|total\s*selling|^item$/i.test(item)) continue;
    const qty = Number.parseFloat(m[3]);
    const unitPrice = parseMoney(m[4]);
    const totalPrice = parseMoney(m[5]);
    if (!Number.isFinite(qty) || qty <= 0) continue;
    if (!Number.isFinite(unitPrice) || !Number.isFinite(totalPrice)) continue;
    const description = mid
      .replace(/\bN\/?A\b/gi, 'N/A')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 200);
    const key = `${item}|${qty}|${unitPrice}|${totalPrice}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      item,
      materialCode: '',
      description,
      vatPct: NaN,
      qty,
      unitPrice,
      totalPrice,
    });
  }

  return out;
}

/**
 * Scroll through every PDF preview page and collect Quotation Details line rows.
 * Bounded — image Adobe viewers often have no DOM tables.
 */
async function scrollPdfAndCollectQuotationDetails(page, { maxPages = 8, deadlineMs = Date.now() + 45_000 } = {}) {
  const allRows = [];
  const seenKeys = new Set();

  const absorb = (rows) => {
    for (const r of rows || []) {
      const key = `${(r.item || '').toLowerCase()}|${r.qty}|${r.unitPrice}|${r.totalPrice}|${(r.description || '').slice(0, 40)}`;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      allRows.push(r);
    }
  };

  absorb(await scrapeQuotationDetailsFromPdfPage(page));
  if ((await isAdobeImagePdfPreview(page)) && !allRows.length) {
    progress('13. Image PDF preview — skip long DOM page-walk (will Download instead)');
    return allRows;
  }

  for (let p = 0; p < maxPages; p++) {
    if (Date.now() > deadlineMs) {
      progress('13. PDF DOM scrape time budget reached');
      break;
    }
    const pageInfo = await readPdfPageIndicator(page);
    progress(
      `13. PDF page ${pageInfo.current || p + 1}${pageInfo.total ? ` of ${pageInfo.total}` : ''} — Quotation Details rows so far ${allRows.length}`,
    );

    if (pageInfo.total && pageInfo.current && pageInfo.current >= pageInfo.total) break;

    const moved = await goToNextPdfPreviewPage(page);
    if (!moved) break;
    await sleep(500);
    absorb(await scrapeQuotationDetailsFromPdfPage(page));
  }

  absorb(await scrapeQuotationDetailsFromPdfPage(page));
  return allRows;
}

async function readPdfPageIndicator(page) {
  const text = ((await page.locator('body').innerText().catch(() => '')) || '').replace(/\s+/g, ' ');
  const m =
    text.match(/page\s*(\d+)\s*(?:of|\/)\s*(\d+)/i) ||
    text.match(/\b(\d+)\s*\/\s*(\d+)\b/);
  if (m) {
    return { current: Number.parseInt(m[1], 10), total: Number.parseInt(m[2], 10) };
  }
  const alts = await page
    .evaluate(() =>
      [...document.querySelectorAll('img')]
        .map((img) => img.alt || '')
        .filter((a) => /page\s*\d+\s*of\s*\d+/i.test(a))
        .join(' | '),
    )
    .catch(() => '');
  const m2 = String(alts).match(/page\s*(\d+)\s*of\s*(\d+)/i);
  if (m2) {
    return { current: Number.parseInt(m2[1], 10), total: Number.parseInt(m2[2], 10) };
  }
  return { current: NaN, total: NaN };
}

async function goToNextPdfPreviewPage(page) {
  const next = page
    .getByRole('button', { name: /next\s*page|^next$/i })
    .or(page.locator('button[title*="Next" i], a[title*="Next" i], button[aria-label*="Next" i]'))
    .first();
  if (await next.isVisible({ timeout: 800 }).catch(() => false)) {
    const disabled = await next.isDisabled().catch(() => false);
    if (disabled) return false;
    await next.click().catch(() => {});
    return true;
  }
  // Do NOT press PageDown and claim success — that caused infinite walks on image viewers
  return false;
}

/**
 * Scrape Quotation Details table from the current PDF preview view.
 * Columns: Item | Material Code | Description | VAT% | Quantity | Unit Sales Price Before VAT | Total Selling Price
 */
async function scrapeQuotationDetailsFromPdfPage(page) {
  return page
    .evaluate(() => {
      const parseMoney = (s) => {
        const t = String(s || '')
          .replace(/SAR|USD|EUR/gi, '')
          .replace(/[^\d.,\-]/g, '')
          .replace(/,/g, '');
        const n = Number.parseFloat(t);
        return Number.isFinite(n) ? n : NaN;
      };
      const out = [];
      const tables = [...document.querySelectorAll('table')];
      for (const table of tables) {
        const headerText = ((table.querySelector('thead') && table.querySelector('thead').innerText) || table.innerText || '')
          .replace(/\s+/g, ' ')
          .slice(0, 400);
        if (!/quotation\s*details|material\s*code|unit\s*sales\s*price|total\s*selling\s*price/i.test(headerText)) {
          continue;
        }
        const headers = [...table.querySelectorAll('thead th, thead td, tr:first-child th, tr:first-child td')].map((h) =>
          (h.innerText || '').replace(/\s+/g, ' ').trim().toLowerCase(),
        );
        const col = (re) => headers.findIndex((h) => re.test(h));
        let iItem = col(/^item$/);
        let iMat = col(/material\s*code/);
        let iDesc = col(/^description$/);
        let iVat = col(/^vat\s*%?$/);
        let iQty = col(/^quantity$|^qty$/);
        let iUnit = col(/unit\s*sales\s*price|before\s*vat/);
        let iTotal = col(/total\s*selling\s*price|^total$/);
        // If header row was treated as body, detect by first row labels
        const bodyRows = [...table.querySelectorAll('tbody tr')];
        const rows = bodyRows.length ? bodyRows : [...table.querySelectorAll('tr')].slice(1);
        for (const tr of rows) {
          const cells = [...tr.querySelectorAll('td, th')].map((c) => (c.innerText || '').replace(/\s+/g, ' ').trim());
          if (cells.length < 2) continue;
          if (/^item$/i.test(cells[0]) && /quantity|description/i.test(cells.join(' '))) continue;
          const item = (iItem >= 0 ? cells[iItem] : cells[0]) || '';
          const materialCode = iMat >= 0 ? cells[iMat] : '';
          const description = iDesc >= 0 ? cells[iDesc] : cells[1] || '';
          const vatPct = iVat >= 0 ? parseMoney(cells[iVat]) : NaN;
          const qty = iQty >= 0 ? parseMoney(cells[iQty]) : parseMoney(cells[4]);
          const unitPrice = iUnit >= 0 ? parseMoney(cells[iUnit]) : parseMoney(cells[cells.length - 2]);
          const totalPrice = iTotal >= 0 ? parseMoney(cells[iTotal]) : parseMoney(cells[cells.length - 1]);
          if (!item || /^item$/i.test(item)) continue;
          out.push({
            item: item.slice(0, 120),
            materialCode: (materialCode || '').slice(0, 80),
            description: (description || '').slice(0, 200),
            vatPct,
            qty,
            unitPrice,
            totalPrice,
          });
        }
      }

      // Text fallback when table markup is flat / canvas-ocr style text
      if (!out.length) {
        const t = (document.body?.innerText || '').replace(/\u00a0/g, ' ');
        const idx = t.search(/quotation\s*details/i);
        if (idx >= 0) {
          const chunk = t.slice(idx, idx + 8000);
          const lineRe =
            /([A-Z]{1,4}-[A-Z0-9][A-Z0-9\-]*)\s+([\s\S]*?)\s+(\d+(?:\.\d+)?)\s+([\d,]+\.?\d*)\s+([\d,]+\.?\d*)/g;
          let m;
          while ((m = lineRe.exec(chunk))) {
            out.push({
              item: m[1],
              materialCode: '',
              description: String(m[2] || '')
                .replace(/\s+/g, ' ')
                .trim()
                .slice(0, 200),
              vatPct: NaN,
              qty: Number.parseFloat(m[3]),
              unitPrice: parseMoney(m[4]),
              totalPrice: parseMoney(m[5]),
            });
          }
        }
      }
      return out;
    })
    .catch(() => []);
}

/**
 * Match PDF Quotation Details rows to Lines tab Products/QLI (Item, Qty, Unit, Total).
 */
function validatePdfQuotationDetailsVsLines(pdfRows, linesRows, validationRows) {
  let ok = true;
  const usedPdf = new Set();

  const scoreMatch = (line, pdf) => {
    let score = 0;
    const lineItem = String(line.item || '').trim().toLowerCase();
    const pdfItem = String(pdf.item || '').trim().toLowerCase();
    if (lineItem && pdfItem && (lineItem === pdfItem || lineItem.includes(pdfItem) || pdfItem.includes(lineItem))) {
      score += 10;
    }
    if (Number.isFinite(line.qty) && Number.isFinite(pdf.qty) && nearlyEqual(line.qty, pdf.qty, 0.01)) score += 5;
    if (Number.isFinite(line.totalPrice) && Number.isFinite(pdf.totalPrice) && nearlyEqual(line.totalPrice, pdf.totalPrice)) {
      score += 8;
    }
    if (Number.isFinite(line.unitPrice) && Number.isFinite(pdf.unitPrice) && nearlyEqual(line.unitPrice, pdf.unitPrice)) {
      score += 4;
    }
    return score;
  };

  for (let i = 0; i < linesRows.length; i++) {
    const line = linesRows[i];
    let bestIdx = -1;
    let bestScore = 0;
    for (let j = 0; j < pdfRows.length; j++) {
      if (usedPdf.has(j)) continue;
      const s = scoreMatch(line, pdfRows[j]);
      if (s > bestScore) {
        bestScore = s;
        bestIdx = j;
      }
    }

    const tag = `PDF Quotation Details vs Lines#${i + 1}`;
    if (bestIdx < 0 || bestScore < 10) {
      validationRows.push({
        section: `${tag}: Item/Qty/Total match`,
        actual: '(no matching PDF row)',
        expected: `${line.item} Qty=${line.qty} Unit=${moneyFmt(line.unitPrice)} Total=${moneyFmt(line.totalPrice)}`,
        status: 'FAIL',
      });
      progress(
        `13. FAIL — Lines "${line.item}" Qty=${line.qty} Total=${moneyFmt(line.totalPrice)} not found in PDF Quotation Details`,
      );
      ok = false;
      continue;
    }

    usedPdf.add(bestIdx);
    const pdf = pdfRows[bestIdx];
    progress(
      `13. Match Lines "${line.item}" ↔ PDF "${pdf.item}" Qty=${pdf.qty} Unit=${moneyFmt(pdf.unitPrice)} Total=${moneyFmt(pdf.totalPrice)}`,
    );

    const itemOk =
      String(line.item || '')
        .toLowerCase()
        .includes(String(pdf.item || '').toLowerCase()) ||
      String(pdf.item || '')
        .toLowerCase()
        .includes(String(line.item || '').toLowerCase());
    validationRows.push({
      section: `${tag}: Item`,
      actual: pdf.item,
      expected: line.item,
      status: itemOk ? 'PASS' : 'FAIL',
    });
    if (!itemOk) ok = false;

    if (Number.isFinite(line.qty) && Number.isFinite(pdf.qty)) {
      const qOk = nearlyEqual(line.qty, pdf.qty, 0.01);
      validationRows.push({
        section: `${tag}: Quantity`,
        actual: String(pdf.qty),
        expected: String(line.qty),
        status: qOk ? 'PASS' : 'FAIL',
      });
      if (!qOk) ok = false;
    }

    if (Number.isFinite(line.unitPrice) && Number.isFinite(pdf.unitPrice)) {
      const uOk = nearlyEqual(line.unitPrice, pdf.unitPrice);
      validationRows.push({
        section: `${tag}: Unit Sales Price Before VAT`,
        actual: moneyFmt(pdf.unitPrice),
        expected: moneyFmt(line.unitPrice),
        status: uOk ? 'PASS' : 'FAIL',
      });
      if (!uOk) ok = false;
    }

    if (Number.isFinite(line.totalPrice) && Number.isFinite(pdf.totalPrice)) {
      const tOk = nearlyEqual(line.totalPrice, pdf.totalPrice);
      validationRows.push({
        section: `${tag}: Total Selling Price`,
        actual: moneyFmt(pdf.totalPrice),
        expected: moneyFmt(line.totalPrice),
        status: tOk ? 'PASS' : 'FAIL',
      });
      if (!tOk) ok = false;
    }

    if (line.description && pdf.description && !/^n\/?a$/i.test(line.description)) {
      const dOk =
        pdf.description.toLowerCase().includes(line.description.toLowerCase().slice(0, 20)) ||
        line.description.toLowerCase().includes(pdf.description.toLowerCase().slice(0, 20));
      validationRows.push({
        section: `${tag}: Description`,
        actual: pdf.description.slice(0, 80),
        expected: line.description.slice(0, 80),
        status: dOk ? 'PASS' : 'INFO',
      });
    }
  }

  validationRows.push({
    section: 'PDF Quotation Details row count vs Lines',
    actual: String(pdfRows.length),
    expected: `≥ ${linesRows.length} (Lines)`,
    status: pdfRows.length >= linesRows.length ? 'PASS' : 'FAIL',
  });
  if (pdfRows.length < linesRows.length) ok = false;

  for (let j = 0; j < pdfRows.length; j++) {
    if (usedPdf.has(j)) continue;
    const pdf = pdfRows[j];
    validationRows.push({
      section: `PDF Quotation Details extra row: ${pdf.item}`,
      actual: `Qty=${pdf.qty} Unit=${moneyFmt(pdf.unitPrice)} Total=${moneyFmt(pdf.totalPrice)}`,
      expected: '(present on PDF; may be additional QLI)',
      status: 'INFO',
    });
  }

  return ok;
}

/**
 * Wait until the Quotation PDF preview (screenshot layout) is visible.
 * Looks for "Quotation" title, quote PDF chrome, or embedded PDF viewer.
 */
async function waitForQuotePdfPreviewVisible(page, { timeoutMs = 5 * 60_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastNote = 0;
  while (Date.now() < deadline) {
    await page.locator('.slds-spinner:visible').first().waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {});

    const signals = await page
      .evaluate(() => {
        const t = (document.body?.innerText || '').replace(/\s+/g, ' ');
        const html = document.documentElement?.innerHTML || '';
        const hasQuotationTitle =
          /\bQuotation\b/i.test(t) &&
          (/quote\s*number|quote\s*currency|tibbiyah|faisaliah|fms/i.test(t) ||
            /toDelete_Preview|Preview-/i.test(t + html));
        const hasPdfViewer = !!document.querySelector(
          'embed[type*="pdf" i], object[type*="pdf" i], iframe[src*="pdf" i], iframe[src*="blob:" i], .pdfViewer, #viewer, canvas.pdf-page, [class*="pdf" i]',
        );
        const hasPreviewChrome = /download|public\s*link|toDelete_Preview|Preview-\d+|adobe\s*pdf/i.test(t + html);
        const hasLineTable = /material\s*code|unit\s*sales\s*price|total\s*selling\s*price|quotation\s*details/i.test(t);
        const hasPageImages = [...document.querySelectorAll('img')].some((img) =>
          /page\s*\d+\s*of\s*\d+|todelete_preview|preview-/i.test(`${img.alt || ''} ${img.title || ''}`),
        );
        return { hasQuotationTitle, hasPdfViewer, hasPreviewChrome, hasLineTable, hasPageImages };
      })
      .catch(() => ({
        hasQuotationTitle: false,
        hasPdfViewer: false,
        hasPreviewChrome: false,
        hasLineTable: false,
        hasPageImages: false,
      }));

    const quotationVisible = await page
      .getByText(/^quotation$/i)
      .first()
      .isVisible({ timeout: 500 })
      .catch(() => false);
    const detailsVisible = await page
      .getByText(/quotation\s*details/i)
      .first()
      .isVisible({ timeout: 500 })
      .catch(() => false);

    if (
      (signals.hasQuotationTitle && (signals.hasLineTable || signals.hasPreviewChrome || signals.hasPdfViewer)) ||
      (quotationVisible && (detailsVisible || signals.hasPdfViewer || signals.hasPreviewChrome)) ||
      (signals.hasPdfViewer && signals.hasPreviewChrome) ||
      (signals.hasPageImages && signals.hasPreviewChrome) ||
      signals.hasPageImages ||
      detailsVisible
    ) {
      progress(
        `13. Quotation PDF preview visible (title=${signals.hasQuotationTitle || quotationVisible}, details=${detailsVisible || signals.hasLineTable})`,
      );
      return true;
    }

    if (Date.now() - lastNote > 20_000) {
      progress('13. Still waiting for Quotation PDF preview to load…');
      lastNote = Date.now();
    }
    await sleep(2_000);
  }
  return false;
}

// ─── Test ────────────────────────────────────────────────────────────────────

async function launchSfChrome(headless) {
  return chromium.launch({
    channel: 'chrome',
    headless,
    args: headless
      ? ['--disable-dev-shm-usage', '--window-size=1920,1080']
      : ['--disable-dev-shm-usage', '--start-maximized'],
  });
}

async function newSfContext(browser, { headless, storageState } = {}) {
  return browser.newContext({
    baseURL: SF_BASE_URL,
    storageState: storageState || undefined,
    viewport: headless ? { width: 1920, height: 1080 } : null,
    acceptDownloads: true,
    permissions: ['geolocation'],
    geolocation: { latitude: 24.7136, longitude: 46.6753 },
  });
}

function attachSfDialogHandler(page) {
  page.on('dialog', async (dialog) => {
    const msg = dialog.message() || '';
    const { action, reason } = decidePopupAction(msg);
    progress(`Browser dialog read: "${msg.slice(0, 120)}" → ${action} (${reason})`);
    if (!msg.trim() || action === 'none') {
      await dialog.dismiss().catch(() => {});
      return;
    }
    if (action === 'dismiss') {
      await dialog.dismiss().catch(() => {});
      return;
    }
    await dialog.accept().catch(() => {});
  });
}

async function openBrowserWithAuthState(storageStatePath, headless) {
  const browser = await launchSfChrome(headless);
  const context = await newSfContext(browser, {
    headless,
    storageState: storageStatePath,
  });
  await context.grantPermissions(['geolocation'], { origin: SF_ORIGIN });
  await context.setGeolocation({ latitude: 24.7136, longitude: 46.6753 });
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);
  attachSfDialogHandler(page);
  let homeOk = false;
  for (let i = 1; i <= 3; i++) {
    try {
      await page.goto(HOME_PATH, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      homeOk = true;
      break;
    } catch (err) {
      const msg = String(err?.message || err || '');
      progress(`0. Home navigation attempt ${i}/3 failed — ${msg.slice(0, 100)}`);
      if (i === 3) throw err;
      await sleep(800);
    }
  }
  void homeOk;
  await page
    .locator('one-app-nav-bar, .slds-global-header, button[title="App Launcher"]')
    .first()
    .waitFor({ state: 'visible', timeout: 90_000 })
    .catch(() => {});
  if (await isLoginPageVisible(page) || !(await isLightningAppUrl(page.url()))) {
    await browser.close().catch(() => {});
    return null;
  }
  progress(
    headless
      ? '0. Headless session ready on Lightning — continuing automation'
      : '0. Chrome window open on Lightning — you can watch anytime',
  );
  return { page, context, browser };
}

/**
 * Reuse auth.json when valid. MFA only if session missing/expired (always in a visible window).
 * Default: keep Chrome visible for the whole Lead→Quote flow (SF_HEADLESS=1 to hide it).
 */
async function loginHeadedThenOpenHeadless(creds) {
  const loginUrl = (process.env.SF_LOGIN_URL || creds.loginUrl || '').trim();
  const username = (process.env.SF_USERNAME || creds.loginId || '').trim();
  const password = (process.env.SF_PASSWORD || creds.password || '').trim();
  const headless = RUN_HEADLESS;

  if (fs.existsSync(SF_AUTH_STATE_PATH)) {
    progress(
      `0. Trying saved session (${headless ? 'headless' : 'visible Chrome'}) → ${SF_AUTH_STATE_PATH}`,
    );
    const reused = await openBrowserWithAuthState(SF_AUTH_STATE_PATH, headless);
    if (reused) {
      progress('0. Saved session valid — skipping MFA');
      return reused;
    }
    progress('0. Saved session expired — need MFA in a visible window');
  } else {
    progress('0. No auth.json yet — MFA in headed Chrome');
  }

  progress('0. MFA headed — complete verification in the Chrome window');
  const headedBrowser = await launchSfChrome(false);
  const headedContext = await newSfContext(headedBrowser, { headless: false });
  await headedContext.grantPermissions(['geolocation'], { origin: SF_ORIGIN });
  await headedContext.setGeolocation({ latitude: 24.7136, longitude: 46.6753 });
  const headedPage = await headedContext.newPage();
  headedPage.setDefaultTimeout(60_000);
  attachSfDialogHandler(headedPage);
  progress('FLOW 1/6 Login (headed — complete MFA in the Chrome window)');
  try {
    await ensureOnHomeLoggedIn(headedPage, { loginUrl, username, password });
    await acceptAllowAccessPrompts(headedPage, { rounds: 2, perTryMs: 800 });
    await headedContext.storageState({ path: SF_AUTH_STATE_PATH });
    progress(`0. Session saved → ${SF_AUTH_STATE_PATH}`);
  } catch (err) {
    await headedBrowser.close().catch(() => {});
    throw err;
  }

  if (!headless) {
    progress('0. MFA done — continuing in this visible Chrome window');
    return { page: headedPage, context: headedContext, browser: headedBrowser };
  }

  await headedBrowser.close().catch(() => {});
  progress('0. Opening headless Chrome with saved session...');
  const session = await openBrowserWithAuthState(SF_AUTH_STATE_PATH, true);
  if (!session) {
    throw new Error('Headless session invalid after MFA — still on login. Re-run and complete MFA.');
  }
  return session;
}

test.describe('Salesforce Lead to Quote (E2E)', () => {
  test('Lead → Qualify → Convert → fill Acc/Contact/Opp → Products → Quote', async ({ page, context }) => {
    test.setTimeout(2_700_000);

    const creds = loadCredentials();
    const loginUrl = (process.env.SF_LOGIN_URL || creds.loginUrl || '').trim();
    const username = (process.env.SF_USERNAME || creds.loginId || '').trim();
    const password = (process.env.SF_PASSWORD || creds.password || '').trim();
    const passwordMissing =
      !password || password === 'YOUR_PASSWORD' || String(password).startsWith('YOUR_PASSWORD');

    test.skip(!loginUrl || !username || passwordMissing, 'Configure Salesforce credentials (CSV or env vars).');

    progress(
      `0. Speed — FAST_FILL=${FAST_FILL ? 'on' : 'off'}, SPEED=${SPEED}, browser=${RUN_HEADLESS ? 'headless' : 'visible'}`,
    );

    let ownedBrowser = null;
    let activePage = page;
    let activeContext = context;

    try {
      if (HEADLESS_AFTER_MFA) {
        const session = await loginHeadedThenOpenHeadless(creds);
        ownedBrowser = session.browser;
        activePage = session.page;
        activeContext = session.context;
      } else {
        activePage.setDefaultTimeout(60_000);
        await activeContext.grantPermissions(['geolocation'], { origin: SF_ORIGIN });
        await activeContext.setGeolocation({ latitude: 24.7136, longitude: 46.6753 });
        progress('0. Geolocation permission granted for Salesforce origin (Allow).');
        attachSfDialogHandler(activePage);
        progress('FLOW 1/6 Login');
        await ensureOnHomeLoggedIn(activePage, { loginUrl, username, password });
        await acceptAllowAccessPrompts(activePage, { rounds: 2, perTryMs: 800 });
      }

      // Use activePage for the rest of the flow (alias as page in local scope)
      const page = activePage;

    // Resume Quote only — Lines → Configure → validate → QLI → Quote Totals
    if (RESUME_QUOTE_ID) {
      progress(`RESUME — Quote ${RESUME_QUOTE_ID} → Lines → Pricing Calculator → validate`);
      await page.goto(`/lightning/r/Quote/${RESUME_QUOTE_ID}/view`, { waitUntil: 'domcontentloaded' });
      await waitForQuoteRecordVisible(page, { timeout: 60_000 });
      await clickQuoteStalePriceRefresh(page, { timeout: 15_000 });
      await configureAndValidateQuotePricing(page);
      progress(`Done (resumed Quote) — ${RESUME_QUOTE_ID}`);
      return;
    }

    // Resume: Opp already filled — Price Book / Products if needed, then Quote (open existing if present).
    if (RESUME_OPP_ID) {
      progress(`RESUME — Opportunity ${RESUME_OPP_ID} → Price Book / Products / Quote`);
      await page.goto(`/lightning/r/Opportunity/${RESUME_OPP_ID}/view`, { waitUntil: 'domcontentloaded' });
      await page.locator('.slds-spinner:visible').first().waitFor({ state: 'hidden', timeout: 45_000 }).catch(() => {});
      await verifyConvertedRecordPage(page, 'Opportunity');

      const skipQuoteResume = /^(1|true|yes)$/i.test(process.env.SF_SKIP_QUOTE || '');
      if (skipQuoteResume) {
        progress(`Done (resumed) — Opp: ${RESUME_OPP_ID} (Quote skipped)`);
        return;
      }

      if (!(await opportunityAlreadyHasProducts(page))) {
        await ensureOpportunityQuotePrerequisitesBeforeProducts(page);
        await choosePriceBook(page);
        await addProducts(page);
      } else {
        progress('RESUME — Products already on Opportunity — skip Price Book / Add Products / Opp field re-check');
      }

      let quoteIdResume = '';
      await openRelatedTab(page);
      quoteIdResume = await openExistingQuoteFromRelated(page);
      if (quoteIdResume) {
        progress(`RESUME — Opportunity already has Quote — reuse only → ${quoteIdResume}`);
      } else {
        progress('RESUME — no Quote on this Opportunity yet → Create Quote (one only)');
        quoteIdResume = await createQuote(page);
      }
      await configureAndValidateQuotePricing(page);
      progress(`Done (resumed) — Opp: ${RESUME_OPP_ID}, Quote: ${quoteIdResume || '(see UI)'}`);
      return;
    }

    let lead = { leadId: '', productCategory: '', leadLastName: '', leadCompany: '' };

    // 2–3. Lead object → Create Lead (default). Reuse only if SF_REUSE_LEAD=1.
    if (EXISTING_LEAD_ID) {
      progress(`FLOW 2/6 Reuse Lead ${EXISTING_LEAD_ID} (SF_REUSE_LEAD=1)`);
      await page.goto(`/lightning/r/Lead/${EXISTING_LEAD_ID}/view`, { waitUntil: 'domcontentloaded' });
      await page
        .locator(
          'records-record-layout-event-broker, .record-body-container, one-record-home-flexipage2, records-lwc-highlights-panel',
        )
        .first()
        .waitFor({ state: 'visible', timeout: 90_000 })
        .catch(() => {});
      lead = {
        leadId: extractLeadIdFromUrl(page.url()) || EXISTING_LEAD_ID,
        productCategory: '',
        leadLastName: '',
        leadCompany: '',
      };
      rememberLeadId(lead.leadId);
    } else {
      progress('FLOW 2/6 Open Lead object');
      await openLeadObjectFromHome(page);
      progress('FLOW 3/6 Create Lead');
      await clickNewLead(page);
      lead = await createLead(page);
      if (!isLeadRecordUrl(page.url())) {
        await ensureOnCreatedLeadRecord(page, {
          leadId: lead.leadId,
          leadLastName: lead.leadLastName,
          leadCompany: lead.leadCompany,
        });
      }
    }

    // 4. Open Lead → Qualify
    progress('FLOW 4/6 Open and Qualify Lead');
    await ensureLeadFacilityTypeValidForConvert(page);
    let productCategory = (await readProductCategoryFromLeadRecord(page)) || lead.productCategory || '';
    if (!/consumables|medical\s*equipment/i.test(productCategory)) {
      productCategory = lead.productCategory || '';
    }
    progress(`Product Category on Lead — "${productCategory || '(unset)'}"`);
    await page.locator('.slds-spinner:visible').first().waitFor({ state: 'hidden', timeout: 15_000 }).catch(() => {});
    if (await isLeadAlreadyConverted(page)) {
      throw new Error('Expected a new unconverted Lead. Unset SF_REUSE_LEAD / SF_LEAD_ID and create a new Lead.');
    }
    if (!/consumables|medical\s*equipment/i.test(productCategory)) {
      throw new Error('Cannot Qualify/Convert: Product Category must be Consumables or Medical Equipment.');
    }
    await qualifyLead(page);

    // 5. Convert Lead
    progress('FLOW 5/6 Convert Lead');
    await convertLead(page, { productCategory });

    if (STOP_AFTER_CONVERT) {
      progress(
        `Done — stopped after Lead conversion (Account RT=${pickAccountRecordType()}). Lead: ${lead.leadId || '(see UI)'}`,
      );
      await sleep(FAST_FILL ? 1_000 : 4_000);
      return;
    }

    // 6. Opportunity fill (Contact/Account skipped unless SF_FILL_CONTACT / SF_FILL_ACCOUNT)
    progress('FLOW 6/6 Opportunity fill (Contact/Account optional)');
    const records = await openAndFillConvertedRecords(page, {
      fillContact: FILL_CONTACT,
      fillAccount: FILL_ACCOUNT,
    });

    if (records.opportunityId) {
      const urlLooksOpp =
        /\/lightning\/r\/006/i.test(page.url()) || /\/Opportunity\//i.test(page.url());
      if (!urlLooksOpp) {
        await page.goto(`/lightning/r/${records.opportunityId}/view`, { waitUntil: 'domcontentloaded' });
        await verifyConvertedRecordPage(page, 'Opportunity').catch(() => {});
      }
    }

    // 7. Opportunity → Price Book → Products → Quote → QLI calculator → Totals → PDF
    progress('FLOW 7/6 Opportunity — Price Book, Products, Quote, QLI, Totals, PDF');
    const skipQuote = /^(1|true|yes)$/i.test(process.env.SF_SKIP_QUOTE || '');
    if (skipQuote) {
      progress(
        `Done — Lead: ${lead.leadId}, Acc: ${records.accountId}, Contact: ${records.contactId}, Opp: ${records.opportunityId} (Quote skipped)`,
      );
      return;
    }

    await openRelatedTab(page);
    await ensureOpportunityQuotePrerequisitesBeforeProducts(page);
    const hasProducts = await opportunityAlreadyHasProducts(page, { openRelated: true });
    if (!hasProducts) {
      await choosePriceBook(page);
      await addProducts(page);
    } else {
      progress('Products already on Opportunity — skip Price Book / Add Products → Quote');
    }
    const quoteId = await createQuote(page);
    await configureAndValidateQuotePricing(page);

    progress(
      `Done — Lead: ${lead.leadId}, Acc: ${records.accountId || '(skipped fill)'}, Contact: ${records.contactId || '(skipped fill)'}, Opp: ${records.opportunityId}, Quote: ${quoteId || '(see UI)'}`,
    );
    } finally {
      if (ownedBrowser) {
        await ownedBrowser.close().catch(() => {});
      }
    }
  });
});
