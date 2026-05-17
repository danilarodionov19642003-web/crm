/* Виджет рассыльщика для дашборда.
 *
 * Источник: Cloudflare Worker https://mentori-tg.rubicon1326.workers.dev/api/bot-stats/*
 * который проксирует HTTPS → http://VPS:8000/api/bot-stats/* с Basic Auth.
 *
 * Эндпоинты (см. backend/routers/bot_stats.py):
 *   GET /api/bot-stats/today        — итоги дня + статусы аккаунтов
 *   GET /api/bot-stats/running      — активные кампании
 *   GET /api/bot-stats/orders       — последние 20 заявок из бота
 *   GET /api/bot-stats/autoreplies  — автоответы
 *   GET /api/bot-stats/summary      — всё вышеперечисленное одним JSON'ом
 *
 * Обновляется каждые 30 сек.
 */
(function () {
  const STATS_URL = "https://mentori-tg.rubicon1326.workers.dev/api/bot-stats/summary";
  const POLL_MS   = 30_000;

  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));

  const fmtNum = n => (typeof n === "number" ? n.toLocaleString("ru-RU") : "—");

  async function fetchStats() {
    try {
      const resp = await fetch(STATS_URL, { headers: { "Accept": "application/json" } });
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      return await resp.json();
    } catch (e) {
      console.warn("[bot-stats] fetch failed:", e);
      return null;
    }
  }

  function renderKpi(data) {
    const t = data.today || {};
    const a = data.autoreplies || {};
    const o = data.orders || {};
    const r = data.running || {};
    const tone = (n, neg) => (n > 0 ? (neg ? "down" : "up") : "");
    const cards = [
      { label: "Отправлено сегодня",  value: fmtNum(t.sent),         tone: tone(t.sent) },
      { label: "Ответили сегодня",    value: `${fmtNum(t.replied)}${t.reply_rate_pct ? ` · ${t.reply_rate_pct}%` : ""}`, tone: tone(t.replied) },
      { label: "Автоответы сегодня",  value: fmtNum(t.auto_replies), tone: tone(t.auto_replies) },
      { label: "Активных рассылок",   value: fmtNum(r.count || 0),   tone: (r.count ? "up" : "") },
      { label: "Заявок (всего)",      value: fmtNum(o.count || 0),   tone: "" },
      { label: "Автоответов в очереди", value: fmtNum(a.in_queue),   tone: tone(a.in_queue, true) },
    ];
    return cards.map(k => `
      <div class="card card--compact">
        <div class="card__label">${esc(k.label)}</div>
        <div class="card__value ${k.tone}">${esc(k.value)}</div>
      </div>
    `).join("");
  }

  function renderAccounts(data) {
    const a = (data.today && data.today.accounts) || {};
    const items = [
      { label: "✅ Active", value: a.active },
      { label: "⏸ Flood",  value: a.flood  },
      { label: "🚫 Banned", value: a.banned },
      { label: "⚪ Disabled", value: a.disabled },
      { label: "⏳ Pending", value: a.pending },
    ];
    return items
      .filter(x => (x.value || 0) > 0)
      .map(x => `<span class="badge badge--gray">${esc(x.label)} · <strong>${fmtNum(x.value)}</strong></span>`)
      .join(" ");
  }

  function renderRunningTable(data) {
    const camps = (data.running && data.running.campaigns) || [];
    if (!camps.length) return `<tr><td colspan="5" class="empty">Активных рассылок нет.</td></tr>`;
    return camps.map(c => `
      <tr>
        <td><strong>#${c.id}</strong> ${esc(c.name)}${c.two_step_mode ? ' <span class="badge badge--gray">2-этап</span>' : ''}</td>
        <td>${c.status === "running" ? "▶️ running" : "⏸ paused"}</td>
        <td class="num">${fmtNum(c.sent)} / ${fmtNum(c.total)} <small>(${c.progress_pct}%)</small></td>
        <td class="num">${fmtNum(c.replied)}${c.autoreplied ? ` · 🤖${fmtNum(c.autoreplied)}` : ""}</td>
        <td>${esc(c.started_at_msk || "—")}</td>
      </tr>`).join("");
  }

  function renderOrders(data) {
    const orders = (data.orders && data.orders.orders) || [];
    if (!orders.length) return `<tr><td colspan="5" class="empty">Заявок пока нет.</td></tr>`;
    return orders.slice(0, 8).map(o => `
      <tr>
        <td>${esc(o.created_at_msk || "—")}</td>
        <td><strong>${esc(o.name || "—")}</strong>${o.tg_username ? ` · @${esc(o.tg_username)}` : ""}</td>
        <td>${esc(o.service_name || "—")}</td>
        <td class="num">${esc(o.service_price || "—")}</td>
        <td>${esc(o.status || "new")}</td>
      </tr>`).join("");
  }

  function setStatusBadge(text, tone) {
    const el = document.getElementById("botStatsStatus");
    if (!el) return;
    el.textContent = text;
    el.className = "badge " + (tone === "ok" ? "badge--green" : tone === "err" ? "badge--red" : "badge--gray");
  }

  async function refresh() {
    setStatusBadge("обновляю…", "gray");
    const data = await fetchStats();
    if (!data) {
      setStatusBadge("offline — проверь Worker", "err");
      return;
    }
    document.getElementById("botKpiCards").innerHTML  = renderKpi(data);
    document.getElementById("botAccountsBadges").innerHTML = renderAccounts(data) || '<span class="muted">аккаунтов нет</span>';
    document.getElementById("botRunningRows").innerHTML = renderRunningTable(data);
    document.getElementById("botOrdersRows").innerHTML  = renderOrders(data);
    setStatusBadge(`обновлено ${new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}`, "ok");
  }

  function init() {
    if (!document.getElementById("botKpiCards")) return;  // нет секции — нечего делать
    refresh();
    setInterval(refresh, POLL_MS);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
