(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MentoriPackages = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function normCode(value) {
    return String(value || '').trim().toLowerCase().replace(/[-\s]/g, '');
  }

  function orderTime(order) {
    const value = order && (order.confirmed_at || order.created_at);
    const time = value ? new Date(value).getTime() : 0;
    return Number.isFinite(time) ? time : 0;
  }

  function build(orders, anketa, activeCount) {
    const card = anketa || {};
    const code = normCode(card.code);
    const orderPackages = (Array.isArray(orders) ? orders : [])
      .filter(order => order
        && order.order_type !== 'remainder'
        && order.status === 'confirmed'
        && normCode(order.anketa_code) === code
        && Number(order.qty) > 0)
      .sort((a, b) => orderTime(a) - orderTime(b) || Number(a.id || 0) - Number(b.id || 0))
      .map(order => ({
        id: String(order.id || ''),
        name: String(order.tariff_name || 'Пакет'),
        qty: Math.max(0, Number(order.qty) || 0),
        date: order.confirmed_at || order.created_at || '',
        transferred: /TRANSFER[-_:]?A28|FROM[-_:]?A28/i.test(String(order.comment || '')),
        bonus: false,
        countsTowardOrdered: true
      }));

    const extraPackages = (Array.isArray(card.packageExtras) ? card.packageExtras : [])
      .filter(item => item && Number(item.qty) > 0)
      .map(item => ({
        id: String(item.id || ''),
        name: String(item.name || 'Бонус'),
        qty: Math.max(0, Number(item.qty) || 0),
        date: item.date || '',
        transferred: false,
        bonus: true,
        countsTowardOrdered: item.countsTowardOrdered !== false
      }));

    const confirmed = orderPackages.concat(extraPackages)
      .sort((a, b) => orderTime({ confirmed_at: a.date }) - orderTime({ confirmed_at: b.date })
        || Number(a.id || 0) - Number(b.id || 0));

    const ordered = Math.max(0, Number(card.ordered) || 0);
    const knownQty = confirmed.reduce((sum, item) =>
      sum + (item.countsTowardOrdered ? item.qty : 0), 0);
    const legacyQty = Math.max(0, ordered - knownQty);
    if (legacyQty > 0) {
      confirmed.unshift({
        id: 'legacy',
        name: confirmed.length ? 'Ранее заказано' : String(card.tariff || 'Ранее заказано'),
        qty: legacyQty,
        date: '',
        transferred: false,
        bonus: false,
        countsTowardOrdered: true
      });
    }

    let doneLeft = Math.max(0, Number(card.done) || 0);
    let activeLeft = Math.max(0, Number(activeCount) || 0);
    return confirmed.map(item => {
      const done = Math.min(item.qty, doneLeft);
      doneLeft -= done;
      const active = Math.min(Math.max(0, item.qty - done), activeLeft);
      activeLeft -= active;
      const state = done >= item.qty ? 'closed' : (done + active > 0 ? 'active' : 'queued');
      return { ...item, done, active, state };
    });
  }

  return { build, normCode };
});
