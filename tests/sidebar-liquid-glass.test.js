'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const component = fs.readFileSync(path.join(root, 'components/sidebar.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'css/styles.css'), 'utf8');

assert.match(component, /class="sidebar__glass" aria-hidden="true"/,
  'в меню должен быть один общий стеклянный индикатор');
assert.match(component, /function setupLiquidNavigation\(sidebar\)/,
  'позиционирование индикатора должно быть общим для всех страниц');
assert.match(component, /--sidebar-glass-y/,
  'индикатор должен перемещаться к выбранной строке');
assert.match(component, /event\.metaKey[\s\S]*event\.ctrlKey/,
  'модифицированные клики для новой вкладки нельзя перехватывать');
assert.match(component, /prefers-reduced-motion: reduce/,
  'системное ограничение анимации должно учитываться');

assert.match(styles, /\.sidebar__glass\s*\{[\s\S]*backdrop-filter: blur\(16px\) saturate\(155%\)/,
  'активная линза должна иметь эффект стекла');
assert.match(styles, /border-radius: 999px/,
  'стеклянная линза должна быть круглой');
assert.match(styles, /transform \.42s cubic-bezier\(\.22, 1, \.36, 1\)/,
  'перемещение между разделами должно быть плавным');
assert.match(styles, /\.nav-item\.active\s*\{\s*background: transparent;/,
  'старую неподвижную оранжевую плашку нужно убрать');

console.log('sidebar liquid glass: OK');
