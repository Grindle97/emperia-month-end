// Emperia account names the rules depend on, per entity, exactly as Xero
// spells them (taken from the Sep 2026 reconciliation workbooks). If an
// account is renamed in Xero, change it here; `npm run doctor` lists any
// mapped name it cannot find in the chart of accounts.

module.exports = {
  ltd: {
    intercompany: 'Intercompany - Emperia VR Inc',
    // Where the intercompany revaluation is booked. Xero's own system account.
    fxRevaluation: 'Unrealised Currency Gains',
    // Accounts to list for review with a fixed reason, instead of "no rule yet".
    reviewNotes: {
      VAT: 'Agree to the VAT return workings for the open quarter.',
      'PAYE Payable': "Agree to this month's payroll liability (FPS / payroll journal).",
      'Pensions Payable': "Agree to this month's pension contribution schedule.",
      'Computer Equipment': 'Agree to the fixed asset register (cost).',
      'Less Accumulated Depreciation on Computer Equipment': 'Agree to the fixed asset register (depreciation).',
      'Investment in US Subsidiary': 'Fixed: £0.79 investment in Emperia VR Inc; not on the asset register.',
      'Capital - Series A Preferred Shares': 'Agree to the cap table: shares × nominal value.',
      'Capital - x,xxx Ordinary Shares': 'Agree to the cap table: shares × nominal value.',
      'Share Premium Account': 'Changes only on a share issue; agree movements to the cap table.',
    },
  },
  inc: {
    intercompany: 'Intercompany - Emperia Ltd',
    reviewNotes: {
      "Directors' Loan Account": "No schedule yet. Payments of the director's personal taxes, to be reimbursed.",
      'Provision for Corporation Tax': 'No schedule yet. Agree to the federal tax workings.',
      'Provision for State Tax': 'No schedule yet. Agree to the state tax workings.',
      'Capital - x,xxx Ordinary Shares': 'Agree to the cap table: shares × nominal value.',
      'Legal Fees for Incorporation': 'Agree to the fixed asset register (cost).',
      'Less Accumulated Depreciation on Legal Fees for Incorporation': 'Agree to the fixed asset register (amortisation).',
    },
  },
};
