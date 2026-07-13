(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MentoriRemainder = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function normCode(code) {
    return String(code || '').trim().toLowerCase().replace(/[-\s]/g, '');
  }

  function keyFor(code, name) {
    const normalizedCode = normCode(code);
    return normalizedCode || `name:${String(name || '').trim().toLowerCase()}`;
  }

  function orderRemainder(order) {
    const amount = Number(order && order.amount) || 0;
    const prepay = order && order.prepay_amount != null
      ? Number(order.prepay_amount)
      : amount;
    return Math.max(0, amount - prepay);
  }

  function calculate(orders, anketas) {
    const allOrders = Array.isArray(orders) ? orders : [];
    const allAnketas = Array.isArray(anketas) ? anketas : [];
    const ordersById = new Map(allOrders.map(order => [String(order.id), order]));
    const activeSourceIds = new Set();
    const unreflectedByKey = new Map();

    allOrders.forEach(order => {
      if (!order || order.order_type !== 'remainder') return;
      if (order.status !== 'new' && order.status !== 'confirmed') return;
      (order.items || []).forEach(item => {
        const amount = Math.max(0, Number(item && item.amount) || 0);
        const key = keyFor(item && item.code, item && item.name);
        if (item && item.source_order_id) {
          const sourceId = String(item.source_order_id);
          activeSourceIds.add(sourceId);
          const source = ordersById.get(sourceId);
          if (!source || source.status !== 'confirmed' || source.remainder_status !== 'pending') {
            unreflectedByKey.set(key, (unreflectedByKey.get(key) || 0) + amount);
          }
        } else {
          unreflectedByKey.set(key, (unreflectedByKey.get(key) || 0) + amount);
        }
      });
    });

    const modernOutstandingByKey = new Map();
    const modernItems = [];
    allOrders.forEach(order => {
      if (!order || order.order_type === 'remainder') return;
      if (order.status !== 'confirmed' || order.remainder_status !== 'pending') return;
      const amount = orderRemainder(order);
      if (amount <= 0) return;
      const key = keyFor(order.anketa_code, order.anketa_name);
      modernOutstandingByKey.set(key, (modernOutstandingByKey.get(key) || 0) + amount);
      if (activeSourceIds.has(String(order.id))) return;
      modernItems.push({
        kind: 'order',
        source_order_id: String(order.id),
        code: order.anketa_code || '',
        name: order.anketa_name || order.anketa_code || '',
        tariff_name: order.tariff_name || '',
        confirmed_at: order.confirmed_at || order.created_at || '',
        amount
      });
    });

    const legacyItems = [];
    allAnketas.forEach(anketa => {
      const cardRemain = Math.max(0, Number(anketa && anketa.remain) || 0);
      if (cardRemain <= 0) return;
      const key = keyFor(anketa.code, anketa.name);
      const modernRemain = modernOutstandingByKey.get(key) || 0;
      const alreadySubmitted = unreflectedByKey.get(key) || 0;
      const legacyRemain = Math.max(0, cardRemain - modernRemain - alreadySubmitted);
      if (legacyRemain <= 0) return;
      legacyItems.push({
        kind: 'legacy',
        source_order_id: '',
        code: anketa.code || '',
        name: anketa.name || anketa.code || '',
        tariff_name: anketa.tariff || '',
        confirmed_at: '',
        amount: legacyRemain
      });
    });

    return modernItems.concat(legacyItems);
  }

  return { calculate, orderRemainder, normCode };
});
