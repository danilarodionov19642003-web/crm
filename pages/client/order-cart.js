(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MentoriOrderCart = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_ITEMS = 10;
  const MAX_NEW_ANKETAS = 5;
  const MAX_ITEM_QTY = 500;

  function priceItem(tariff, rawQty, cartPayFull) {
    const source = tariff || {};
    const price = Math.max(0, Number(source.price) || 0);
    let qty;
    if (source.unit === 'per') {
      const minimum = Math.max(1, Number(source.qty) || 1);
      qty = Math.min(MAX_ITEM_QTY, Math.max(minimum, Number(rawQty) || minimum));
    } else {
      qty = Math.max(0, Number(source.qty) || 0);
    }
    const amount = source.unit === 'per' ? price * qty : price;
    const payFull = cartPayFull === true || source.fullOnly === true;
    const prepayAmount = payFull ? amount : Math.round(amount / 2);
    return {
      qty,
      amount,
      payFull,
      prepayAmount,
      remainder: Math.max(0, amount - prepayAmount)
    };
  }

  function summarize(items, cartPayFull) {
    const priced = (items || []).map(item => ({
      ...item,
      pricing: priceItem(item.tariff, item.qty, cartPayFull)
    }));
    return {
      items: priced,
      amount: priced.reduce((sum, item) => sum + item.pricing.amount, 0),
      prepayAmount: priced.reduce((sum, item) => sum + item.pricing.prepayAmount, 0),
      remainder: priced.reduce((sum, item) => sum + item.pricing.remainder, 0),
      allPayFull: priced.length > 0 && priced.every(item => item.pricing.payFull)
    };
  }

  return { MAX_ITEMS, MAX_NEW_ANKETAS, MAX_ITEM_QTY, priceItem, summarize };
});
