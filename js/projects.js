(function () {
  'use strict';

  const STAGES = {
    discussion: 'Обсуждение', proposal: 'Предложение', prepayment: 'Предоплата',
    analysis: 'Аналитика и ТЗ', prototype: 'Прототип', development: 'Разработка',
    testing: 'Тестирование', launch: 'Запуск', support: 'Поддержка', completed: 'Завершён'
  };
  const STATUSES = {
    active: 'Активный', waiting_client: 'Ждём клиента', paused: 'Приостановлен',
    completed: 'Завершён', archived: 'Архив'
  };
  const HEALTH = { ok: 'Всё хорошо', attention: 'Требует внимания', problem: 'Есть проблема' };
  const RESOURCE_KINDS = {
    document: 'Документ', site: 'Сайт', repository: 'Репозиторий', server: 'Сервер',
    database: 'База данных', bot: 'Telegram-бот', design: 'Дизайн', other: 'Другое'
  };
  const ACTIVITY_KINDS = {
    note: 'Заметка', stage: 'Этап', finance: 'Финансы', release: 'Релиз', client: 'Заказчик'
  };

  const state = { projects: [], activity: [], resources: [], selectedId: null, loading: true };
  const $ = id => document.getElementById(id);
  const esc = value => String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  const money = value => `${Math.round(Number(value) || 0).toLocaleString('ru-RU')} ₽`;
  const date = value => value ? new Date(`${String(value).slice(0, 10)}T00:00:00`).toLocaleDateString('ru-RU') : 'Не указано';
  const dateTime = value => value ? new Date(value).toLocaleString('ru-RU', { dateStyle: 'medium', timeStyle: 'short' }) : '';

  function toast(message, type = 'success') {
    const node = document.createElement('div');
    node.className = `toast toast--${type}`;
    node.textContent = message;
    $('projectToasts').appendChild(node);
    setTimeout(() => node.remove(), 3000);
  }

  function fillSelect(id, values) {
    $(id).innerHTML = Object.entries(values).map(([key, label]) => `<option value="${key}">${esc(label)}</option>`).join('');
  }

  function openModal(id) {
    const modal = $(id);
    modal.classList.add('open');
    modal.setAttribute('aria-hidden', 'false');
  }
  function closeModal(id) {
    const modal = $(id);
    modal.classList.remove('open');
    modal.setAttribute('aria-hidden', 'true');
  }

  function dbError(error) {
    const message = String(error && error.message || error || 'Неизвестная ошибка');
    if (/development_projects|schema cache|404/i.test(message)) {
      return 'Хранилище проектов ещё не подключено к базе данных.';
    }
    return message.replace(/^REST \d+:\s*/, '');
  }

  async function load() {
    state.loading = true;
    renderList();
    try {
      const [projects, activity, resources] = await Promise.all([
        window.Supabase.Tbl.select('development_projects', 'select=*&order=updated_at.desc'),
        window.Supabase.Tbl.select('development_project_activity', 'select=*&order=happened_at.desc'),
        window.Supabase.Tbl.select('development_project_resources', 'select=*&order=created_at.desc')
      ]);
      state.projects = projects || [];
      state.activity = activity || [];
      state.resources = resources || [];
      const visible = state.projects.filter(project => project.status !== 'archived');
      state.selectedId = visible.some(project => project.id === state.selectedId)
        ? state.selectedId
        : (visible[0] && visible[0].id) || (state.projects[0] && state.projects[0].id) || null;
    } catch (error) {
      state.projects = [];
      state.activity = [];
      state.resources = [];
      state.loadError = dbError(error);
    } finally {
      state.loading = false;
      render();
    }
  }

  function filteredProjects() {
    const status = $('projectStatusFilter').value;
    const stage = $('projectStageFilter').value;
    const query = $('projectSearch').value.trim().toLowerCase();
    return state.projects.filter(project => {
      if (status ? project.status !== status : project.status === 'archived') return false;
      if (stage && project.stage !== stage) return false;
      if (query && !`${project.name} ${project.client_name}`.toLowerCase().includes(query)) return false;
      return true;
    });
  }

  function renderKpis() {
    const current = state.projects.filter(project => project.status !== 'archived');
    const active = current.filter(project => project.status === 'active').length;
    const waiting = current.filter(project => project.status === 'waiting_client').length;
    const attention = current.filter(project => project.health !== 'ok' && project.status !== 'completed').length;
    const balance = current.reduce((sum, project) => sum + Number(project.contract_amount || 0) - Number(project.received_amount || 0), 0);
    $('projectKpis').innerHTML = `
      <div class="card"><div class="card__label">Активные</div><div class="card__value">${active}</div></div>
      <div class="card"><div class="card__label">Ждём заказчика</div><div class="card__value">${waiting}</div></div>
      <div class="card"><div class="card__label">Требуют внимания</div><div class="card__value ${attention ? 'neg' : ''}">${attention}</div></div>
      <div class="card"><div class="card__label">Осталось получить</div><div class="card__value">${money(balance)}</div></div>`;
  }

  function renderList() {
    if (state.loading) {
      $('projectList').innerHTML = '<div class="project-empty">Загружаем проекты…</div>';
      return;
    }
    if (state.loadError) {
      $('projectList').innerHTML = `<div class="panel project-empty">${esc(state.loadError)}</div>`;
      return;
    }
    const rows = filteredProjects();
    if (!rows.length) {
      $('projectList').innerHTML = '<div class="panel project-empty">По выбранным условиям проектов нет.</div>';
      return;
    }
    $('projectList').innerHTML = rows.map(project => {
      const healthColor = project.health === 'problem' ? '#ef4444' : project.health === 'attention' ? '#f59e0b' : '#22c55e';
      const statusClass = project.status === 'waiting_client' ? 'project-pill--waiting' : project.status === 'active' ? 'project-pill--active' : '';
      return `<button class="project-list-card ${project.id === state.selectedId ? 'is-active' : ''}" data-project-id="${esc(project.id)}" style="--project-health:${healthColor}">
        <span class="project-list-card__top"><span><span class="project-list-card__name">${esc(project.name)}</span><span class="project-list-card__client">${esc(project.client_name)}</span></span><span class="project-pill ${statusClass}">${esc(STATUSES[project.status])}</span></span>
        <span class="project-list-card__meta"><span class="project-pill">${esc(STAGES[project.stage])}</span>${project.health !== 'ok' ? `<span class="project-pill project-pill--problem">${esc(HEALTH[project.health])}</span>` : ''}</span>
        <span class="project-list-card__next">${project.next_action ? `Дальше: ${esc(project.next_action)}` : 'Следующий шаг не указан'}</span>
      </button>`;
    }).join('');
    $('projectList').querySelectorAll('[data-project-id]').forEach(button => button.addEventListener('click', () => {
      state.selectedId = button.dataset.projectId;
      render();
    }));
  }

  function safeLink(url) {
    try {
      const parsed = new URL(url);
      return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : '';
    } catch (_) { return ''; }
  }

  function renderDetail() {
    const project = state.projects.find(item => item.id === state.selectedId);
    if (!project) {
      $('projectDetail').innerHTML = `<div class="project-empty">${state.loadError ? esc(state.loadError) : 'Выберите проект или создайте новый.'}</div>`;
      return;
    }
    const activity = state.activity.filter(item => item.project_id === project.id);
    const resources = state.resources.filter(item => item.project_id === project.id);
    const remaining = Number(project.contract_amount || 0) - Number(project.received_amount || 0);
    const profit = Number(project.received_amount || 0) - Number(project.expense_amount || 0);
    $('projectDetail').innerHTML = `
      <div class="project-detail__head">
        <div class="project-detail__title-row">
          <div><h2 class="project-detail__title">${esc(project.name)}</h2><div class="project-detail__client">${esc(project.client_name)}</div></div>
          <div class="project-detail__actions"><button class="btn btn--ghost btn--sm" id="projectEdit">Изменить</button><button class="btn btn--ghost btn--sm" id="projectArchive">${project.status === 'archived' ? 'Вернуть из архива' : 'В архив'}</button></div>
        </div>
        <div class="project-list-card__meta"><span class="project-pill project-pill--active">${esc(STATUSES[project.status])}</span><span class="project-pill">${esc(STAGES[project.stage])}</span><span class="project-pill">${esc(HEALTH[project.health])}</span></div>
      </div>
      <div class="project-detail__body">
        ${project.description ? `<p class="project-detail__description">${esc(project.description)}</p>` : ''}
        <div class="project-finance-grid">
          <div class="project-finance"><div class="project-finance__label">Стоимость</div><div class="project-finance__value">${money(project.contract_amount)}</div></div>
          <div class="project-finance"><div class="project-finance__label">Получено</div><div class="project-finance__value is-positive">${money(project.received_amount)}</div></div>
          <div class="project-finance"><div class="project-finance__label">Остаток</div><div class="project-finance__value ${remaining < 0 ? 'is-negative' : ''}">${money(remaining)}</div></div>
          <div class="project-finance"><div class="project-finance__label">Прибыль сейчас</div><div class="project-finance__value ${profit < 0 ? 'is-negative' : 'is-positive'}">${money(profit)}</div></div>
        </div>
        <div class="project-info-grid">
          <div class="project-info"><div class="project-info__label">Начало</div><div class="project-info__value">${date(project.start_date)}</div></div>
          <div class="project-info"><div class="project-info__label">Плановый срок</div><div class="project-info__value">${date(project.deadline)}</div></div>
          <div class="project-info project-info--wide"><div class="project-info__label">Следующий шаг · ${date(project.next_action_date)}</div><div class="project-info__value">${esc(project.next_action || 'Не указан')}</div></div>
          ${project.waiting_for_client ? `<div class="project-info project-info--wide"><div class="project-info__label">Ждём от заказчика</div><div class="project-info__value">${esc(project.waiting_for_client)}</div></div>` : ''}
        </div>
        <section class="project-section">
          <div class="project-section__head"><h3>Материалы и доступы</h3><button class="btn btn--ghost btn--sm" id="resourceAdd">Добавить</button></div>
          <div class="project-resources">${resources.length ? resources.map(resource => {
            const link = safeLink(resource.url);
            return `<div class="project-resource"><div class="project-resource__top"><div><div class="project-resource__meta">${esc(RESOURCE_KINDS[resource.kind])}${resource.expires_on ? ` · до ${date(resource.expires_on)}` : ''}</div><div class="project-resource__label">${esc(resource.label)}</div></div></div>${link ? `<div class="project-resource__details"><a href="${esc(link)}" target="_blank" rel="noopener noreferrer">Открыть ссылку</a></div>` : ''}${resource.login ? `<div class="project-resource__details">Логин: ${esc(resource.login)}</div>` : ''}${resource.notes ? `<div class="project-resource__details">${esc(resource.notes)}</div>` : ''}</div>`;
          }).join('') : '<div class="project-empty-inline">Материалов пока нет.</div>'}</div>
        </section>
        <section class="project-section">
          <div class="project-section__head"><h3>История проекта</h3></div>
          <form class="project-inline-form" id="activityForm"><select class="select" id="activityKind">${Object.entries(ACTIVITY_KINDS).map(([key, label]) => `<option value="${key}">${esc(label)}</option>`).join('')}</select><input class="input" id="activityBody" maxlength="2000" placeholder="Что произошло" required/><button class="btn btn--primary" type="submit">Добавить</button></form>
          <div class="project-activity" style="margin-top:10px">${activity.length ? activity.map(item => `<div class="project-activity__item"><div class="project-activity__meta">${esc(ACTIVITY_KINDS[item.kind])} · ${esc(dateTime(item.happened_at))}</div><div class="project-activity__body">${esc(item.body)}</div></div>`).join('') : '<div class="project-empty-inline">История пока пустая.</div>'}</div>
        </section>
      </div>`;

    $('projectEdit').addEventListener('click', () => showProjectForm(project));
    $('projectArchive').addEventListener('click', () => toggleArchive(project));
    $('resourceAdd').addEventListener('click', showResourceForm);
    $('activityForm').addEventListener('submit', addActivity);
  }

  function render() { renderKpis(); renderList(); renderDetail(); }

  function showProjectForm(project) {
    $('projectForm').reset();
    $('projectId').value = project ? project.id : '';
    $('projectModalTitle').textContent = project ? 'Изменить проект' : 'Новый проект';
    if (project) {
      $('projectName').value = project.name;
      $('projectClient').value = project.client_name;
      $('projectStage').value = project.stage;
      $('projectStatus').value = project.status;
      $('projectHealth').value = project.health;
      $('projectDescription').value = project.description || '';
      $('projectStart').value = project.start_date || '';
      $('projectDeadline').value = project.deadline || '';
      $('projectNextDate').value = project.next_action_date || '';
      $('projectNextAction').value = project.next_action || '';
      $('projectWaiting').value = project.waiting_for_client || '';
      $('projectContract').value = project.contract_amount || 0;
      $('projectReceived').value = project.received_amount || 0;
      $('projectExpenses').value = project.expense_amount || 0;
    }
    openModal('projectModal');
    setTimeout(() => $('projectName').focus(), 0);
  }

  function projectPayload() {
    return {
      name: $('projectName').value.trim(), client_name: $('projectClient').value.trim(),
      stage: $('projectStage').value, status: $('projectStatus').value, health: $('projectHealth').value,
      description: $('projectDescription').value.trim(), start_date: $('projectStart').value || null,
      deadline: $('projectDeadline').value || null, next_action_date: $('projectNextDate').value || null,
      next_action: $('projectNextAction').value.trim(), waiting_for_client: $('projectWaiting').value.trim(),
      contract_amount: Number($('projectContract').value) || 0,
      received_amount: Number($('projectReceived').value) || 0,
      expense_amount: Number($('projectExpenses').value) || 0
    };
  }

  async function saveProject(event) {
    event.preventDefault();
    const id = $('projectId').value;
    const payload = projectPayload();
    if (!payload.name || !payload.client_name) return;
    $('projectSave').disabled = true;
    try {
      if (id) {
        const previous = state.projects.find(item => item.id === id);
        await window.Supabase.Tbl.update('development_projects', `id=eq.${encodeURIComponent(id)}`, payload);
        if (previous && previous.stage !== payload.stage) {
          await window.Supabase.Tbl.insert('development_project_activity', { project_id: id, kind: 'stage', body: `Этап изменён: ${STAGES[previous.stage]} → ${STAGES[payload.stage]}` });
        }
        state.selectedId = id;
        toast('Проект обновлён');
      } else {
        const inserted = await window.Supabase.Tbl.insert('development_projects', payload);
        const created = inserted && inserted[0];
        if (created) {
          state.selectedId = created.id;
          await window.Supabase.Tbl.insert('development_project_activity', { project_id: created.id, kind: 'note', body: 'Проект создан' });
        }
        toast('Проект создан');
      }
      closeModal('projectModal');
      await load();
    } catch (error) { toast(dbError(error), 'error'); }
    finally { $('projectSave').disabled = false; }
  }

  async function toggleArchive(project) {
    const next = project.status === 'archived' ? 'active' : 'archived';
    const question = next === 'archived' ? 'Переместить проект в архив?' : 'Вернуть проект в активные?';
    if (!window.confirm(question)) return;
    try {
      await window.Supabase.Tbl.update('development_projects', `id=eq.${encodeURIComponent(project.id)}`, { status: next });
      toast(next === 'archived' ? 'Проект перемещён в архив' : 'Проект возвращён');
      await load();
    } catch (error) { toast(dbError(error), 'error'); }
  }

  function showResourceForm() {
    $('resourceForm').reset();
    openModal('resourceModal');
    setTimeout(() => $('resourceLabel').focus(), 0);
  }

  async function addResource(event) {
    event.preventDefault();
    if (!state.selectedId) return;
    const rawUrl = $('resourceUrl').value.trim();
    if (rawUrl && !safeLink(rawUrl)) return toast('Разрешены только ссылки http или https', 'error');
    try {
      await window.Supabase.Tbl.insert('development_project_resources', {
        project_id: state.selectedId, kind: $('resourceKind').value,
        label: $('resourceLabel').value.trim(), url: rawUrl,
        login: $('resourceLogin').value.trim(), expires_on: $('resourceExpires').value || null,
        notes: $('resourceNotes').value.trim()
      });
      closeModal('resourceModal');
      toast('Материал добавлен');
      await load();
    } catch (error) { toast(dbError(error), 'error'); }
  }

  async function addActivity(event) {
    event.preventDefault();
    const body = $('activityBody').value.trim();
    if (!state.selectedId || !body) return;
    try {
      await window.Supabase.Tbl.insert('development_project_activity', { project_id: state.selectedId, kind: $('activityKind').value, body });
      $('activityBody').value = '';
      toast('Запись добавлена');
      await load();
    } catch (error) { toast(dbError(error), 'error'); }
  }

  document.addEventListener('DOMContentLoaded', () => {
    fillSelect('projectStage', STAGES);
    fillSelect('projectStatus', STATUSES);
    fillSelect('projectHealth', HEALTH);
    fillSelect('resourceKind', RESOURCE_KINDS);
    $('projectStageFilter').innerHTML += Object.entries(STAGES).map(([key, label]) => `<option value="${key}">${esc(label)}</option>`).join('');
    $('projectCreate').addEventListener('click', () => showProjectForm(null));
    $('projectForm').addEventListener('submit', saveProject);
    $('resourceForm').addEventListener('submit', addResource);
    document.querySelectorAll('[data-project-close]').forEach(button => button.addEventListener('click', () => closeModal('projectModal')));
    document.querySelectorAll('[data-resource-close]').forEach(button => button.addEventListener('click', () => closeModal('resourceModal')));
    ['projectStatusFilter', 'projectStageFilter'].forEach(id => $(id).addEventListener('change', render));
    $('projectSearch').addEventListener('input', render);
    window.onGlobalSearch = query => { $('projectSearch').value = query; render(); };
    load();
  });
})();
