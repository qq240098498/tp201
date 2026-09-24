/* 水库调度与汛限水位管理台 —— 纯静态前端（原生 HTML/CSS/JS，无框架、无构建、无外部依赖）
   显示纪律：限水位、是否超限、预警等级、残差与是否平衡、水量、偏差、是否汛期，
   全部直接显示接口返回的字段值，前端不自己判定、不自己算数。 */
(function () {
  'use strict';

  /* ================= 常量与工具 ================= */

  var VIEW_IDS = ['overview', 'reservoirs', 'water', 'forecast', 'orders', 'balance'];
  var ORDER_STATUSES = ['已下达', '执行中', '已完成', '已撤销'];
  var RESERVOIR_STATUSES = ['运行', '检修'];

  function el(id) { return document.getElementById(id); }
  function qs(sel, root) { return (root || document).querySelector(sel); }
  function qsa(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function esc(value) {
    if (value === null || value === undefined) return '';
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function dash(value) {
    return value === null || value === undefined || value === '' ? '—' : String(value);
  }

  function numText(value) {
    if (value === null || value === undefined || value === '') return '—';
    var n = Number(value);
    if (!Number.isFinite(n)) return String(value);
    return String(n);
  }

  function yesNo(value) {
    if (value === true) return '是';
    if (value === false) return '否';
    return '—';
  }

  function todayIso() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function addDays(iso, n) {
    var d = new Date(iso + 'T00:00:00');
    d.setDate(d.getDate() + n);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  /* 带符号的数字，偏差用：正数前面补 + */
  function signedText(value) {
    if (value === null || value === undefined || value === '') return '—';
    var n = Number(value);
    if (!Number.isFinite(n)) return String(value);
    return (n > 0 ? '+' : '') + String(n);
  }

  function queryString(params) {
    var parts = [];
    Object.keys(params || {}).forEach(function (key) {
      var value = params[key];
      if (value === null || value === undefined || value === '') return;
      parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(value));
    });
    return parts.length ? '?' + parts.join('&') : '';
  }

  function itemHtml(item) {
    return '<div class="item"><span class="k">' + esc(item[0]) + '</span><span class="v">' + esc(dash(item[1])) + '</span></div>';
  }

  function boolTag(value) {
    if (value === true) return '<span class="tag is-over">是</span>';
    if (value === false) return '<span class="tag is-ok">否</span>';
    return '<span class="tag">—</span>';
  }

  function warningTag(level) {
    var text = dash(level);
    var cls = 'tag';
    if (level === '严重') cls = 'tag is-serious';
    else if (level === '警戒') cls = 'tag is-warn';
    else if (level === '注意') cls = 'tag is-strong';
    else if (level === '正常') cls = 'tag is-ok';
    return '<span class="' + cls + '">' + esc(text) + '</span>';
  }

  function statusTag(status) {
    var cls = status === '运行' ? 'tag is-ok' : (status === '检修' ? 'tag is-warn' : 'tag');
    return '<span class="' + cls + '">' + esc(dash(status)) + '</span>';
  }

  function emptyRow(colspan, text) {
    return '<tr class="detail-row"><td colspan="' + colspan + '"><p class="empty">' + esc(text) + '</p></td></tr>';
  }

  function columnCount(tbodyId) {
    var table = qs('#' + tbodyId).closest('table');
    var head = qs('thead tr', table);
    return head ? head.children.length : 1;
  }

  /* ================= 接口封装 ================= */

  function api(method, path, body) {
    var options = { method: method, headers: {} };
    if (body !== undefined && body !== null) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }
    return fetch(path, options).then(function (res) {
      return res.text().then(function (text) {
        var data = null;
        if (text) { try { data = JSON.parse(text); } catch (e) { data = null; } }
        if (!res.ok) {
          var info = (data && data.error) || {};
          var err = new Error(info.message || ('接口返回 ' + res.status));
          err.code = info.code || '';
          err.details = info.details || null;
          err.status = res.status;
          throw err;
        }
        return data;
      });
    });
  }

  /* ================= 状态 ================= */

  var state = {
    view: 'overview',
    waterKind: 'level',
    settings: null,
    summary: null,
    reservoirs: [],
    levels: [],
    flows: { inflow: [], release: [] },
    orders: [],
    forecasts: [],
    timeline: null,
    suggest: null,
    forecastDraft: null,
    balance: null,
    expanded: { reservoir: '', level: '', flow: '', order: '', forecast: '' },
    reservoirDetail: null,
    curveDraft: null,
    curveQuery: { reservoirId: '', byLevel: null, byCapacity: null },
    filters: {
      overview: { status: '' },
      reservoirs: { basin: '', status: '', keyword: '' },
      water: { reservoirId: '', from: '', to: '' },
      forecast: { reservoirId: '', from: '', to: '' },
      orders: { reservoirId: '', status: '' },
      balance: { reservoirId: '', from: '2026-05-01', to: '2026-05-10' }
    }
  };

  var noticeTimer = null;
  var toastTimer = null;

  /* ================= 提示与报错 ================= */

  function showNotice(text, isError) {
    var box = el('notice');
    el('noticeText').textContent = text;
    box.classList.toggle('is-error', !!isError);
    box.removeAttribute('hidden');
    if (noticeTimer) clearTimeout(noticeTimer);
    noticeTimer = setTimeout(function () { box.setAttribute('hidden', ''); }, 9000);
  }

  function hideNotice() {
    el('notice').setAttribute('hidden', '');
    if (noticeTimer) clearTimeout(noticeTimer);
  }

  function toast(text, isError) {
    var box = el('toast');
    box.textContent = text;
    box.classList.toggle('is-error', !!isError);
    box.removeAttribute('hidden');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { box.setAttribute('hidden', ''); }, 2600);
  }

  /* 把 error.details 指到的字段标出来，并把 error.message 显示出来 */
  function markFieldErrors(details) {
    qsa('[data-field-error]').forEach(function (node) {
      node.textContent = '';
      node.setAttribute('hidden', '');
    });
    qsa('.is-invalid').forEach(function (node) { node.classList.remove('is-invalid'); });
    var lines = [];
    if (!details || typeof details !== 'object') return lines;
    Object.keys(details).forEach(function (key) {
      var message = details[key];
      lines.push(key + '：' + message);
      var hint = qs('[data-field-error="' + key + '"]');
      if (hint) {
        hint.textContent = String(message);
        hint.removeAttribute('hidden');
      }
      var input = qs('[name="' + key + '"]');
      if (input) input.classList.add('is-invalid');
      var matched = /^points\.(\d+)$/.exec(key);
      if (matched) {
        var row = qsa('[data-curve-row]')[Number(matched[1])];
        if (row) row.classList.add('is-invalid');
      }
      var itemMatched = /^items\.(\d+)$/.exec(key);
      if (itemMatched) {
        var itemRow = qsa('[data-forecast-row]')[Number(itemMatched[1])];
        if (itemRow) itemRow.classList.add('is-invalid');
      }
    });
    return lines;
  }

  function showError(err, box) {
    var lines = markFieldErrors(err && err.details);
    var message = (err && err.message) ? err.message : '接口出错了';
    if (box) {
      box.textContent = message + (lines.length ? '\n' + lines.join('\n') : '');
      box.removeAttribute('hidden');
    }
    showNotice(message + (lines.length ? '（需修正：' + lines.join('；') + '）' : ''), true);
  }

  function clearFormError(box) {
    if (box) { box.textContent = ''; box.setAttribute('hidden', ''); }
    markFieldErrors(null);
  }

  /* ================= 视图切换 ================= */

  function setView(view) {
    if (VIEW_IDS.indexOf(view) < 0) return;
    state.view = view;
    qsa('.tab').forEach(function (tab) {
      tab.classList.toggle('is-active', tab.dataset.view === view);
    });
    qsa('.view').forEach(function (panel) {
      panel.classList.toggle('is-active', panel.dataset.view === view);
    });
    renderSidebar();
  }

  async function reloadView(view) {
    try {
      if (view === 'overview') {
        state.summary = await api('GET', '/api/summary');
        renderTopbar();
        renderOverview();
      } else if (view === 'reservoirs') {
        state.reservoirs = await api('GET', '/api/reservoirs');
        fillReservoirSelects();
        renderReservoirs();
        if (state.expanded.reservoir) await expandReservoir(state.expanded.reservoir);
      } else if (view === 'water') {
        await loadWaterRecords();
        renderWater();
      } else if (view === 'forecast') {
        await loadForecastData();
        renderForecast();
      } else if (view === 'orders') {
        state.orders = await api('GET', '/api/orders' + ordersQuery());
        renderOrders();
      } else if (view === 'balance') {
        renderBalance();
      }
    } catch (err) {
      showError(err);
    }
  }

  async function goToView(view, filterText) {
    if (filterText) applyFilterText(view, filterText);
    setView(view);
    await reloadView(view);
  }

  function applyFilterText(view, filterText) {
    var pairs = String(filterText).split('&');
    pairs.forEach(function (pair) {
      var idx = pair.indexOf('=');
      if (idx < 0) return;
      var key = pair.slice(0, idx);
      var value = pair.slice(idx + 1);
      var bucket = state.filters[view] || {};
      bucket[key] = value;
      state.filters[view] = bucket;
      if (view === 'water' && key === 'kind') setWaterKind(value);
      if (view === 'reservoirs' && key === 'reservoirId') state.expanded.reservoir = value;
    });
  }

  /* ================= 侧栏筛选栏 ================= */

  function optionsHtml(list, current, allLabel) {
    var html = ['<option value="">' + esc(allLabel || '全部') + '</option>'];
    list.forEach(function (item) {
      var selected = String(item.value) === String(current === null || current === undefined ? '' : current) ? ' selected' : '';
      html.push('<option value="' + esc(item.value) + '"' + selected + '>' + esc(item.label) + '</option>');
    });
    return html.join('');
  }

  function reservoirOptions(current) {
    return optionsHtml((state.reservoirs || []).map(function (r) {
      return { value: r.id, label: r.code + ' ' + r.name };
    }), current, '全部水库');
  }

  function stringOptions(values, current, allLabel) {
    return optionsHtml(values.map(function (v) { return { value: v, label: v }; }), current, allLabel);
  }

  /* 水位与流量侧栏的条数只局部刷新，不整条重建侧栏（否则会把正在输入的控件换掉） */
  function waterCountsHtml() {
    return '<li>水位记录 ' + ((state.levels || []).length) + ' 条</li>'
      + '<li>入库流量 ' + ((state.flows.inflow || []).length) + ' 条</li>'
      + '<li>出库流量 ' + ((state.flows.release || []).length) + ' 条</li>'
      + '<li>当天入库、是否超限取接口</li>';
  }

  function updateWaterCounts() {
    var box = el('waterCounts');
    if (box) box.innerHTML = waterCountsHtml();
  }

  function renderSidebar() {
    var box = el('sidebar');
    var view = state.view;
    var f = state.filters[view] || {};
    var html = [];

    if (view === 'overview') {
      html.push('<div class="side-block">');
      html.push('<h3>概览</h3>');
      html.push('<p class="side-note">指标卡与现状表都直接显示接口字段。</p>');
      html.push('<label class="field"><span>水库状态</span><select data-filter-key="status" data-filter-scope="overview">' + stringOptions(RESERVOIR_STATUSES, f.status, '全部状态') + '</select></label>');
      html.push('<button type="button" class="btn btn-ghost btn-sm" data-action="reset-filter" data-scope="overview">重置筛选</button>');
      html.push('</div>');
      html.push('<div class="side-block"><h3>口径</h3><ul class="side-list">');
      html.push('<li>限水位与是否超限取接口</li>');
      html.push('<li>预警等级取接口</li>');
      html.push('<li>点现状表某行去「水库」展开</li>');
      html.push('</ul></div>');
    } else if (view === 'reservoirs') {
      var basins = [];
      (state.reservoirs || []).forEach(function (r) {
        if (r.basin && basins.indexOf(r.basin) < 0) basins.push(r.basin);
      });
      html.push('<div class="side-block">');
      html.push('<h3>筛选水库</h3>');
      html.push('<label class="field"><span>流域</span><select data-filter-key="basin" data-filter-scope="reservoirs">' + stringOptions(basins, f.basin, '全部流域') + '</select></label>');
      html.push('<label class="field"><span>状态</span><select data-filter-key="status" data-filter-scope="reservoirs">' + stringOptions(RESERVOIR_STATUSES, f.status, '全部状态') + '</select></label>');
      html.push('<label class="field"><span>编号或名称</span><input type="text" data-filter-key="keyword" data-filter-scope="reservoirs" value="' + esc(f.keyword || '') + '" placeholder="输入即筛" /></label>');
      html.push('<button type="button" class="btn btn-ghost btn-sm" data-action="reset-filter" data-scope="reservoirs">重置筛选</button>');
      html.push('</div>');
      html.push('<div class="side-block"><h3>口径</h3><ul class="side-list">');
      html.push('<li>限水位 = 汛期取汛限、非汛期取正常蓄水位（接口给出）</li>');
      html.push('<li>曲线点表可编辑后保存</li>');
      html.push('</ul></div>');
    } else if (view === 'water') {
      html.push('<div class="side-block">');
      html.push('<h3>筛选水位与流量</h3>');
      html.push('<label class="field"><span>水库</span><select data-filter-key="reservoirId" data-filter-scope="water">' + reservoirOptions(f.reservoirId) + '</select></label>');
      html.push('<label class="field"><span>起始日期</span><input type="date" data-filter-key="from" data-filter-scope="water" value="' + esc(f.from || '') + '" /></label>');
      html.push('<label class="field"><span>结束日期</span><input type="date" data-filter-key="to" data-filter-scope="water" value="' + esc(f.to || '') + '" /></label>');
      html.push('<button type="button" class="btn btn-ghost btn-sm" data-action="reset-filter" data-scope="water">重置筛选</button>');
      html.push('</div>');
      html.push('<div class="side-block"><h3>当前口径</h3><ul class="side-list" id="waterCounts">' + waterCountsHtml() + '</ul></div>');
    } else if (view === 'forecast') {
      html.push('<div class="side-block">');
      html.push('<h3>筛选预报与对照</h3>');
      html.push('<label class="field"><span>水库</span><select data-filter-key="reservoirId" data-filter-scope="forecast">' + reservoirOptions(f.reservoirId) + '</select></label>');
      html.push('<label class="field"><span>起始日期</span><input type="date" data-filter-key="from" data-filter-scope="forecast" value="' + esc(f.from || '') + '" /></label>');
      html.push('<label class="field"><span>结束日期</span><input type="date" data-filter-key="to" data-filter-scope="forecast" value="' + esc(f.to || '') + '" /></label>');
      html.push('<button type="button" class="btn btn-ghost btn-sm" data-action="reset-filter" data-scope="forecast">重置筛选</button>');
      html.push('</div>');
      html.push('<div class="side-block"><h3>口径</h3><ul class="side-list">');
      html.push('<li>同一日期多次预报取最新一批</li>');
      html.push('<li>偏差 = 实测 − 预报</li>');
      html.push('<li>建议只出结论，不写任何数据</li>');
      html.push('<li>同一组预报重算结论一致（看输入指纹）</li>');
      html.push('</ul></div>');
      html.push('<div class="side-block"><h3>当前条数</h3><ul class="side-list" id="forecastCounts">' + forecastCountsHtml() + '</ul></div>');
    } else if (view === 'orders') {
      html.push('<div class="side-block">');
      html.push('<h3>筛选调度指令</h3>');
      html.push('<label class="field"><span>水库</span><select data-filter-key="reservoirId" data-filter-scope="orders">' + reservoirOptions(f.reservoirId) + '</select></label>');
      html.push('<label class="field"><span>状态</span><select data-filter-key="status" data-filter-scope="orders">' + stringOptions(ORDER_STATUSES, f.status, '全部状态') + '</select></label>');
      html.push('<button type="button" class="btn btn-ghost btn-sm" data-action="reset-filter" data-scope="orders">重置筛选</button>');
      html.push('</div>');
      html.push('<div class="side-block"><h3>口径</h3><ul class="side-list">');
      html.push('<li>实际均值与偏差取接口</li>');
      html.push('<li>删除一律两步确认</li>');
      html.push('</ul></div>');
    } else if (view === 'balance') {
      html.push('<div class="side-block">');
      html.push('<h3>水量平衡口径</h3><ul class="side-list">');
      html.push('<li>流量按每天 86400 秒换算</li>');
      html.push('<li>损失按天 × 每天损失</li>');
      html.push('<li>残差不超过容差才算平衡</li>');
      html.push('<li>所有数字取接口字段</li>');
      html.push('</ul></div>');
      html.push('<div class="side-block"><h3>当前设置</h3><ul class="side-list">');
      html.push('<li>每天损失 ' + esc(dash(state.settings ? state.settings.lossPerDayWan : '')) + ' 万m³</li>');
      html.push('<li>容差 ' + esc(dash(state.settings ? state.settings.balanceToleranceWan : '')) + ' 万m³</li>');
      html.push('<li>汛期 ' + esc(dash(state.settings ? state.settings.floodSeasonStart + ' 至 ' + state.settings.floodSeasonEnd : '')) + '</li>');
      html.push('</ul></div>');
    }

    box.innerHTML = html.join('');
  }

  /* ================= 顶部工具栏 ================= */

  function renderTopbar() {
    var s = state.summary;
    if (s) {
      el('todayLabel').textContent = s.today;
      el('seasonPill').textContent = '汛期 ' + s.floodSeason;
    } else {
      el('todayLabel').textContent = todayIso();
    }
  }

  /* ================= 概览 ================= */

  function metricCard(label, value, foot, jump, filter, accent) {
    return '<button type="button" class="metric-card' + (accent ? ' is-accent' : '') + '" data-action="card-jump" data-jump="' + esc(jump) + '"'
      + (filter ? ' data-filter="' + esc(filter) + '"' : '') + '>'
      + '<span class="metric-label">' + esc(label) + '</span>'
      + '<span class="metric-value">' + esc(value) + '</span>'
      + '<span class="metric-foot">' + esc(foot) + '</span>'
      + '</button>';
  }

  function renderOverview() {
    var box = el('overviewCards');
    var s = state.summary;
    if (!s) {
      box.innerHTML = '<p class="empty">指标还在加载…</p>';
    } else {
      var active = s.activeOrders;
      box.innerHTML = [
        metricCard('水库数', s.reservoirCount, '点卡去「水库」标签', 'reservoirs', ''),
        metricCard('运行中', s.runningCount, '点卡带状态筛选去「水库」', 'reservoirs', 'status=运行'),
        metricCard('水位记录数', s.levelCount, '点卡去「水位与流量」', 'water', 'kind=level'),
        metricCard('超限记录数', s.exceededCount, '点卡去「水位与流量」逐条核对', 'water', 'kind=level', true),
        metricCard('指令数', s.orderCount, '点卡去「调度指令」', 'orders', ''),
        metricCard('执行中加已下达', active, '执行中与已下达合计', 'orders', ''),
        metricCard('偏差超限指令数', s.orderDeviationCount, '偏差绝对值大于 5 的指令', 'orders', '', true),
        metricCard('每天损失', s.lossPerDayWan, '单位 万m³，可去设置里改', 'balance', ''),
        metricCard('容差', s.toleranceWan, '单位 万m³，可去设置里改', 'balance', '')
      ].join('');
    }

    var f = state.filters.overview;
    var rows = (s && s.reservoirs ? s.reservoirs : []).filter(function (r) {
      return !f.status || r.status === f.status;
    });
    var tbody = el('overviewRows');
    var colspan = columnCount('overviewRows');
    if (!rows.length) {
      tbody.innerHTML = emptyRow(colspan, s ? '没有符合筛选的水库。' : '数据还在加载…');
      return;
    }
    tbody.innerHTML = rows.map(function (r) {
      return '<tr class="overview-row" data-action="open-reservoir" data-reservoir-id="' + esc(r.id) + '">'
        + '<td>' + esc(r.code) + '</td>'
        + '<td>' + esc(r.name) + '</td>'
        + '<td>' + statusTag(r.status) + '</td>'
        + '<td>' + esc(dash(r.date)) + '</td>'
        + '<td class="num">' + esc(numText(r.level)) + '</td>'
        + '<td class="num">' + esc(numText(r.limit)) + '</td>'
        + '<td class="num">' + esc(numText(r.over)) + '</td>'
        + '<td class="num">' + esc(numText(r.inflow)) + '</td>'
        + '<td>' + warningTag(r.warning) + '</td>'
        + '<td>' + boolTag(r.exceeded) + '</td>'
        + '</tr>';
    }).join('');
  }

  /* ================= 水库 ================= */

  function filteredReservoirs() {
    var f = state.filters.reservoirs;
    var keyword = String(f.keyword || '').trim();
    return (state.reservoirs || []).filter(function (r) {
      if (f.status && r.status !== f.status) return false;
      if (f.basin && r.basin !== f.basin) return false;
      if (keyword && String(r.name || '').indexOf(keyword) < 0 && String(r.code || '').indexOf(keyword) < 0) return false;
      return true;
    });
  }

  function renderReservoirs() {
    var rows = filteredReservoirs();
    var tbody = el('reservoirRows');
    var colspan = columnCount('reservoirRows');
    el('reservoirCount').textContent = '共 ' + rows.length + ' 座';
    if (!rows.length) {
      tbody.innerHTML = emptyRow(colspan, (state.reservoirs || []).length ? '没有符合筛选的水库。' : '数据还在加载…');
      return;
    }
    var html = [];
    rows.forEach(function (r) {
      var expanded = state.expanded.reservoir === r.id;
      html.push('<tr class="reservoir-row' + (expanded ? ' is-expanded' : '') + '" data-action="toggle-reservoir" data-reservoir-id="' + esc(r.id) + '">'
        + '<td>' + esc(r.code) + '</td>'
        + '<td>' + esc(r.name) + '</td>'
        + '<td>' + esc(dash(r.basin)) + '</td>'
        + '<td>' + statusTag(r.status) + '</td>'
        + '<td class="num">' + esc(numText(r.normalLevel)) + '</td>'
        + '<td class="num">' + esc(numText(r.floodLimitLevel)) + '</td>'
        + '<td class="num">' + esc(numText(r.deadLevel)) + '</td>'
        + '<td class="num">' + esc(numText(r.warningLevel)) + '</td>'
        + '<td class="num">' + esc(numText(r.pointCount)) + '</td>'
        + '<td>' + esc(dash(r.curveVerifiedOn)) + '</td>'
        + '<td class="num">' + esc(numText(r.latestLevel)) + '</td>'
        + '<td class="num">' + esc(numText(r.limitNow)) + '</td>'
        + '</tr>');
      if (expanded) html.push(reservoirDetailHtml(r, colspan));
    });
    tbody.innerHTML = html.join('');
  }

  function reservoirDetailHtml(r, colspan) {
    var d = (state.reservoirDetail && state.reservoirDetail.id === r.id) ? state.reservoirDetail : null;
    if (!d) {
      return '<tr class="detail-row" data-detail-for="' + esc(r.id) + '"><td colspan="' + colspan + '"><div class="detail">'
        + '<p class="empty">正在载入 ' + esc(r.name) + ' 的详情…</p></div></td></tr>';
    }
    var lc = d.levelCheck || {};
    var caliberItems = [
      ['编号', d.code],
      ['流域', d.basin],
      ['状态', d.status],
      ['正常蓄水位', d.normalLevel],
      ['汛限水位', d.floodLimitLevel],
      ['死水位', d.deadLevel],
      ['警戒水位', d.warningLevel],
      ['当前限水位', d.limitNow],
      ['口径日期', d.today],
      ['最新水位', d.latestLevel],
      ['最新水位日期', d.latestLevelDate],
      ['水位超出', d.over === null || d.over === undefined ? lc.over : d.over],
      ['是否超限', lc.exceeded === undefined ? '' : yesNo(lc.exceeded)],
      ['是否汛期', lc.floodSeason === undefined ? '' : yesNo(lc.floodSeason)],
      ['检查用限水位', lc.limit],
      ['检查用水位', lc.level],
      ['曲线点数', d.pointCount],
      ['曲线复核日期', d.curveVerifiedOn],
      ['正常蓄水位对应库容', d.capacityAtNormal],
      ['汛限水位对应库容', d.capacityAtFloodLimit],
      ['防洪库容差', d.floodCapacityGap],
      ['备注', d.remark]
    ];

    var draft = (state.curveDraft && state.curveDraft.reservoirId === r.id) ? state.curveDraft : null;
    var points = draft ? draft.points : ((d.curve && d.curve.points) ? d.curve.points.map(function (p) {
      return { level: p.level, capacity: p.capacity };
    }) : []);

    var pointRows = points.map(function (p, index) {
      return '<tr data-curve-row="' + index + '">'
        + '<td class="num">' + (index + 1) + '</td>'
        + '<td><input type="number" step="0.01" data-curve-field="level" value="' + esc(p.level) + '" /></td>'
        + '<td><input type="number" step="0.01" data-curve-field="capacity" value="' + esc(p.capacity) + '" /></td>'
        + '<td><em class="field-msg" data-field-error="points.' + index + '" hidden></em></td>'
        + '<td><button type="button" class="btn btn-sm" data-action="remove-curve-point" data-index="' + index + '">删掉这行</button></td>'
        + '</tr>';
    }).join('');

    var query = state.curveQuery.reservoirId === r.id ? state.curveQuery : { reservoirId: r.id, byLevel: null, byCapacity: null };

    return '<tr class="detail-row" data-detail-for="' + esc(r.id) + '"><td colspan="' + colspan + '"><div class="detail" data-reservoir-id="' + esc(r.id) + '">'
      + '<h4>水位口径（全部取接口字段）</h4>'
      + '<div class="detail-grid">' + caliberItems.map(itemHtml).join('') + '</div>'

      + '<h4>水位-库容曲线点表 <span class="card-sub">接口 ' + esc(dash(d.curveId)) + '，复核日期 ' + esc(dash(d.curveVerifiedOn)) + '，共 ' + points.length + ' 点；保存走整条替换</span></h4>'
      + '<div class="inline-form">'
      + '<label class="field"><span>复核日期</span><input type="date" id="curveVerifiedOn" value="' + esc(draft ? draft.verifiedOn : (d.curve ? d.curve.verifiedOn : '')) + '" /></label>'
      + '<label class="field"><span>曲线备注</span><input type="text" id="curveRemark" value="' + esc(draft ? draft.remark : (d.curve ? (d.curve.remark || '') : '')) + '" /></label>'
      + '</div>'
      + '<table class="mini-table"><thead><tr><th>序号</th><th>水位（m）</th><th>库容（万m³）</th><th>校验提示</th><th>操作</th></tr></thead>'
      + '<tbody id="curvePoints">' + (pointRows || '<tr><td colspan="5">这条曲线还没有点，先「增加一行」。</td></tr>') + '</tbody></table>'
      + '<div class="detail-actions">'
      + '<button type="button" class="btn btn-sm" data-action="add-curve-point" data-reservoir-id="' + esc(r.id) + '">增加一行</button>'
      + '<button type="button" class="btn btn-primary btn-sm" data-action="save-curve" data-reservoir-id="' + esc(r.id) + '">保存曲线</button>'
      + '</div>'
      + '<div class="form-error" data-role="curve-error" hidden></div>'

      + '<h4>曲线查询 <span class="card-sub">接口 <code>GET /api/curve/query</code>，两边结果都显示出来</span></h4>'
      + '<div class="inline-form">'
      + '<label class="field"><span>按水位查库容：水位（m）</span><input type="number" step="0.01" id="curveLevelInput" placeholder="97.5" /></label>'
      + '<button type="button" class="btn btn-sm" data-action="query-curve-level" data-reservoir-id="' + esc(r.id) + '">查库容</button>'
      + '<label class="field"><span>按库容反查水位：库容（万m³）</span><input type="number" step="0.01" id="curveCapacityInput" placeholder="3000" /></label>'
      + '<button type="button" class="btn btn-sm" data-action="query-curve-capacity" data-reservoir-id="' + esc(r.id) + '">反查水位</button>'
      + '</div>'
      + '<div class="detail-grid">'
      + itemHtml(['按水位查到的库容', query.byLevel ? query.byLevel.capacity : '（还没查）'])
      + itemHtml(['按库容反查到的水位', query.byCapacity ? query.byCapacity.level : '（还没查）'])
      + itemHtml(['反查时接口附带的曲线水位', query.byCapacity ? query.byCapacity.levelByCurve : '（还没查）'])
      + itemHtml(['曲线点数', query.pointCount || d.pointCount])
      + '</div>'

      + '<h4>该库记录条数</h4>'
      + '<div class="detail-grid">'
      + itemHtml(['水位记录', (d.levels || []).length])
      + itemHtml(['入库流量', (d.inflows || []).length])
      + itemHtml(['出库流量', (d.releases || []).length])
      + itemHtml(['调度指令', (d.orders || []).length])
      + itemHtml(['水位记录数（派生）', d.levelCount])
      + '</div>'
      + '</div></td></tr>';
  }

  function readCurveDraftFromDom() {
    if (!state.curveDraft) return;
    var rows = qsa('#curvePoints tr[data-curve-row]');
    state.curveDraft.points = rows.map(function (tr) {
      return {
        level: qs('[data-curve-field="level"]', tr).value,
        capacity: qs('[data-curve-field="capacity"]', tr).value
      };
    });
    var verified = el('curveVerifiedOn');
    var remark = el('curveRemark');
    if (verified) state.curveDraft.verifiedOn = verified.value;
    if (remark) state.curveDraft.remark = remark.value;
  }

  /* ================= 水位与流量 ================= */

  function setWaterKind(kind) {
    state.waterKind = kind;
    qsa('#waterSubtabs .subtab').forEach(function (btn) {
      btn.classList.toggle('is-active', btn.dataset.kind === kind);
    });
    [['level', 'levelPanel'], ['inflow', 'inflowPanel'], ['release', 'releasePanel']].forEach(function (pair) {
      var panel = el(pair[1]);
      if (!panel) return;
      if (pair[0] === kind) panel.removeAttribute('hidden');
      else panel.setAttribute('hidden', '');
    });
  }

  async function loadWaterRecords() {
    var f = state.filters.water;
    state.levels = await api('GET', '/api/levels' + queryString({ reservoirId: f.reservoirId, from: f.from, to: f.to }));
    state.flows.inflow = await api('GET', '/api/flows' + queryString({ kind: 'inflow', reservoirId: f.reservoirId, from: f.from, to: f.to }));
    state.flows.release = await api('GET', '/api/flows' + queryString({ kind: 'release', reservoirId: f.reservoirId, from: f.from, to: f.to }));
  }

  function renderWater() {
    /* 水位记录表 */
    var levelColspan = columnCount('levelRows');
    var levels = state.levels || [];
    var levelHtml = [];
    levels.forEach(function (l) {
      var expanded = state.expanded.level === l.id;
      levelHtml.push('<tr class="level-row' + (expanded ? ' is-expanded' : '') + '" data-action="toggle-level" data-id="' + esc(l.id) + '">'
        + '<td>' + esc(dash(l.date)) + '</td>'
        + '<td>' + esc(dash(l.time)) + '</td>'
        + '<td>' + esc(dash(l.reservoirName)) + '</td>'
        + '<td class="num">' + esc(numText(l.level)) + '</td>'
        + '<td class="num">' + esc(numText(l.limit)) + '</td>'
        + '<td class="num">' + esc(numText(l.over)) + '</td>'
        + '<td>' + esc(yesNo(l.floodSeason)) + '</td>'
        + '<td>' + boolTag(l.exceeded) + '</td>'
        + '<td class="num">' + esc(numText(l.inflow)) + '</td>'
        + '<td>' + warningTag(l.warning) + '</td>'
        + '<td><span class="tag">展开</span></td>'
        + '</tr>');
      if (expanded) {
        var items = [
          ['记录编号', l.id],
          ['水库', l.reservoirName],
          ['来源', l.source],
          ['记录人', l.recorder],
          ['限水位（接口）', l.limit],
          ['超出（接口）', l.over],
          ['是否汛期（接口）', yesNo(l.floodSeason)],
          ['是否超限（接口）', yesNo(l.exceeded)],
          ['当天入库（接口）', l.inflow],
          ['预警等级（接口）', l.warning],
          ['备注', l.remark]
        ];
        levelHtml.push('<tr class="detail-row" data-detail-for="' + esc(l.id) + '"><td colspan="' + levelColspan + '"><div class="detail">'
          + '<div class="detail-grid">' + items.map(itemHtml).join('') + '</div>'
          + '<div class="detail-actions">'
          + '<button type="button" class="btn btn-sm" data-action="delete-level" data-id="' + esc(l.id) + '">删除这条水位</button>'
          + '</div></div></td></tr>');
      }
    });
    el('levelRows').innerHTML = levelHtml.length ? levelHtml.join('') : emptyRow(levelColspan, levels.length ? '没有符合筛选的水位记录。' : '数据还在加载…');

    /* 入库 / 出库流量表 */
    renderFlowTable('inflow');
    renderFlowTable('release');
  }

  function renderFlowTable(kind) {
    var tbodyId = kind === 'inflow' ? 'inflowRows' : 'releaseRows';
    var tbody = el(tbodyId);
    if (!tbody) return;
    var colspan = columnCount(tbodyId);
    var rows = state.flows[kind] || [];
    var html = [];
    rows.forEach(function (row) {
      var key = kind + ':' + row.id;
      var expanded = state.expanded.flow === key;
      html.push('<tr class="flow-row' + (expanded ? ' is-expanded' : '') + '" data-action="toggle-flow" data-kind="' + esc(kind) + '" data-id="' + esc(row.id) + '">'
        + '<td>' + esc(dash(row.date)) + '</td>'
        + '<td>' + esc(dash(row.reservoirName)) + '</td>'
        + '<td class="num">' + esc(numText(row.flow)) + '</td>'
        + '<td>' + esc(dash(row.type)) + '</td>'
        + '<td class="num">' + esc(numText(row.volumeWan)) + '</td>'
        + '<td><span class="tag">展开</span></td>'
        + '</tr>');
      if (expanded) {
        var items = [
          ['记录编号', row.id],
          ['类型（入库/出库）', kind === 'inflow' ? '入库' : '出库'],
          ['数据类别', row.type],
          ['记录人', row.operator],
          ['流量（接口）', row.flow],
          ['对应水量（接口）', row.volumeWan],
          ['备注', row.remark]
        ];
        html.push('<tr class="detail-row" data-detail-for="' + esc(row.id) + '"><td colspan="' + colspan + '"><div class="detail">'
          + '<div class="detail-grid">' + items.map(itemHtml).join('') + '</div>'
          + '<div class="detail-actions">'
          + '<button type="button" class="btn btn-sm" data-action="delete-flow" data-kind="' + esc(kind) + '" data-id="' + esc(row.id) + '">删除这条流量</button>'
          + '</div></div></td></tr>');
      }
    });
    tbody.innerHTML = html.length ? html.join('') : emptyRow(colspan, rows.length ? '没有符合筛选的流量记录。' : '数据还在加载…');
  }

  /* ================= 调度指令 ================= */

  function ordersQuery() {
    var f = state.filters.orders;
    return queryString({ reservoirId: f.reservoirId, status: f.status });
  }

  function renderOrders() {
    var rows = state.orders || [];
    var tbody = el('orderRows');
    var colspan = columnCount('orderRows');
    el('orderCount').textContent = '共 ' + rows.length + ' 条';
    if (!rows.length) {
      tbody.innerHTML = emptyRow(colspan, rows.length ? '没有符合筛选的指令。' : '数据还在加载…');
      return;
    }
    var html = [];
    rows.forEach(function (o) {
      var expanded = state.expanded.order === o.id;
      var attachCount = (o.attachments || []).length;
      html.push('<tr class="order-row' + (expanded ? ' is-expanded' : '') + '" data-action="toggle-order" data-id="' + esc(o.id) + '">'
        + '<td>' + esc(o.code) + '</td>'
        + '<td>' + esc(dash(o.reservoirName)) + '</td>'
        + '<td>' + esc(dash(o.issuedAt)) + '</td>'
        + '<td class="num">' + esc(numText(o.targetFlow)) + '</td>'
        + '<td>' + esc(dash(o.windowStart)) + ' 至 ' + esc(dash(o.windowEnd)) + '</td>'
        + '<td><span class="tag is-strong">' + esc(dash(o.status)) + '</span></td>'
        + '<td class="num">' + esc(numText(o.actualMean)) + '</td>'
        + '<td class="num">' + esc(numText(o.deviation)) + '</td>'
        + '<td class="num">' + attachCount + '</td>'
        + '</tr>');

      if (expanded) {
        var items = [
          ['理由', o.reason],
          ['下达人', o.issuer],
          ['备注', o.remark],
          ['实际均值（接口）', o.actualMean],
          ['偏差（接口）', o.deviation],
          ['时段内出库记录条数', o.releaseCount],
          ['当前状态', o.status]
        ];
        var attach = (o.attachments || []).map(function (a) {
          return '<li>' + esc(a.name) + '（' + esc(dash(a.note)) + '，' + esc(dash(a.at)) + '）</li>';
        }).join('');
        var statusOptions = ORDER_STATUSES.map(function (s) {
          return '<option value="' + esc(s) + '"' + (s === o.status ? ' selected' : '') + '>' + esc(s) + '</option>';
        }).join('');

        html.push('<tr class="detail-row" data-detail-for="' + esc(o.id) + '"><td colspan="' + colspan + '"><div class="detail" data-order-id="' + esc(o.id) + '">'
          + '<div class="detail-grid">' + items.map(itemHtml).join('') + '</div>'

          + '<h4>附件清单 <span class="card-sub">接口 <code>POST /api/orders/:id/attachments</code>，共 ' + attachCount + ' 件</span></h4>'
          + (attach ? '<ul class="attach-list">' + attach + '</ul>' : '<p class="empty">还没有附件。</p>')
          + '<div class="inline-form">'
          + '<label class="field"><span>附件名称</span><input type="text" data-order-field="attachName" placeholder="灌溉用水申请" /></label>'
          + '<label class="field"><span>附件说明</span><input type="text" data-order-field="attachNote" placeholder="镇水利站报送" /></label>'
          + '<button type="button" class="btn btn-sm" data-action="add-attachment" data-id="' + esc(o.id) + '">新增附件</button>'
          + '</div>'

          + '<h4>改状态与修改 <span class="card-sub">接口 <code>PATCH /api/orders/:id</code></span></h4>'
          + '<div class="inline-form">'
          + '<label class="field"><span>目标下泄流量</span><input type="number" step="0.01" data-order-field="targetFlow" value="' + esc(numText(o.targetFlow) === '—' ? '' : o.targetFlow) + '" /></label>'
          + '<label class="field"><span>时段起</span><input type="date" data-order-field="windowStart" value="' + esc(o.windowStart) + '" /></label>'
          + '<label class="field"><span>时段止</span><input type="date" data-order-field="windowEnd" value="' + esc(o.windowEnd) + '" /></label>'
          + '<label class="field"><span>状态</span><select data-order-field="status">' + statusOptions + '</select></label>'
          + '<button type="button" class="btn btn-primary btn-sm" data-action="save-order" data-id="' + esc(o.id) + '">保存修改</button>'
          + '</div>'

          + '<div class="detail-actions">'
          + '<button type="button" class="btn btn-sm" data-action="copy-order" data-id="' + esc(o.id) + '">复制这条指令</button>'
          + '<button type="button" class="btn btn-sm" data-action="delete-order" data-id="' + esc(o.id) + '">删除这条指令</button>'
          + '</div>'
          + '<div class="form-error" data-role="order-error" hidden></div>'
          + '</div></td></tr>');
      }
    });
    tbody.innerHTML = html.join('');
  }

  /* ================= 来水预报 ================= */

  /* 时间线与调度建议都按「当前水库」算：侧栏选了就用侧栏的，没选用第一座 */
  function forecastReservoirId() {
    var picked = state.filters.forecast.reservoirId;
    if (picked) return picked;
    return state.reservoirs && state.reservoirs.length ? state.reservoirs[0].id : '';
  }

  async function loadForecastData() {
    var f = state.filters.forecast;
    state.forecasts = await api('GET', '/api/forecasts' + queryString({ reservoirId: f.reservoirId, from: f.from, to: f.to }));
    var rid = forecastReservoirId();
    if (rid) {
      state.timeline = await api('GET', '/api/forecasts/timeline' + queryString({ reservoirId: rid, from: f.from, to: f.to }));
      state.suggest = await api('GET', '/api/forecasts/suggest' + queryString({ reservoirId: rid }));
    } else {
      state.timeline = null;
      state.suggest = null;
    }
  }

  function forecastCountsHtml() {
    var t = state.timeline;
    return '<li>预报 ' + ((state.forecasts || []).length) + ' 批</li>'
      + '<li>时间线 ' + (t && t.summary ? t.summary.days : 0) + ' 天</li>'
      + '<li>有对照 ' + (t && t.summary ? t.summary.comparedDays : 0) + ' 天</li>';
  }

  function updateForecastCounts() {
    var box = el('forecastCounts');
    if (box) box.innerHTML = forecastCountsHtml();
  }

  function freshForecastDraft() {
    var today = todayIso();
    return {
      reservoirId: forecastReservoirId(),
      issuedAt: today,
      issuedTime: '08:00',
      forecaster: '',
      basis: '',
      items: [
        { date: addDays(today, 1), flow: '' },
        { date: addDays(today, 2), flow: '' },
        { date: addDays(today, 3), flow: '' }
      ]
    };
  }

  function readForecastDraftFromDom() {
    var form = el('forecastForm');
    if (!form) return;
    var values = formValues(form);
    var draft = state.forecastDraft || freshForecastDraft();
    draft.reservoirId = values.reservoirId || draft.reservoirId;
    draft.issuedAt = values.issuedAt || '';
    draft.issuedTime = values.issuedTime || '';
    draft.forecaster = values.forecaster || '';
    draft.basis = values.basis || '';
    draft.items = qsa('#forecastItems tr[data-forecast-row]').map(function (tr) {
      return {
        date: qs('[data-forecast-field="date"]', tr).value,
        flow: qs('[data-forecast-field="flow"]', tr).value
      };
    });
    state.forecastDraft = draft;
  }

  function renderForecastItems() {
    var tbody = el('forecastItems');
    if (!tbody) return;
    var draft = state.forecastDraft || freshForecastDraft();
    state.forecastDraft = draft;
    tbody.innerHTML = draft.items.map(function (item, index) {
      return '<tr data-forecast-row="' + index + '">'
        + '<td class="num">' + (index + 1) + '</td>'
        + '<td><input type="date" data-forecast-field="date" value="' + esc(item.date) + '" /></td>'
        + '<td><input type="number" step="0.01" data-forecast-field="flow" value="' + esc(item.flow) + '" placeholder="70" /></td>'
        + '<td><em class="field-msg" data-field-error="items.' + index + '" hidden></em></td>'
        + '<td><button type="button" class="btn btn-sm" data-action="remove-forecast-item" data-index="' + index + '">删掉这行</button></td>'
        + '</tr>';
    }).join('');
  }

  function renderForecast() {
    renderForecastItems();
    renderForecastList();
    renderTimeline();
    renderSuggest();
    updateForecastCounts();
  }

  function renderForecastList() {
    var rows = state.forecasts || [];
    var tbody = el('forecastRows');
    var colspan = columnCount('forecastRows');
    el('forecastCount').textContent = '共 ' + rows.length + ' 批';
    if (!rows.length) {
      tbody.innerHTML = emptyRow(colspan, '还没有预报，先在上方「登记预报」里报一批。');
      return;
    }
    var html = [];
    rows.forEach(function (f) {
      var expanded = state.expanded.forecast === f.id;
      html.push('<tr class="forecast-row' + (expanded ? ' is-expanded' : '') + '" data-action="toggle-forecast" data-id="' + esc(f.id) + '">'
        + '<td>' + esc(dash(f.issuedAt)) + '</td>'
        + '<td>' + esc(dash(f.issuedTime)) + '</td>'
        + '<td>' + esc(dash(f.reservoirName)) + '</td>'
        + '<td>' + esc(dash(f.forecaster)) + '</td>'
        + '<td class="num">' + esc(numText(f.itemCount)) + '</td>'
        + '<td>' + esc(dash(f.dateStart)) + ' 至 ' + esc(dash(f.dateEnd)) + '</td>'
        + '<td class="num">' + esc(numText(f.meanFlow)) + '</td>'
        + '<td>' + esc(dash(f.basis)) + '</td>'
        + '<td><span class="tag">展开</span></td>'
        + '</tr>');
      if (expanded) {
        var itemRows = (f.items || []).map(function (it, index) {
          return '<tr><td class="num">' + (index + 1) + '</td><td>' + esc(it.date) + '</td><td class="num">' + esc(numText(it.flow)) + '</td></tr>';
        }).join('');
        html.push('<tr class="detail-row" data-detail-for="' + esc(f.id) + '"><td colspan="' + colspan + '"><div class="detail">'
          + '<div class="detail-grid">'
          + itemHtml(['批次编号', f.id])
          + itemHtml(['预报人', f.forecaster])
          + itemHtml(['预报时刻', f.issuedAt + ' ' + f.issuedTime])
          + itemHtml(['预报依据', f.basis])
          + '</div>'
          + '<h4>逐日预报流量</h4>'
          + '<table class="mini-table"><thead><tr><th>序号</th><th>日期</th><th class="num">预报入库流量（m³/s）</th></tr></thead><tbody>' + itemRows + '</tbody></table>'
          + '<div class="detail-actions">'
          + '<button type="button" class="btn btn-sm" data-action="delete-forecast" data-id="' + esc(f.id) + '">删除这批预报</button>'
          + '</div></div></td></tr>');
      }
    });
    tbody.innerHTML = html.join('');
  }

  function renderTimeline() {
    var tbody = el('timelineRows');
    var colspan = columnCount('timelineRows');
    var t = state.timeline;
    if (!t) {
      el('timelineSub').textContent = '先在侧栏选一个水库';
      el('timelineSummary').innerHTML = '';
      tbody.innerHTML = emptyRow(colspan, '先在侧栏选一个水库。');
      return;
    }
    el('timelineSub').textContent = '水库 ' + t.reservoirName + '；同一日期多次预报取最新一批，偏差 = 实测 − 预报';
    var s = t.summary || {};
    el('timelineSummary').innerHTML = [
      ['时间线天数', s.days],
      ['有实测天数', s.measuredDays],
      ['有预报天数', s.forecastDays],
      ['可对照天数', s.comparedDays],
      ['平均偏差（m³/s）', s.meanDeviation],
      ['平均绝对偏差（m³/s）', s.meanAbsDeviation],
      ['平均绝对偏差率（%）', s.meanAbsDeviationPct]
    ].map(itemHtml).join('');
    var rows = t.rows || [];
    if (!rows.length) {
      tbody.innerHTML = emptyRow(colspan, '这个时段既没有实测也没有预报。');
      return;
    }
    tbody.innerHTML = rows.map(function (r) {
      var usedForecast = r.forecastId
        ? r.issuedAt + ' ' + r.issuedTime + ' ' + r.forecaster + '（' + r.forecastId + '）'
        : '—';
      return '<tr>'
        + '<td>' + esc(r.date) + '</td>'
        + '<td class="num">' + esc(numText(r.measured)) + '</td>'
        + '<td class="num">' + esc(numText(r.forecast)) + '</td>'
        + '<td class="num">' + esc(signedText(r.deviation)) + '</td>'
        + '<td class="num">' + esc(r.deviationPct === null || r.deviationPct === undefined ? '—' : signedText(r.deviationPct) + '%') + '</td>'
        + '<td class="num">' + esc(numText(r.leadDays)) + '</td>'
        + '<td>' + esc(usedForecast) + '</td>'
        + '</tr>';
    }).join('');
  }

  function renderSuggest() {
    var box = el('suggestResult');
    var s = state.suggest;
    if (!s) {
      box.innerHTML = '<p class="empty">正在计算…</p>';
      return;
    }
    var html = [];
    if (!s.usable) {
      html.push('<p class="empty">' + esc(s.reason) + '</p>');
    } else {
      var a = s.advice || {};
      html.push('<div class="result-grid">'
        + resultItem('建议下泄区间（m³/s）', a.releaseMin + ' ~ ' + a.releaseMax, true)
        + resultItem('建议目标下泄（m³/s）', a.suggestedFlow)
        + resultItem('建议指令条数', a.orderCount + ' 条（每天一条）', a.orderCount > 0)
        + resultItem('时段末水位（按建议）', a.endLevelAtSuggested + ' m')
        + resultItem('水位变化（按建议）', signedText(a.levelChangeAtSuggested) + ' m', Number(a.levelChangeAtSuggested) < 0)
        + resultItem('不泄流时段末水位', a.endLevelNoRelease + ' m')
        + '</div>');
    }
    if (s.current) {
      html.push('<h4>当前水情（接口字段）</h4><div class="detail-grid">'
        + itemHtml(['水位日期', s.current.levelDate])
        + itemHtml(['当前水位', s.current.level + ' m'])
        + itemHtml(['限水位', s.current.limit + ' m'])
        + itemHtml(['是否汛期', yesNo(s.current.floodSeason)])
        + itemHtml(['超出限水位', signedText(s.current.overLimitLevel) + ' m'])
        + '</div>');
    }
    if (s.storage) {
      html.push('<h4>库容账（万m³，接口字段）</h4><div class="detail-grid">'
        + itemHtml(['当前库容', s.storage.currentWan])
        + itemHtml(['限水位对应库容', s.storage.limitWan])
        + itemHtml(['死水位对应库容', s.storage.deadWan])
        + itemHtml(['压回限水位需腾出', s.storage.overLimitWan])
        + itemHtml(['可腾至死水位', s.storage.freeableToDeadWan])
        + '</div>');
    }
    if (s.forecast && s.forecast.days) {
      var batches = (s.forecast.batchesUsed || []).map(function (b) {
        return '<li>' + esc(b.id) + '：' + esc(b.issuedAt) + ' ' + esc(b.issuedTime) + ' ' + esc(b.forecaster)
          + '，依据「' + esc(b.basis) + '」，覆盖 ' + esc(b.dates.join('、')) + '</li>';
      }).join('');
      html.push('<h4>采用的预报（接口字段）</h4><div class="detail-grid">'
        + itemHtml(['覆盖天数', s.forecast.days])
        + itemHtml(['日期范围', s.forecast.dateStart + ' 至 ' + s.forecast.dateEnd])
        + itemHtml(['平均入库流量', s.forecast.meanInflow + ' m³/s'])
        + itemHtml(['入库水量', s.forecast.inflowVolumeWan + ' 万m³'])
        + itemHtml(['损失水量', s.forecast.lossVolumeWan + ' 万m³'])
        + '</div>'
        + '<ul class="attach-list">' + batches + '</ul>');
    }
    if (s.algorithm && s.algorithm.length) {
      html.push('<h4>算法与依据（一行行写出来，数字全部取接口字段）</h4><ul class="caliber">'
        + s.algorithm.map(function (line) { return '<li>' + esc(line) + '</li>'; }).join('')
        + '</ul>');
    }
    html.push('<p class="side-note">输入指纹 <b>' + esc(s.inputHash || '') + '</b>（计算日 ' + esc(s.computedOn || '') + '）：本建议只出结论、不写任何数据；同一组预报与水位重算，指纹与结论必然一致。</p>');
    box.innerHTML = html.join('');
  }

  async function submitForecast(form) {
    var errorBox = el('forecastFormError');
    clearFormError(errorBox);
    readForecastDraftFromDom();
    var d = state.forecastDraft;
    try {
      var result = await api('POST', '/api/forecasts', {
        reservoirId: d.reservoirId,
        issuedAt: d.issuedAt,
        issuedTime: d.issuedTime,
        forecaster: d.forecaster,
        basis: d.basis,
        items: d.items.map(function (it) { return { date: it.date, flow: Number(it.flow) }; })
      });
      toast(result && result.updated ? '同库同时刻的预报已覆盖更新' : '预报已登记');
      state.forecastDraft = freshForecastDraft();
      await reloadView('forecast');
    } catch (err) {
      showError(err, errorBox);
    }
  }

  /* ================= 水量平衡 ================= */

  function resultItem(label, value, accent) {
    return '<div class="item' + (accent ? ' is-strong' : '') + '"><span class="k">' + esc(label) + '</span><span class="v">' + esc(dash(value)) + '</span></div>';
  }

  function renderBalance() {
    var box = el('balanceResult');
    var b = state.balance;
    if (!b) {
      box.innerHTML = '<p class="empty">先选水库与起止日期，再点「计算」。</p>';
      return;
    }
    var settings = state.settings || {};
    box.innerHTML = '<div class="detail-grid">'
      + itemHtml(['水库', b.reservoirName])
      + itemHtml(['起始日期', b.fromDate])
      + itemHtml(['结束日期', b.toDate])
      + itemHtml(['天数', b.days])
      + '</div>'
      + '<div class="result-grid">'
      + resultItem('入库水量（万m³）', b.inflowVolume)
      + resultItem('出库水量（万m³）', b.releaseVolume)
      + resultItem('损失（万m³）', b.lossVolume)
      + resultItem('蓄变（万m³）', b.deltaStorage)
      + resultItem('残差（万m³）', b.residual, true)
      + resultItem('容差（万m³）', b.tolerance)
      + resultItem('是否平衡', b.balanced === true ? '平衡' : (b.balanced === false ? '不平衡' : '—'), b.balanced === false)
      + '</div>'
      + '<h4>口径（一行行写出来，数字全部取接口字段）</h4>'
      + '<ul class="caliber">'
      + '<li>口径一：流量按每天 <b>86400</b> 秒换算成水量，再除以 10000 折算成万m³。</li>'
      + '<li>口径二：损失按 <b>天数 × 每天损失</b>，每天损失取设置里的 ' + esc(dash(settings.lossPerDayWan)) + ' 万m³。</li>'
      + '<li>口径三：残差 = 入库水量 − 出库水量 − 损失 − 蓄变；残差不超过容差才算平衡。</li>'
      + '<li>入库水量：平均入库流量 <b>' + esc(numText(b.meanInflow)) + '</b> m³/s × 天数 <b>' + esc(numText(b.days)) + '</b> × 86400 ÷ 10000，接口返回 <b>' + esc(numText(b.inflowVolume)) + '</b> 万m³。</li>'
      + '<li>出库水量：平均出库流量 <b>' + esc(numText(b.meanRelease)) + '</b> m³/s × 天数 <b>' + esc(numText(b.days)) + '</b> × 86400 ÷ 10000，接口返回 <b>' + esc(numText(b.releaseVolume)) + '</b> 万m³（前端不重算，按接口原值显示）。</li>'
      + '<li>损失：天数 <b>' + esc(numText(b.days)) + '</b> × 每天损失 <b>' + esc(dash(settings.lossPerDayWan)) + '</b>，接口返回 <b>' + esc(numText(b.lossVolume)) + '</b> 万m³。</li>'
      + '<li>蓄变：末库容 <b>' + esc(numText(b.endCapacity)) + '</b> − 首库容 <b>' + esc(numText(b.startCapacity)) + '</b>，接口返回 <b>' + esc(numText(b.deltaStorage)) + '</b> 万m³（首水位 ' + esc(numText(b.startLevel)) + ' m、末水位 ' + esc(numText(b.endLevel)) + ' m 由接口按曲线求库容）。</li>'
      + '<li>残差：接口返回 <b>' + esc(numText(b.residual)) + '</b> 万m³；容差取设置里 <b>' + esc(numText(b.tolerance)) + '</b> 万m³；是否平衡以接口返回的 <code>balanced</code> 为准：<b>' + esc(b.balanced === true ? '平衡' : '不平衡') + '</b>。</li>'
      + '</ul>';
  }

  /* ================= 设置弹层 ================= */

  function openSettingsModal() {
    var s = state.settings || {};
    el('modalTitle').textContent = '设置';
    el('modalBody').innerHTML = '<div class="form-grid">'
      + '<label class="field"><span>汛期起（月-日）</span><input type="text" name="floodSeasonStart" value="' + esc(s.floodSeasonStart || '') + '" placeholder="05-15" /><em class="field-msg" data-field-error="floodSeasonStart" hidden></em></label>'
      + '<label class="field"><span>汛期止（月-日）</span><input type="text" name="floodSeasonEnd" value="' + esc(s.floodSeasonEnd || '') + '" placeholder="09-15" /><em class="field-msg" data-field-error="floodSeasonEnd" hidden></em></label>'
      + '<label class="field"><span>每天损失（万m³）</span><input type="number" step="0.01" name="lossPerDayWan" value="' + esc(s.lossPerDayWan) + '" /><em class="field-msg" data-field-error="lossPerDayWan" hidden></em></label>'
      + '<label class="field"><span>平衡容差（万m³）</span><input type="number" step="0.01" name="balanceToleranceWan" value="' + esc(s.balanceToleranceWan) + '" /><em class="field-msg" data-field-error="balanceToleranceWan" hidden></em></label>'
      + '<label class="field"><span>入库注意流量（m³/s）</span><input type="number" step="0.01" name="inflowAttentionFlow" value="' + esc(s.inflowAttentionFlow) + '" /><em class="field-msg" data-field-error="inflowAttentionFlow" hidden></em></label>'
      + '<label class="field"><span>入库严重流量（m³/s）</span><input type="number" step="0.01" name="inflowSeriousFlow" value="' + esc(s.inflowSeriousFlow) + '" /><em class="field-msg" data-field-error="inflowSeriousFlow" hidden></em></label>'
      + '</div>'
      + '<p class="side-note">水量单位 ' + esc(dash(s.volumeUnit)) + '，流量单位 ' + esc(dash(s.flowUnit)) + '，水位精度 ' + esc(dash(s.levelPrecision)) + '。保存后限水位与是否超限会按新汛期重新取接口值。</p>';
    el('modalFoot').innerHTML = '<button type="button" class="btn btn-ghost" data-action="close-modal">取消</button>'
      + '<button type="button" class="btn btn-primary" data-action="save-settings">保存设置</button>';
    el('modalError').setAttribute('hidden', '');
    el('modalMask').removeAttribute('hidden');
  }

  function closeModal() {
    el('modalMask').setAttribute('hidden', '');
    el('modalError').setAttribute('hidden', '');
    el('modalBody').innerHTML = '';
    el('modalFoot').innerHTML = '';
  }

  async function saveSettings() {
    var body = {};
    ['floodSeasonStart', 'floodSeasonEnd'].forEach(function (key) {
      var input = qs('[name="' + key + '"]');
      if (input) body[key] = input.value.trim();
    });
    ['lossPerDayWan', 'balanceToleranceWan', 'inflowAttentionFlow', 'inflowSeriousFlow'].forEach(function (key) {
      var input = qs('[name="' + key + '"]');
      if (input) body[key] = Number(input.value);
    });
    try {
      state.settings = await api('PATCH', '/api/settings', body);
      el('modalError').setAttribute('hidden', '');
      closeModal();
      toast('设置已保存');
      state.summary = await api('GET', '/api/summary');
      state.levels = await api('GET', '/api/levels' + queryString({ reservoirId: state.filters.water.reservoirId, from: state.filters.water.from, to: state.filters.water.to }));
      renderTopbar();
      renderSidebar();
      renderOverview();
      renderWater();
      renderBalance();
    } catch (err) {
      showError(err, el('modalError'));
    }
  }

  /* ================= 表单提交 ================= */

  function formValues(form) {
    var out = {};
    qsa('[name]', form).forEach(function (node) {
      out[node.getAttribute('name')] = node.value;
    });
    return out;
  }

  async function submitLevel(form) {
    var errorBox = el('levelFormError');
    clearFormError(errorBox);
    var values = formValues(form);
    try {
      var result = await api('POST', '/api/levels', {
        reservoirId: values.reservoirId,
        date: values.date,
        time: values.time,
        level: Number(values.level),
        source: values.source,
        recorder: values.recorder,
        remark: values.remark
      });
      toast(result && result.updated ? '当天这条水位已更新' : '水位已新增');
      await loadWaterRecords();
      renderWater();
      updateWaterCounts();
    } catch (err) {
      showError(err, errorBox);
    }
  }

  async function submitFlow(form, kind) {
    var errorBox = el(kind === 'inflow' ? 'inflowFormError' : 'releaseFormError');
    clearFormError(errorBox);
    var values = formValues(form);
    try {
      await api('POST', '/api/flows', {
        kind: kind,
        reservoirId: values.reservoirId,
        date: values.date,
        flow: Number(values.flow),
        type: values.type,
        operator: values.operator,
        remark: values.remark
      });
      toast(kind === 'inflow' ? '入库流量已新增' : '出库流量已新增');
      await loadWaterRecords();
      renderWater();
      updateWaterCounts();
    } catch (err) {
      showError(err, errorBox);
    }
  }

  async function submitOrder(form) {
    var errorBox = el('orderFormError');
    clearFormError(errorBox);
    var values = formValues(form);
    try {
      await api('POST', '/api/orders', {
        reservoirId: values.reservoirId,
        issuedAt: values.issuedAt,
        targetFlow: Number(values.targetFlow),
        windowStart: values.windowStart,
        windowEnd: values.windowEnd,
        status: values.status,
        reason: values.reason,
        issuer: values.issuer,
        remark: values.remark
      });
      toast('指令已下达');
      await reloadView('orders');
    } catch (err) {
      showError(err, errorBox);
    }
  }

  async function submitBalance(form) {
    var errorBox = el('balanceFormError');
    clearFormError(errorBox);
    var values = formValues(form);
    state.filters.balance = { reservoirId: values.reservoirId, from: values.from, to: values.to };
    if (!values.reservoirId || !values.from || !values.to) {
      showNotice('请先给出水库与起止日期', true);
      renderBalance();
      return;
    }
    try {
      state.balance = await api('GET', '/api/balance' + queryString(state.filters.balance));
      renderBalance();
      toast('已按接口返回的字段算出结果');
    } catch (err) {
      state.balance = null;
      renderBalance();
      showError(err, errorBox);
    }
  }

  /* ================= 两步删除 ================= */

  function armDelete(btn) {
    if (btn.dataset.armed === '1') return true;
    btn.dataset.armed = '1';
    btn.dataset.savedText = btn.textContent;
    btn.textContent = '确认删除';
    btn.classList.add('is-armed');
    setTimeout(function () {
      if (btn.dataset.armed === '1' && btn.isConnected) {
        btn.dataset.armed = '';
        btn.textContent = btn.dataset.savedText || '删除';
        btn.classList.remove('is-armed');
      }
    }, 5000);
    return false;
  }

  /* ================= 表格行内展开 ================= */

  async function toggleReservoir(id) {
    if (state.expanded.reservoir === id) {
      state.expanded.reservoir = '';
      state.reservoirDetail = null;
      state.curveDraft = null;
      renderReservoirs();
      return;
    }
    await expandReservoir(id);
  }

  /* 展开某一座水库（概览跳转、点行共用），详情走 GET /api/reservoirs/:id */
  async function expandReservoir(id) {
    state.expanded.reservoir = id;
    state.reservoirDetail = null;
    state.curveDraft = null;
    if (state.curveQuery.reservoirId !== id) state.curveQuery = { reservoirId: id, byLevel: null, byCapacity: null };
    renderReservoirs();
    try {
      var detail = await api('GET', '/api/reservoirs/' + encodeURIComponent(id));
      if (state.expanded.reservoir !== id) return;
      state.reservoirDetail = detail;
      state.curveDraft = {
        reservoirId: id,
        verifiedOn: detail.curve ? detail.curve.verifiedOn : todayIso(),
        remark: detail.curve ? (detail.curve.remark || '') : '',
        points: detail.curve ? detail.curve.points.map(function (p) { return { level: p.level, capacity: p.capacity }; }) : []
      };
      renderReservoirs();
    } catch (err) {
      showError(err);
    }
  }

  function toggleRow(type, id) {
    if (type === 'level') state.expanded.level = state.expanded.level === id ? '' : id;
    if (type === 'order') state.expanded.order = state.expanded.order === id ? '' : id;
    if (type === 'flow') state.expanded.flow = state.expanded.flow === id ? '' : id;
  }

  /* ================= 事件委托 ================= */

  async function handleAction(btn) {
    var action = btn.dataset.action;
    var id = btn.dataset.id || btn.dataset.reservoirId || '';
    var kind = btn.dataset.kind || state.waterKind;

    if (action === 'reload') { await reloadView(btn.dataset.view); return; }
    if (action === 'card-jump') { await goToView(btn.dataset.jump, btn.dataset.filter); return; }
    if (action === 'open-reservoir') {
      var rid = btn.dataset.reservoirId;
      await goToView('reservoirs');
      await expandReservoir(rid);
      return;
    }
    if (action === 'switch-water') { setWaterKind(btn.dataset.kind); return; }

    if (action === 'toggle-reservoir') { await toggleReservoir(btn.dataset.reservoirId); return; }
    if (action === 'toggle-level') { toggleRow('level', btn.dataset.id); renderWater(); return; }
    if (action === 'toggle-flow') { toggleRow('flow', btn.dataset.kind + ':' + btn.dataset.id); renderWater(); return; }
    if (action === 'toggle-order') { toggleRow('order', btn.dataset.id); renderOrders(); return; }
    if (action === 'toggle-forecast') {
      state.expanded.forecast = state.expanded.forecast === btn.dataset.id ? '' : btn.dataset.id;
      renderForecastList();
      return;
    }

    if (action === 'add-forecast-item') {
      readForecastDraftFromDom();
      var items = state.forecastDraft.items;
      var lastDate = items.length && items[items.length - 1].date ? items[items.length - 1].date : todayIso();
      items.push({ date: addDays(lastDate, 1), flow: '' });
      renderForecastItems();
      return;
    }
    if (action === 'remove-forecast-item') {
      readForecastDraftFromDom();
      state.forecastDraft.items.splice(Number(btn.dataset.index), 1);
      renderForecastItems();
      return;
    }
    if (action === 'delete-forecast') {
      if (!armDelete(btn)) return;
      try {
        await api('DELETE', '/api/forecasts/' + encodeURIComponent(btn.dataset.id));
        state.expanded.forecast = '';
        toast('预报已删除');
        await reloadView('forecast');
      } catch (err) { showError(err); }
      return;
    }
    if (action === 'calc-suggest') {
      var rid = forecastReservoirId();
      if (!rid) { showNotice('先登记一座水库', true); return; }
      try {
        state.suggest = await api('GET', '/api/forecasts/suggest' + queryString({ reservoirId: rid }));
        renderSuggest();
        toast('建议已重算，可与上次的输入指纹对照');
      } catch (err) { showError(err); }
      return;
    }

    if (action === 'delete-level') {
      if (!armDelete(btn)) return;
      try {
        await api('DELETE', '/api/levels/' + encodeURIComponent(btn.dataset.id));
        state.expanded.level = '';
        toast('水位记录已删除');
        await reloadView('water');
      } catch (err) { showError(err); }
      return;
    }
    if (action === 'delete-flow') {
      if (!armDelete(btn)) return;
      try {
        await api('DELETE', '/api/flows/' + encodeURIComponent(btn.dataset.kind) + '/' + encodeURIComponent(btn.dataset.id));
        state.expanded.flow = '';
        toast('流量记录已删除');
        await reloadView('water');
      } catch (err) { showError(err); }
      return;
    }
    if (action === 'delete-order') {
      if (!armDelete(btn)) return;
      try {
        await api('DELETE', '/api/orders/' + encodeURIComponent(btn.dataset.id));
        state.expanded.order = '';
        toast('指令已删除');
        await reloadView('orders');
      } catch (err) { showError(err); }
      return;
    }

    if (action === 'copy-order') {
      try {
        var copied = await api('POST', '/api/orders/' + encodeURIComponent(btn.dataset.id) + '/copy', {});
        toast('已复制为 ' + (copied && copied.code ? copied.code : '新指令'));
        await reloadView('orders');
      } catch (err) { showError(err); }
      return;
    }
    if (action === 'add-attachment') {
      var detail = btn.closest('.detail');
      var nameInput = qs('[data-order-field="attachName"]', detail);
      var noteInput = qs('[data-order-field="attachNote"]', detail);
      try {
        await api('POST', '/api/orders/' + encodeURIComponent(btn.dataset.id) + '/attachments', {
          name: nameInput ? nameInput.value : '',
          note: noteInput ? noteInput.value : ''
        });
        toast('附件已登记');
        await reloadView('orders');
      } catch (err) { showError(err, qs('[data-role="order-error"]', detail)); }
      return;
    }
    if (action === 'save-order') {
      var box = btn.closest('.detail');
      var body = {};
      qsa('[data-order-field]', box).forEach(function (node) {
        var field = node.dataset.orderField;
        if (field === 'attachName' || field === 'attachNote') return;
        if (field === 'targetFlow') body.targetFlow = Number(node.value);
        else body[field] = node.value;
      });
      try {
        await api('PATCH', '/api/orders/' + encodeURIComponent(btn.dataset.id), body);
        toast('指令已更新');
        await reloadView('orders');
      } catch (err) { showError(err, qs('[data-role="order-error"]', box)); }
      return;
    }

    if (action === 'add-curve-point') {
      readCurveDraftFromDom();
      if (state.curveDraft && state.curveDraft.reservoirId === btn.dataset.reservoirId) {
        state.curveDraft.points.push({ level: '', capacity: '' });
        renderReservoirs();
      }
      return;
    }
    if (action === 'remove-curve-point') {
      readCurveDraftFromDom();
      if (state.curveDraft) {
        state.curveDraft.points.splice(Number(btn.dataset.index), 1);
        renderReservoirs();
      }
      return;
    }
    if (action === 'save-curve') {
      readCurveDraftFromDom();
      var draft = state.curveDraft;
      if (!draft) return;
      var errorBox = qs('[data-role="curve-error"]');
      var payload = {
        points: draft.points.map(function (p) { return { level: Number(p.level), capacity: Number(p.capacity) }; }),
        verifiedOn: draft.verifiedOn,
        remark: draft.remark
      };
      try {
        await api('PUT', '/api/reservoirs/' + encodeURIComponent(draft.reservoirId) + '/curve', payload);
        toast('曲线已保存');
        state.reservoirDetail = await api('GET', '/api/reservoirs/' + encodeURIComponent(draft.reservoirId));
        state.reservoirs = await api('GET', '/api/reservoirs');
        state.curveDraft = {
          reservoirId: draft.reservoirId,
          verifiedOn: state.reservoirDetail.curve ? state.reservoirDetail.curve.verifiedOn : draft.verifiedOn,
          remark: state.reservoirDetail.curve ? (state.reservoirDetail.curve.remark || '') : '',
          points: state.reservoirDetail.curve ? state.reservoirDetail.curve.points.map(function (p) { return { level: p.level, capacity: p.capacity }; }) : []
        };
        renderReservoirs();
      } catch (err) { showError(err, errorBox); }
      return;
    }
    if (action === 'query-curve-level' || action === 'query-curve-capacity') {
      var reservoirId = btn.dataset.reservoirId;
      var input = el(action === 'query-curve-level' ? 'curveLevelInput' : 'curveCapacityInput');
      var params = { reservoirId: reservoirId };
      if (action === 'query-curve-level') params.level = Number(input.value);
      else params.capacity = Number(input.value);
      var qBox = qs('[data-role="curve-error"]');
      try {
        var result = await api('GET', '/api/curve/query' + queryString(params));
        if (action === 'query-curve-level') state.curveQuery.byLevel = result;
        else state.curveQuery.byCapacity = result;
        state.curveQuery.reservoirId = reservoirId;
        state.curveQuery.pointCount = result.pointCount;
        renderReservoirs();
      } catch (err) { showError(err, qBox); }
      return;
    }

    if (action === 'open-settings') { openSettingsModal(); return; }
    if (action === 'close-modal') { closeModal(); return; }
    if (action === 'save-settings') { await saveSettings(); return; }
    if (action === 'reset-filter') {
      var scope = btn.dataset.scope;
      Object.keys(state.filters[scope]).forEach(function (key) { state.filters[scope][key] = ''; });
      if (scope === 'balance') { state.filters.balance.from = '2026-05-01'; state.filters.balance.to = '2026-05-10'; }
      await reloadView(scope);
      if (scope === 'water') updateWaterCounts();
      else renderSidebar();
      return;
    }
    if (action === 'notice-close') { hideNotice(); }
  }

  function bindEvents() {
    document.addEventListener('click', function (event) {
      var closeBtn = event.target.closest('#noticeClose');
      if (closeBtn) { hideNotice(); return; }

      var tab = event.target.closest('.tab');
      if (tab) { setView(tab.dataset.view); return; }

      var actionNode = event.target.closest('[data-action]');
      if (actionNode) {
        event.preventDefault();
        handleAction(actionNode);
        return;
      }

      var row = event.target.closest('tr');
      if (!row || row.classList.contains('detail-row')) return;
      if (row.classList.contains('reservoir-row')) { toggleReservoir(row.dataset.reservoirId); return; }
      if (row.classList.contains('level-row')) { toggleRow('level', row.dataset.id); renderWater(); return; }
      if (row.classList.contains('flow-row')) { toggleRow('flow', row.dataset.kind + ':' + row.dataset.id); renderWater(); return; }
      if (row.classList.contains('order-row')) { toggleRow('order', row.dataset.id); renderOrders(); return; }
      if (row.classList.contains('forecast-row')) {
        state.expanded.forecast = state.expanded.forecast === row.dataset.id ? '' : row.dataset.id;
        renderForecastList();
        return;
      }
    });

    document.addEventListener('change', function (event) {
      var node = event.target.closest('[data-filter-key]');
      if (!node) return;
      var scope = node.dataset.filterScope;
      var key = node.dataset.filterKey;
      state.filters[scope][key] = node.value;
      if (scope === 'overview') { renderOverview(); return; }
      if (scope === 'reservoirs') {
        state.expanded.reservoir = '';
        renderReservoirs();
        return;
      }
      if (scope === 'orders') { reloadView('orders'); return; }
      if (scope === 'water') { reloadView('water').then(updateWaterCounts); return; }
      if (scope === 'forecast') { reloadView('forecast'); return; }
      if (scope === 'balance') { renderBalance(); }
    });

    document.addEventListener('input', function (event) {
      var node = event.target.closest('[data-filter-key]');
      if (!node || node.tagName !== 'INPUT') return;
      var scope = node.dataset.filterScope;
      var key = node.dataset.filterKey;
      state.filters[scope][key] = node.value;
      if (scope === 'reservoirs') renderReservoirs();
    });

    el('openSettings').addEventListener('click', openSettingsModal);
    el('modalMask').addEventListener('click', function (event) {
      if (event.target === el('modalMask')) closeModal();
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && !el('modalMask').hasAttribute('hidden')) closeModal();
    });

    el('levelForm').addEventListener('submit', function (event) { event.preventDefault(); submitLevel(event.target); });
    el('inflowForm').addEventListener('submit', function (event) { event.preventDefault(); submitFlow(event.target, 'inflow'); });
    el('releaseForm').addEventListener('submit', function (event) { event.preventDefault(); submitFlow(event.target, 'release'); });
    el('forecastForm').addEventListener('submit', function (event) { event.preventDefault(); submitForecast(event.target); });
    el('orderForm').addEventListener('submit', function (event) { event.preventDefault(); submitOrder(event.target); });
    el('balanceForm').addEventListener('submit', function (event) { event.preventDefault(); submitBalance(event.target); });
  }

  /* ================= 下拉与默认值 ================= */

  function fillReservoirSelects() {
    var list = state.reservoirs || [];
    ['levelFormReservoir', 'inflowFormReservoir', 'releaseFormReservoir', 'orderFormReservoir', 'balanceReservoir', 'forecastFormReservoir'].forEach(function (id) {
      var node = el(id);
      if (!node) return;
      var current = node.value;
      node.innerHTML = optionsHtml(list.map(function (r) {
        return { value: r.id, label: r.code + ' ' + r.name };
      }), current || (list[0] ? list[0].id : ''), '请选择水库');
      if (!node.value && list.length) node.value = list[0].id;
    });
    var levelDate = el('levelFormDate');
    if (levelDate && !levelDate.value) levelDate.value = todayIso();
    var inflowDate = el('inflowFormDate');
    if (inflowDate && !inflowDate.value) inflowDate.value = todayIso();
    var releaseDate = el('releaseFormDate');
    if (releaseDate && !releaseDate.value) releaseDate.value = todayIso();
    var forecastDate = el('forecastFormDate');
    if (forecastDate && !forecastDate.value) forecastDate.value = todayIso();

    var orderForm = el('orderForm');
    if (orderForm) {
      var issued = qs('[name="issuedAt"]', orderForm);
      if (issued && !issued.value) issued.value = todayIso();
      var start = qs('[name="windowStart"]', orderForm);
      if (start && !start.value) start.value = todayIso();
      var end = qs('[name="windowEnd"]', orderForm);
      if (end && !end.value) end.value = todayIso();
    }

    var balanceFrom = el('balanceFrom');
    if (balanceFrom && !balanceFrom.value) balanceFrom.value = state.filters.balance.from;
    var balanceTo = el('balanceTo');
    if (balanceTo && !balanceTo.value) balanceTo.value = state.filters.balance.to;
  }

  /* ================= 启动 ================= */

  async function boot() {
    bindEvents();
    setWaterKind(state.waterKind);
    setView('overview');
    fillReservoirSelects();

    try {
      var health = await api('GET', '/api/health');
      el('connHint').textContent = '已连接：' + (health && health.service ? health.service : '服务');
    } catch (err) {
      el('connHint').textContent = '连接失败：' + err.message;
    }

    try {
      state.settings = await api('GET', '/api/settings');
      state.summary = await api('GET', '/api/summary');
      state.reservoirs = await api('GET', '/api/reservoirs');
      state.levels = await api('GET', '/api/levels');
      state.flows.inflow = await api('GET', '/api/flows?kind=inflow');
      state.flows.release = await api('GET', '/api/flows?kind=release');
      state.orders = await api('GET', '/api/orders');
      await loadForecastData();
    } catch (err) {
      showError(err);
    }

    renderTopbar();
    fillReservoirSelects();
    renderSidebar();
    renderOverview();
    renderReservoirs();
    renderWater();
    renderForecast();
    renderOrders();
    renderBalance();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
