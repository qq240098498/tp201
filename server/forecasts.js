// 来水预报：登记、清单、删除，以及实测与预报排在同一条时间线上的对照
const { AppError } = require('./errors');
const store = require('./store');
const reservoirs = require('./reservoirs');

// 某库逐日实测入库流量（同日多条取合计，与水位记录里的「当天入库」同口径）
function measuredByDate(data, reservoirId) {
  const map = {};
  for (const row of data.inflows) {
    if (row.reservoirId !== reservoirId) continue;
    map[row.date] = store.round((map[row.date] || 0) + Number(row.flow), 3);
  }
  return map;
}

// 同一目标日期可能登记了多份预报，对照时取预报时刻最新的一份（再按编号稳定排序）
function issuedKey(forecast) {
  return String(forecast.issuedAt) + 'T' + String(forecast.issuedTime) + '#' + String(forecast.id);
}

function pickLatest(list) {
  return list.slice().sort((a, b) => (issuedKey(a) < issuedKey(b) ? 1 : -1))[0];
}

function decorate(data, forecast, measuredMap) {
  const reservoir = data.reservoirs.find((r) => r.id === forecast.reservoirId);
  const measured = measuredMap ? measuredMap[forecast.date] : undefined;
  const hasMeasured = measured !== undefined;
  const deviation = hasMeasured ? store.round(measured - Number(forecast.flow), 3) : null;
  const deviationPct = hasMeasured && Number(forecast.flow) > 0
    ? store.round((deviation / Number(forecast.flow)) * 100, 1)
    : null;
  return Object.assign({}, forecast, {
    reservoirName: reservoir ? reservoir.name : '',
    reservoirCode: reservoir ? reservoir.code : '',
    volumeWan: store.round((Number(forecast.flow) * 86400) / 10000, 3),
    measuredFlow: hasMeasured ? measured : null,
    deviation,
    deviationPct,
  });
}

function listForecasts(data, query) {
  const q = query || {};
  let rows = data.forecasts.slice();
  if (q.reservoirId) rows = rows.filter((f) => f.reservoirId === q.reservoirId);
  if (q.from) rows = rows.filter((f) => f.date >= q.from);
  if (q.to) rows = rows.filter((f) => f.date <= q.to);
  const measuredMaps = {};
  return rows
    .map((f) => {
      if (!measuredMaps[f.reservoirId]) measuredMaps[f.reservoirId] = measuredByDate(data, f.reservoirId);
      return decorate(data, f, measuredMaps[f.reservoirId]);
    })
    .sort((a, b) => (a.date === b.date
      ? (issuedKey(a) < issuedKey(b) ? -1 : 1)
      : (a.date < b.date ? -1 : 1)));
}

// 登记预报：同库、同目标日期、同预报时刻的覆盖；预报人与依据必须填
function saveForecast(data, payload) {
  const reservoir = reservoirs.find(data, payload.reservoirId);
  const errors = {};
  const date = String(payload.date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) errors.date = '预报目标日期要按 年-月-日 填';
  const flow = Number(payload.flow);
  if (!Number.isFinite(flow) || flow < 0) errors.flow = '预报入库流量要填非负数字';
  const issuedAt = String(payload.issuedAt || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(issuedAt)) errors.issuedAt = '预报日期要按 年-月-日 填';
  const issuedTime = String(payload.issuedTime || '08:00').trim();
  if (!/^\d{2}:\d{2}$/.test(issuedTime)) errors.issuedTime = '预报时刻要按 时:分 填';
  const forecaster = String(payload.forecaster || '').trim();
  if (!forecaster) errors.forecaster = '预报人要填';
  const basis = String(payload.basis || '').trim();
  if (!basis) errors.basis = '预报依据要填';
  if (Object.keys(errors).length) {
    throw new AppError(400, 'VALIDATION_FAILED', '预报没通过校验，请按提示补齐', errors);
  }
  const existing = data.forecasts.find(
    (f) => f.reservoirId === reservoir.id && f.date === date && f.issuedAt === issuedAt && f.issuedTime === issuedTime
  );
  if (existing) {
    existing.flow = flow;
    existing.forecaster = forecaster;
    existing.basis = basis;
    existing.remark = String(payload.remark || '');
    return { updated: true, id: existing.id };
  }
  const record = {
    id: store.nextId('fc', data.forecasts),
    reservoirId: reservoir.id,
    date,
    flow,
    issuedAt,
    issuedTime,
    forecaster,
    basis,
    remark: String(payload.remark || ''),
  };
  data.forecasts.push(record);
  return { updated: false, id: record.id };
}

function removeForecast(data, id) {
  const found = data.forecasts.find((f) => f.id === id);
  if (!found) throw new AppError(404, 'FORECAST_NOT_FOUND', '这条预报不存在');
  data.forecasts = data.forecasts.filter((f) => f.id !== id);
  return { removed: id };
}

// 实测与预报的同一条时间线：凡是有实测或有预报的日子都占一行，写清偏差
function timeline(data, query) {
  const q = query || {};
  let inflows = data.inflows.slice();
  let forecasts = data.forecasts.slice();
  if (q.reservoirId) {
    inflows = inflows.filter((r) => r.reservoirId === q.reservoirId);
    forecasts = forecasts.filter((f) => f.reservoirId === q.reservoirId);
  }
  if (q.from) {
    inflows = inflows.filter((r) => r.date >= q.from);
    forecasts = forecasts.filter((f) => f.date >= q.from);
  }
  if (q.to) {
    inflows = inflows.filter((r) => r.date <= q.to);
    forecasts = forecasts.filter((f) => f.date <= q.to);
  }

  const keys = [];
  const seen = {};
  for (const row of inflows.concat(forecasts)) {
    const key = row.reservoirId + '|' + row.date;
    if (!seen[key]) {
      seen[key] = true;
      keys.push(key);
    }
  }

  const rows = keys.map((key) => {
    const splitAt = key.indexOf('|');
    const reservoirId = key.slice(0, splitAt);
    const date = key.slice(splitAt + 1);
    const reservoir = data.reservoirs.find((r) => r.id === reservoirId);
    const dayInflows = inflows.filter((r) => r.reservoirId === reservoirId && r.date === date);
    const measuredFlow = dayInflows.length
      ? store.round(dayInflows.reduce((s, r) => s + Number(r.flow), 0), 3)
      : null;
    const dayForecasts = forecasts.filter((f) => f.reservoirId === reservoirId && f.date === date);
    const latest = dayForecasts.length ? pickLatest(dayForecasts) : null;
    const hasBoth = measuredFlow !== null && latest !== null;
    const deviation = hasBoth ? store.round(measuredFlow - Number(latest.flow), 3) : null;
    const deviationPct = hasBoth && Number(latest.flow) > 0
      ? store.round((deviation / Number(latest.flow)) * 100, 1)
      : null;
    return {
      reservoirId,
      reservoirName: reservoir ? reservoir.name : '',
      reservoirCode: reservoir ? reservoir.code : '',
      date,
      measuredFlow,
      measuredVolumeWan: measuredFlow === null ? null : store.round((measuredFlow * 86400) / 10000, 3),
      forecast: latest ? decorate(data, latest, null) : null,
      forecastCount: dayForecasts.length,
      deviation,
      deviationPct,
      status: hasBoth ? '已应验' : (latest ? '待应验' : '仅实测'),
    };
  });

  return rows.sort((a, b) => (a.date === b.date
    ? (a.reservoirId < b.reservoirId ? -1 : 1)
    : (a.date < b.date ? -1 : 1)));
}

module.exports = { listForecasts, saveForecast, removeForecast, timeline, measuredByDate, pickLatest };
