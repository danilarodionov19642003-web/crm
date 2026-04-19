/* ==========================================================================
   Table helpers — inline-редактирование и confirm-диалог
   ---------------------------------------------------------------------------
   Utility-функции, которыми пользуются страницы /pages/finance.html и
   /pages/employees.html для одинакового поведения таблиц.
   ========================================================================== */
(function () {
  'use strict';

  /**
   * Делает ячейку contenteditable и вызывает onChange при blur / Enter.
   * @param {HTMLElement} cell
   * @param {Function} onChange (newValue) => void
   * @param {Object} opts { type: 'text'|'number', parse?: Function }
   */
  function makeEditable(cell, onChange, opts = {}) {
    cell.classList.add('editable');
    cell.setAttribute('contenteditable', 'true');

    // Если передано opts.initial — заменяем текст ячейки сразу при focus
    // (используется когда DOM содержит подсказку типа "— не привязан —",
    // а реальное значение надо взять из state)
    if (typeof opts.initial !== 'undefined') {
      cell.addEventListener('focus', () => {
        if (cell.dataset.editingStarted) return;
        cell.dataset.editingStarted = '1';
        cell.textContent = opts.initial;
      }, { once: true });
    }

    cell.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); cell.blur(); }
      if (e.key === 'Escape') { e.preventDefault(); cell.blur(); }
    });
    cell.addEventListener('blur', () => {
      let val = cell.textContent.trim();
      if (opts.type === 'number') {
        val = val.replace(/[^\d.,-]/g, '').replace(',', '.');
        val = val === '' ? 0 : Number(val);
        if (isNaN(val)) val = 0;
        cell.textContent = val;
      }
      if (typeof opts.parse === 'function') val = opts.parse(val);
      onChange(val);
    });
  }

  /** Простое подтверждение удаления */
  function confirmDelete(message = 'Удалить запись?') {
    return window.confirm(message);
  }

  window.TableUtils = { makeEditable, confirmDelete };
})();
