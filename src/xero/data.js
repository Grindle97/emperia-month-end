// Read-only Xero fetchers for the month-end close.
//
// Every function takes an entity key ('ltd' | 'inc'), resolved to that
// entity's Xero organisation via config/entities. Nothing here writes to Xero.
//
// Pagination: unlike a chat assistant answering a question, a reconciliation
// must see EVERY record, so these page until Xero returns a short page. A hard
// ceiling stops a runaway loop, and hitting it throws rather than returning a
// silently partial list (a partial AP list would "reconcile" to the wrong
// number with nothing to say so).

const { getAuthenticatedClient } = require('./xeroClient');
const { describeXeroError } = require('./xeroError');
const { entityByKey } = require('../config/entities');

const PAGE_SIZE = 100; // Xero's fixed page size for these endpoints
const MAX_PAGES = 200;

async function clientFor(entityKey) {
  const entity = entityByKey(entityKey);
  return getAuthenticatedClient(entity.xeroName);
}

async function allPages(fetchPage, what) {
  const out = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const records = await fetchPage(page);
    if (!records || records.length === 0) return out;
    out.push(...records);
    if (records.length < PAGE_SIZE) return out;
  }
  throw new Error(`${what}: more than ${MAX_PAGES * PAGE_SIZE} records — stopped rather than return a partial list.`);
}

const xeroDate = (iso) => `DateTime(${iso.replace(/-/g, ',')})`;

/** Wrap a call so a Xero failure surfaces with its status and body. */
async function call(what, fn) {
  try {
    return await fn();
  } catch (err) {
    const d = describeXeroError(err);
    const e = new Error(`${what} failed: ${d.message}`);
    e.status = d.status;
    throw e;
  }
}

async function getOrganisation(entityKey) {
  const { client, tenantId } = await clientFor(entityKey);
  return call('Organisation', async () => {
    const res = await client.accountingApi.getOrganisations(tenantId);
    return (res.body.organisations || [])[0] || null;
  });
}

async function getAccounts(entityKey) {
  const { client, tenantId } = await clientFor(entityKey);
  return call('Chart of accounts', async () => {
    const res = await client.accountingApi.getAccounts(tenantId);
    return res.body.accounts || [];
  });
}

/** Raw Trial Balance report as at a date (parsed by recon/trialBalance). */
async function getTrialBalanceReport(entityKey, date) {
  const { client, tenantId } = await clientFor(entityKey);
  return call(`Trial balance ${date}`, async () => {
    const res = await client.accountingApi.getReportTrialBalance(tenantId, date, undefined);
    return (res.body.reports || [])[0] || null;
  });
}

/** Bank transactions dated on or before `toDate` that are not reconciled. */
async function getUnreconciledBankTransactions(entityKey, toDate) {
  const { client, tenantId } = await clientFor(entityKey);
  const where = `IsReconciled==false && Date <= ${xeroDate(toDate)} && Status=="AUTHORISED"`;
  return call('Unreconciled bank transactions', () =>
    allPages(async (page) => {
      const res = await client.accountingApi.getBankTransactions(
        tenantId, undefined, where, 'Date ASC', page
      );
      return res.body.bankTransactions || [];
    }, 'Bank transactions'));
}

/**
 * Invoices or bills dated on or before `toDate`, in every status that can
 * still be outstanding at that date (AUTHORISED now, or PAID since).
 * @param {'ACCREC'|'ACCPAY'} type
 */
async function getInvoicesUpTo(entityKey, type, toDate) {
  const { client, tenantId } = await clientFor(entityKey);
  const where = `Type=="${type}" && Date <= ${xeroDate(toDate)}`;
  return call(`${type} invoices`, () =>
    allPages(async (page) => {
      const res = await client.accountingApi.getInvoices(
        tenantId, undefined, where, 'Date ASC', undefined, undefined, undefined,
        ['AUTHORISED', 'PAID'], page, false
      );
      return res.body.invoices || [];
    }, 'Invoices'));
}

/** Credit notes dated on or before `toDate`. @param {'ACCRECCREDIT'|'ACCPAYCREDIT'} type */
async function getCreditNotesUpTo(entityKey, type, toDate) {
  const { client, tenantId } = await clientFor(entityKey);
  const where = `Type=="${type}" && Date <= ${xeroDate(toDate)} && (Status=="AUTHORISED" || Status=="PAID")`;
  return call(`${type} credit notes`, () =>
    allPages(async (page) => {
      const res = await client.accountingApi.getCreditNotes(tenantId, undefined, where, 'Date ASC', page);
      return res.body.creditNotes || [];
    }, 'Credit notes'));
}

/** Overpayments or prepayments (money paid/received ahead of an invoice). */
async function getUnappliedPaymentsUpTo(entityKey, kind, contactType, toDate) {
  const { client, tenantId } = await clientFor(entityKey);
  const type = contactType === 'ACCPAY' ? `SPEND-${kind.toUpperCase()}` : `RECEIVE-${kind.toUpperCase()}`;
  const where = `Type=="${type}" && Date <= ${xeroDate(toDate)} && Status=="AUTHORISED"`;
  const method = kind === 'overpayment' ? 'getOverpayments' : 'getPrepayments';
  const key = kind === 'overpayment' ? 'overpayments' : 'prepayments';
  return call(`${type}`, () =>
    allPages(async (page) => {
      const res = await client.accountingApi[method](tenantId, undefined, where, 'Date ASC', page);
      return res.body[key] || [];
    }, type));
}

/** Active tracking categories and their active options (e.g. Department). */
async function getTrackingCategories(entityKey) {
  const { client, tenantId } = await clientFor(entityKey);
  return call('Tracking categories', async () => {
    const res = await client.accountingApi.getTrackingCategories(tenantId, undefined, 'Name ASC', false);
    return (res.body.trackingCategories || [])
      .filter((c) => String(c.status || 'ACTIVE').toUpperCase() === 'ACTIVE')
      .map((c) => ({
        id: c.trackingCategoryID,
        name: c.name,
        options: (c.options || []).filter((o) => String(o.status || 'ACTIVE').toUpperCase() === 'ACTIVE').map((o) => o.name),
      }));
  });
}

module.exports = {
  getTrackingCategories,
  getOrganisation,
  getAccounts,
  getTrialBalanceReport,
  getUnreconciledBankTransactions,
  getInvoicesUpTo,
  getCreditNotesUpTo,
  getUnappliedPaymentsUpTo,
};
