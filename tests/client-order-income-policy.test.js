const assert = require('node:assert/strict');
const { shouldAutoReconcile } = require('../js/client-order-income-policy.js');

assert.equal(shouldAutoReconcile({
  status: 'confirmed',
  comment: '',
}), true, 'ordinary confirmed orders may restore a missing finance entry');

assert.equal(shouldAutoReconcile({
  status: 'confirmed',
  comment: 'MANUAL:A21:HISTORY-DEVELOPMENT-12',
}), false, 'imported package history must not accrue payment again');

assert.equal(shouldAutoReconcile({
  status: 'confirmed',
  comment: '  manual:A22:HISTORY-DEVELOPMENT-12',
}), false, 'manual marker matching must ignore case and leading spaces');

assert.equal(shouldAutoReconcile({
  status: 'new',
  comment: '',
}), false, 'unconfirmed orders must not affect finances');

assert.equal(shouldAutoReconcile({
  status: 'confirmed',
  order_type: 'multi_order',
}), false, 'multi-order parent is applied by the payment backend');

assert.equal(shouldAutoReconcile({
  status: 'confirmed',
  order_type: 'package_item',
  parent_order_id: 77,
}), false, 'internal package rows must not duplicate finance income');

console.log('client order income policy: OK');
