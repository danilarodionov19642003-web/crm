(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MentoriOrderCart = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_ITEMS = 10;
  const MAX_ITEM_QTY = 500;
  const MANUAL_TRANSFER_DISCOUNT = 300;

  function validateQuantity(tariff, rawQty) {
    const source = tariff || {};
    if (source.unit !== 'per') return { valid: true, qty: Math.max(0, Number(source.qty) || 0) };
    const minimum = Math.max(1, Number(source.qty) || 1);
    const value = String(rawQty == null ? '' : rawQty).trim();
    const qty = Number(value);
    if (!value || !Number.isInteger(qty)) {
      return { valid: false, qty: 0, minimum, message: `Укажите целое число от ${minimum}. Оплата недоступна.` };
    }
    if (qty < minimum) {
      return { valid: false, qty, minimum, message: `Минимум ${minimum} отзывов. Оплата недоступна.` };
    }
    if (qty > MAX_ITEM_QTY) {
      return { valid: false, qty, minimum, message: `Максимум ${MAX_ITEM_QTY} отзывов в одном заказе.` };
    }
    return { valid: true, qty, minimum, message: '' };
  }

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
    const payFull = cartPayFull === true;
    const prepayAmount = payFull ? amount : Math.round(amount / 2);
    return {
      qty,
      amount,
      payFull,
      prepayAmount,
      remainder: Math.max(0, amount - prepayAmount)
    };
  }

  function summarize(items, cartPayFull, rawDiscount) {
    const priced = (items || []).map(item => ({
      ...item,
      pricing: priceItem(item.tariff, item.qty, cartPayFull)
    }));
    const baseAmount = priced.reduce((sum, item) => sum + item.pricing.amount, 0);
    let remainingDiscount = Math.min(
      Math.max(0, Number(rawDiscount) || 0),
      Math.max(0, baseAmount - 1)
    );
    priced.forEach(item => {
      const available = Math.max(0, item.pricing.amount - 1);
      const discount = Math.min(remainingDiscount, available);
      remainingDiscount -= discount;
      if (discount <= 0) {
        item.pricing.discountAmount = 0;
        item.pricing.baseAmount = item.pricing.amount;
        return;
      }
      item.pricing.baseAmount = item.pricing.amount;
      item.pricing.discountAmount = discount;
      item.pricing.amount -= discount;
      item.pricing.prepayAmount = item.pricing.payFull
        ? item.pricing.amount
        : Math.round(item.pricing.amount / 2);
      item.pricing.remainder = Math.max(0, item.pricing.amount - item.pricing.prepayAmount);
    });
    const discount = priced.reduce((sum, item) => sum + (item.pricing.discountAmount || 0), 0);
    return {
      items: priced,
      baseAmount,
      discount,
      amount: priced.reduce((sum, item) => sum + item.pricing.amount, 0),
      prepayAmount: priced.reduce((sum, item) => sum + item.pricing.prepayAmount, 0),
      remainder: priced.reduce((sum, item) => sum + item.pricing.remainder, 0),
      allPayFull: priced.length > 0 && priced.every(item => item.pricing.payFull)
    };
  }

  return {
    MAX_ITEMS,
    MAX_ITEM_QTY,
    MANUAL_TRANSFER_DISCOUNT,
    validateQuantity,
    priceItem,
    summarize
  };
});
