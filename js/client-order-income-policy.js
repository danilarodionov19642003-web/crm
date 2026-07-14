(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ClientOrderIncomePolicy = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function shouldAutoReconcile(order) {
    if (!order || order.status !== 'confirmed') return false;
    // MANUAL:* packages describe imported history. Their real payments already
    // exist in CRM finances and must never be accrued again in the background.
    return !/^\s*MANUAL:/i.test(String(order.comment || ''));
  }

  return { shouldAutoReconcile };
});
