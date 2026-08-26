const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');

/**
 * Loads the first data row from test-data/Credentials and URLs.csv.
 */
function loadCredentials() {
  const csvPath = path.join(__dirname, '..', 'test-data', 'Credentials and URLs.csv');
  const raw = fs.readFileSync(csvPath, 'utf8');
  const rows = parse(raw, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
  });
  if (!rows.length) {
    throw new Error(`No data rows in ${csvPath}`);
  }
  const r = rows[0];
  return {
    loginUrl: (r['Login URL'] || '').trim(),
    loginId: (r['Login ID'] || '').trim(),
    password: (r['Password'] || '').trim(),
    accountName: (r['Account_Name'] || r['Account Name'] || '').trim(),
    accountGroup: (r['Account_Group'] || '').trim(),
    companyCode: (r['Company_Code'] || '').trim(),
    customerGroup: (r['Customer_Group'] || '').trim(),
    distributionChannel: (r['Distribution_Channel'] || '').trim(),
    accountGroupDescription: (r['Account_Group_Description'] || '').trim(),
    accountType: (r['Type'] || '').trim(),
    accountNameArabic: (r['Account_Name_Arabic'] || '').trim(),
    country: (r['Country'] || '').trim(),
    region: (r['Region'] || '').trim(),
  };
}

module.exports = { loadCredentials };
