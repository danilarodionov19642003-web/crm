(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ClientOrderIncomePolicy = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function shouldAutoReconcile(order) {
    if (!order || order.status !== 'confirmed') return false;
    // Online multi-orders are applied atomically by the payments backend. Their
    // hidden child rows exist only so every package can retain its own remainder.
    if (order.order_type === 'multi_order' || order.order_type === 'package_item' || order.parent_order_id) return false;
    // MANUAL:* packages describe imported history. Their real payments already
    // exist in CRM finances and must never be accrued again in the background.
    return !/^\s*MANUAL:/i.test(String(order.comment || ''));
  }

  return { shouldAutoReconcile };
});
