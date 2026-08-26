(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.Economics = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const DAY_MS = 86400000;
  const READY_STATUS = '🎯 Готов';
  const DEFAULT_PERFORMER = 'Данил';
  const SOFTWARE_SCOPE = 'account_software';
  const PROXY_SCOPE = 'account_proxy';

  function amount(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }

  function iso(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '').slice(0, 10))
      ? String(value).slice(0, 10)
      : '';
  }

  function dayNumber(value) {
    const valueIso = iso(value);
    if (!valueIso) return null;
    const parts = valueIso.split('-').map(Number);
    return Math.floor(Date.UTC(parts[0], parts[1] - 1, parts[2]) / DAY_MS);
  }

  function isoFromDay(day) {
    return new Date(day * DAY_MS).toISOString().slice(0, 10);
  }

  function addDays(value, days) {
    const n = dayNumber(value);
    return n == null ? '' : isoFromDay(n + Number(days || 0));
  }

  function addMonths(value, months) {
    const valueIso = iso(value);
    if (!valueIso) return '';
    const parts = valueIso.split('-').map(Number);
    const originalDay = parts[2];
    const target = new Date(Date.UTC(parts[0], parts[1] - 1 + Number(months || 0), 1));
    const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
    target.setUTCDate(Math.min(originalDay, lastDay));
    return target.toISOString().slice(0, 10);
  }

  function overlapDays(aStart, aEndExclusive, bStart, bEndExclusive) {
    const start = Math.max(dayNumber(aStart) ?? Infinity, dayNumber(bStart) ?? Infinity);
    const end = Math.min(dayNumber(aEndExclusive) ?? -Infinity, dayNumber(bEndExclusive) ?? -Infinity);
    return Math.max(0, end - start);
  }

  function normalizeCode(value) {
    return String(value || '').trim().toLowerCase().replace(/[-\s]/g, '');
  }

  function pairKey(mentorId, profileId) {
    return String(mentorId || '') + '::' + String(profileId || '');
  }

  function inferSubscriptionCostScope(name, current) {
    if (current === 'general') return '';
    if (current === SOFTWARE_SCOPE || current === PROXY_SCOPE) return current;
    const value = String(name || '').trim().toLowerCase();
    if (value.includes('прокси') || value.includes('proxy')) return PROXY_SCOPE;
    if (value.includes('dicloak') || value.includes('diclоak') || value.includes('антидетект')) {
      return SOFTWARE_SCOPE;
    }
    return '';
  }

  function inferExpenseCostScope(expense) {
    if (!expense || expense.personal || expense.costScope === 'general') return '';
    if (expense.costScope === SOFTWARE_SCOPE || expense.costScope === PROXY_SCOPE) {
      return expense.costScope;
    }
    const text = [expense.category, expense.comment, expense.name]
      .map(value => String(value || '').trim().toLowerCase())
      .join(' ');
    if (/\b(?:vpn|впн)\b/.test(text)) return '';
    const category = String(expense.category || '').trim().toLowerCase();
    if (category === 'прокси' || text.includes('proxy')) return PROXY_SCOPE;
    if (category === 'софт' || text.includes('dicloak') || text.includes('антидетект')) {
      return SOFTWARE_SCOPE;
    }
    return '';
  }

  function profileRange(profile, today, knownStatusStart) {
    if (!profile) return null;
    const explicitStart = iso(profile.softwareStartedAt);
    const knownStarts = [iso(profile.createdAt), iso(knownStatusStart)].filter(Boolean).sort();
    const start = explicitStart || knownStarts[0] || '';
    if (!start) return null;
    const ended = iso(profile.softwareEndedAt || profile.deletedAt);
    return {
      start,
      endExclusive: ended ? addDays(ended, 1) : addDays(today, 3660),
      ended
    };
  }

  function statusStart(status) {
    const dates = [];
    const current = iso(status && status.date);
    if (current) dates.push(current);
    (Array.isArray(status && status.history) ? status.history : []).forEach(item => {
      const date = iso(item && item.date);
      if (date) dates.push(date);
    });
    dates.sort();
    return dates[0] || '';
  }

  function buildContext(state, today) {
    state = state || {};
    const clients = Array.isArray(state.clients) ? state.clients : [];
    const mentors = Array.isArray(state.mentors) ? state.mentors : [];
    const statuses = Array.isArray(state.profileStatuses) ? state.profileStatuses : [];
    const reviews = Array.isArray(state.reviews) ? state.reviews : [];
    const employees = Array.isArray(state.employees) ? state.employees : [];

    const clientById = new Map(clients.map(client => [client.id, client]));
    const clientByCode = new Map(clients.map(client => [normalizeCode(client.code), client]));
    const mentorById = new Map(mentors.map(mentor => [mentor.id, mentor]));
    const clientByMentorId = new Map();
    mentors.forEach(mentor => {
      const client = clientByCode.get(normalizeCode(mentor.code));
      if (client) clientByMentorId.set(mentor.id, client);
    });

    const statusStartByProfile = new Map();
    statuses.forEach(status => {
      if (!status || !status.profileId) return;
      const start = statusStart(status);
      const current = statusStartByProfile.get(status.profileId);
      if (start && (!current || start < current)) statusStartByProfile.set(status.profileId, start);
    });

    const uniqueProfiles = new Map();
    (Array.isArray(state.archivedProfiles) ? state.archivedProfiles : []).forEach(profile => {
      if (profile && profile.id) uniqueProfiles.set(profile.id, profile);
    });
    (Array.isArray(state.profiles) ? state.profiles : []).forEach(profile => {
      if (profile && profile.id) uniqueProfiles.set(profile.id, profile);
    });
    const profileById = uniqueProfiles;
    const profileRows = [...uniqueProfiles.values()].map(profile => ({
      profile,
      range: profileRange(profile, today, statusStartByProfile.get(profile.id))
    })).filter(row => row.range);
    const profileRangeById = new Map(profileRows.map(row => [row.profile.id, row.range]));

    const approvedPairs = new Set();
    const approvedCounts = new Map();
    reviews.forEach(review => {
      if (!review || review.moderation !== 'approved') return;
      const key = pairKey(review.mentorId, review.profileId);
      approvedPairs.add(key);
      approvedCounts.set(key, (approvedCounts.get(key) || 0) + 1);
    });

    const statusesByClient = new Map();
    const statusesByProfile = new Map();
    statuses.forEach(status => {
      if (!status) return;
      const client = clientByMentorId.get(status.mentorId);
      if (client) {
        const clientRows = statusesByClient.get(client.id) || [];
        clientRows.push(status);
        statusesByClient.set(client.id, clientRows);
      }
      const profileRowsForStatus = statusesByProfile.get(status.profileId) || [];
      profileRowsForStatus.push(status);
      statusesByProfile.set(status.profileId, profileRowsForStatus);
    });

    const employeeRates = new Map();
    employees.forEach(employee => {
      const name = String(employee && employee.name || '').trim();
      if (name) employeeRates.set(name, amount(employee.ratePerReview));
    });
    if (!employeeRates.has(DEFAULT_PERFORMER)) employeeRates.set(DEFAULT_PERFORMER, 0);

    return {
      state,
      today,
      clients,
      clientById,
      clientByMentorId,
      mentorById,
      profileById,
      profileRows,
      profileRangeById,
      statuses,
      statusesByClient,
      statusesByProfile,
      approvedPairs,
      approvedCounts,
      employees,
      employeeRates
    };
  }

  function doneForClient(context, client) {
    return (context.statusesByClient.get(client.id) || []).reduce((sum, status) => {
      if (status.status !== READY_STATUS) return sum;
      return sum + (context.approvedCounts.get(pairKey(status.mentorId, status.profileId)) || 0);
    }, 0);
  }

  function activeClients(context) {
    return context.clients.filter(client => {
      if (client.closed === true) return false;
      const ordered = Math.max(0, amount(client.ordered));
      if (ordered <= 0) return false;
      return doneForClient(context, client) < ordered || amount(client.remain) > 0;
    });
  }

  function expenseCycles(state, scope) {
    const rows = [];
    (Array.isArray(state && state.expenses) ? state.expenses : []).forEach(expense => {
      if (!expense || inferExpenseCostScope(expense) !== scope || amount(expense.amount) <= 0) return;
      const segments = Array.isArray(expense.costSegments) ? expense.costSegments : [];
      const candidates = segments.length ? segments : [{
        start: expense.costCoverageStart || expense.date,
        endExclusive: expense.costCoverageEnd,
        amount: expense.amount
      }];
      candidates.forEach(segment => {
        const start = iso(segment && (segment.start || segment.costCoverageStart));
        const explicitEnd = iso(segment && (segment.endExclusive || segment.end || segment.costCoverageEnd));
        const endExclusive = explicitEnd || addMonths(start, 1);
        const value = amount(segment && segment.amount);
        if (!start || !endExclusive || endExclusive <= start || value <= 0) return;
        rows.push({
          id: expense.id || '',
          start,
          endExclusive,
          amount: value,
          expenseIds: expense.id ? [expense.id] : []
        });
      });
    });
    rows.sort((a, b) => a.start.localeCompare(b.start));

    const grouped = new Map();
    rows.forEach(row => {
      const key = row.start + '::' + row.endExclusive;
      const current = grouped.get(key) || { ...row, amount: 0, expenseIds: [] };
      current.amount += row.amount;
      current.expenseIds.push(...row.expenseIds);
      grouped.set(key, current);
    });
    const cycles = [...grouped.values()].sort((a, b) => a.start.localeCompare(b.start));

    if (scope === SOFTWARE_SCOPE) {
      return cycles.map((cycle, index) => {
        const next = cycles[index + 1];
        const endExclusive = next && next.start < cycle.endExclusive ? next.start : cycle.endExclusive;
        return { ...cycle, endExclusive, end: addDays(endExclusive, -1) };
      }).filter(cycle => cycle.endExclusive > cycle.start);
    }
    return cycles.map(cycle => ({ ...cycle, end: addDays(cycle.endExclusive, -1) }));
  }

  function relationInterval(context, status) {
    const range = context.profileRangeById.get(status.profileId);
    const start = statusStart(status) || (range && range.start) || '';
    if (!start || !range) return null;
    const nextStart = (context.statusesByProfile.get(status.profileId) || [])
      .filter(other => other !== status)
      .map(statusStart)
      .filter(value => value && value > start)
      .sort()[0];
    return {
      start,
      endExclusive: nextStart && nextStart < range.endExclusive ? nextStart : range.endExclusive
    };
  }

  function allocateSharedExpenses(context, scope) {
    const cycles = expenseCycles(context.state, scope);
    const byClient = new Map();
    const byProfile = new Map();
    const byClientProfile = new Map();
    let idle = 0;
    let unallocated = 0;

    const relationsByProfile = new Map();
    context.statusesByProfile.forEach((statuses, profileId) => {
      const relations = statuses.map(status => {
        const client = context.clientByMentorId.get(status.mentorId);
        const interval = relationInterval(context, status);
        return client && interval ? { clientId: client.id, status, ...interval } : null;
      }).filter(Boolean);
      relationsByProfile.set(profileId, relations);
    });

    cycles.forEach(cycle => {
      const totalAccountDays = context.profileRows.reduce((sum, row) => sum + overlapDays(
        row.range.start,
        row.range.endExclusive,
        cycle.start,
        cycle.endExclusive
      ), 0);
      if (totalAccountDays <= 0) {
        unallocated += cycle.amount;
        return;
      }
      const dayCost = cycle.amount / totalAccountDays;
      context.profileRows.forEach(row => {
        const start = Math.max(dayNumber(row.range.start), dayNumber(cycle.start));
        const end = Math.min(dayNumber(row.range.endExclusive), dayNumber(cycle.endExclusive));
        if (!(end > start)) return;
        const relations = relationsByProfile.get(row.profile.id) || [];
        for (let day = start; day < end; day++) {
          const active = [];
          const seen = new Set();
          relations.forEach(relation => {
            const relationStart = dayNumber(relation.start);
            const relationEnd = dayNumber(relation.endExclusive);
            if (relationStart <= day && day < relationEnd && !seen.has(relation.clientId)) {
              seen.add(relation.clientId);
              active.push(relation.clientId);
            }
          });
          byProfile.set(row.profile.id, (byProfile.get(row.profile.id) || 0) + dayCost);
          if (!active.length) {
            idle += dayCost;
            continue;
          }
          const share = dayCost / active.length;
          active.forEach(clientId => {
            byClient.set(clientId, (byClient.get(clientId) || 0) + share);
            const key = pairKey(clientId, row.profile.id);
            byClientProfile.set(key, (byClientProfile.get(key) || 0) + share);
          });
        }
      });
    });

    return {
      scope,
      cycles,
      byClient,
      byProfile,
      byClientProfile,
      idle,
      unallocated,
      total: cycles.reduce((sum, cycle) => sum + cycle.amount, 0),
      allocated: [...byClient.values()].reduce((sum, value) => sum + value, 0)
    };
  }

  function allocatePhoneExpenses(context) {
    const byClient = new Map();
    const byProfile = new Map();
    const byClientProfile = new Map();
    let unallocated = 0;
    let linkedTotal = 0;
    let historicalUnlinked = 0;
    const expenses = Array.isArray(context.state.expenses) ? context.state.expenses : [];

    expenses.forEach(expense => {
      if (!expense || expense.personal || expense.category !== 'Реклама - Номера') return;
      const value = amount(expense.amount);
      if (expense.source !== 'account_phone_auto' || !expense.profileId) {
        historicalUnlinked += value;
        return;
      }
      linkedTotal += value;
      byProfile.set(expense.profileId, (byProfile.get(expense.profileId) || 0) + value);
      const clientIds = [];
      const seen = new Set();
      (context.statusesByProfile.get(expense.profileId) || []).forEach(status => {
        const client = context.clientByMentorId.get(status.mentorId);
        if (client && !seen.has(client.id)) {
          seen.add(client.id);
          clientIds.push(client.id);
        }
      });
      if (!clientIds.length) {
        unallocated += value;
        return;
      }
      const share = value / clientIds.length;
      clientIds.forEach(clientId => {
        byClient.set(clientId, (byClient.get(clientId) || 0) + share);
        const key = pairKey(clientId, expense.profileId);
        byClientProfile.set(key, (byClientProfile.get(key) || 0) + share);
      });
    });

    return { byClient, byProfile, byClientProfile, linkedTotal, unallocated, historicalUnlinked };
  }

  function performerRate(context, status, fallbackName) {
    const performer = String(status && status.performer || fallbackName || DEFAULT_PERFORMER).trim() || DEFAULT_PERFORMER;
    const snapshot = status && status.performerRate;
    const rate = snapshot !== undefined && snapshot !== null && Number.isFinite(Number(snapshot))
      ? Number(snapshot)
      : (context.employeeRates.get(performer) || 0);
    return { performer, rate };
  }

  function laborCosts(context) {
    const byClient = new Map();
    const byPerformer = new Map();
    context.statuses.forEach(status => {
      const client = context.clientByMentorId.get(status.mentorId);
      if (!client) return;
      const labor = performerRate(context, status, DEFAULT_PERFORMER);
      byClient.set(client.id, (byClient.get(client.id) || 0) + labor.rate);
      const performerRow = byPerformer.get(labor.performer) || { count: 0, earned: 0 };
      performerRow.count += 1;
      performerRow.earned += labor.rate;
      byPerformer.set(labor.performer, performerRow);
    });

    let debt = 0;
    context.employees.forEach(employee => {
      const performer = String(employee && employee.name || '').trim();
      const performerRow = byPerformer.get(performer) || { count: 0, earned: 0 };
      performerRow.baseEarned = performerRow.earned;
      performerRow.bonusEarned = (Array.isArray(employee && employee.bonuses) ? employee.bonuses : [])
        .reduce((sum, bonus) => sum + amount(bonus && bonus.amount), 0);
      performerRow.earned = performerRow.baseEarned + performerRow.bonusEarned;
      byPerformer.set(performer, performerRow);
      debt += Math.max(0, performerRow.earned - amount(employee.paid));
    });
    return { byClient, byPerformer, debt };
  }

  function computeCurrentBalance(state) {
    const finance = state && state.finance || {};
    const baseIso = String(finance.balanceUpdatedAt || '');
    const baseDate = baseIso.slice(0, 10);
    const after = record => {
      if (!baseIso) return false;
      if (record && record.createdAt) return String(record.createdAt) > baseIso;
      return String(record && record.date || '') > baseDate;
    };
    const incomeAfter = (Array.isArray(state && state.income) ? state.income : [])
      .filter(after).reduce((sum, record) => sum + amount(record.amount), 0);
    const expenseAfter = (Array.isArray(state && state.expenses) ? state.expenses : [])
      .filter(after).reduce((sum, record) => sum + amount(record.amount), 0);
    const confirmedBalance = amount(finance.balance);
    return {
      confirmedBalance,
      current: confirmedBalance + incomeAfter - expenseAfter,
      incomeAfter,
      expenseAfter,
      baseIso,
      baseDate
    };
  }

  function analyze(state, options) {
    options = options || {};
    const today = iso(options.today) || new Date().toISOString().slice(0, 10);
    const context = buildContext(state, today);
    const clients = activeClients(context);
    const software = allocateSharedExpenses(context, SOFTWARE_SCOPE);
    const proxy = allocateSharedExpenses(context, PROXY_SCOPE);
    const phones = allocatePhoneExpenses(context);
    const labor = laborCosts(context);

    const rows = clients.map(client => {
      const statuses = context.statusesByClient.get(client.id) || [];
      const done = doneForClient(context, client);
      const inWork = statuses.filter(status => status.status !== READY_STATUS).length;
      const ordered = Math.max(0, Math.floor(amount(client.ordered)));
      const unassigned = Math.max(0, ordered - done - inWork);
      const actual = {
        salary: labor.byClient.get(client.id) || 0,
        phones: phones.byClient.get(client.id) || 0,
        software: software.byClient.get(client.id) || 0,
        proxy: proxy.byClient.get(client.id) || 0
      };
      actual.total = actual.salary + actual.phones + actual.software + actual.proxy;
      const profileStatusCounts = new Map();
      statuses.forEach(status => {
        profileStatusCounts.set(status.profileId, (profileStatusCounts.get(status.profileId) || 0) + 1);
      });
      const reviewCosts = statuses.map(status => {
        const profile = context.profileById.get(status.profileId) || {};
        const divisor = profileStatusCounts.get(status.profileId) || 1;
        const key = pairKey(client.id, status.profileId);
        const performer = performerRate(context, status, DEFAULT_PERFORMER);
        const parts = {
          salary: performer.rate,
          phones: (phones.byClientProfile.get(key) || 0) / divisor,
          software: (software.byClientProfile.get(key) || 0) / divisor,
          proxy: (proxy.byClientProfile.get(key) || 0) / divisor
        };
        parts.total = parts.salary + parts.phones + parts.software + parts.proxy;
        return {
          id: status.id || key,
          profileId: status.profileId || '',
          profileCode: profile.code || '',
          performer: performer.performer,
          status: status.status || '',
          archived: profile.archived === true || Boolean(profile.deletedAt || profile.softwareEndedAt),
          startedAt: statusStart(status),
          ...parts
        };
      }).sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
      const paid = amount(client.paid);
      const remain = amount(client.remain);
      const revenue = paid + remain;
      const totalField = amount(client.total);
      const totalCost = actual.total;
      const margin = revenue - totalCost;
      return {
        id: client.id,
        code: client.code || '',
        name: client.name || '',
        tariff: client.tariff || '',
        manager: client.manager || '',
        ordered,
        done,
        inWork,
        unassigned,
        paid,
        remain,
        revenue,
        totalField,
        financialMismatch: totalField > 0 && remain > 0 && Math.abs(totalField - revenue) > 0.01,
        actual,
        reviewCosts,
        totalCost,
        margin,
        marginPct: revenue > 0 ? margin / revenue * 100 : 0,
        actualCostPerStarted: statuses.length > 0 ? actual.total / statuses.length : 0
      };
    }).sort((a, b) => a.marginPct - b.marginPct);

    const sum = (field) => rows.reduce((total, row) => total + field(row), 0);
    const totals = {
      clients: rows.length,
      ordered: sum(row => row.ordered),
      done: sum(row => row.done),
      inWork: sum(row => row.inWork),
      unassigned: sum(row => row.unassigned),
      paid: sum(row => row.paid),
      remain: sum(row => row.remain),
      revenue: sum(row => row.revenue),
      actualCost: sum(row => row.actual.total),
      totalCost: sum(row => row.totalCost),
      margin: sum(row => row.margin)
    };
    totals.marginPct = totals.revenue > 0 ? totals.margin / totals.revenue * 100 : 0;

    const balance = computeCurrentBalance(state || {});
    const cashObligations = labor.debt;
    const cash = {
      ...balance,
      salaryDebt: labor.debt,
      obligations: cashObligations,
      free: balance.current - cashObligations,
      afterClose: balance.current + totals.remain - cashObligations
    };

    const month = today.slice(0, 7);
    const monthIncome = (Array.isArray(state && state.income) ? state.income : [])
      .filter(row => String(row.date || '').slice(0, 7) === month)
      .reduce((total, row) => total + amount(row.amount), 0);
    const monthBusinessExpense = (Array.isArray(state && state.expenses) ? state.expenses : [])
      .filter(row => !row.personal && String(row.date || '').slice(0, 7) === month)
      .reduce((total, row) => total + amount(row.amount), 0);

    const warnings = {
      financialMismatch: rows.filter(row => row.financialMismatch),
      overAssigned: rows.filter(row => row.done + row.inWork > row.ordered),
      historicalUnlinkedPhones: phones.historicalUnlinked,
      actualIdleSoftware: software.idle + software.unallocated,
      actualIdleProxy: proxy.idle + proxy.unallocated
    };

    return {
      today,
      clients: rows,
      totals,
      cash,
      month: {
        income: monthIncome,
        businessExpense: monthBusinessExpense,
        profit: monthIncome - monthBusinessExpense
      },
      costs: {
        software,
        proxy,
        phones,
        labor
      },
      warnings
    };
  }

  return {
    READY_STATUS,
    SOFTWARE_SCOPE,
    PROXY_SCOPE,
    inferSubscriptionCostScope,
    expenseCycles,
    computeCurrentBalance,
    analyze,
    _internals: {
      addDays,
      addMonths,
      overlapDays,
      buildContext,
      doneForClient,
      allocateSharedExpenses,
      allocatePhoneExpenses,
      laborCosts
    }
  };
});
