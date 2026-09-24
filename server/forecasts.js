// 来水预报与调度建议
// 预报按「水库 + 预报日期 + 预报时刻」登记一批未来几天的入库流量；
// 同一个目标日期有多次预报时，对照与建议一律取（预报日期 + 时刻）最新的一批；
// 调度建议是只读计算：不写任何数据，同一组输入重算结论一致（返回输入指纹便于核对）。
const { AppError } = require('./errors');
const store = require('./store');
const water = require('./water');
const reservoirs = require('./reservoirs');

const SECONDS_PER_DAY = 86400;

// 流量(m³/s) × 天数 → 水量(万m³)，与水量平衡同一口径
function flowToWan(flow, days) {
  return (Number(flow) * Number(days) * SECONDS_PER_DAY) / 10000;
}

// 水量(万m³) ÷ 天数 → 流量(m³/s)
function wanToFlow(wan, days) {
  const d = Number(days);
  if (!d) return 0;
  return (Number(wan) * 10000) / (d * SECONDS_PER_DAY);
}

// 输入指纹：djb2，只依赖输入内容；同一组输入指纹相同，结论必然一致
function fingerprint(obj) {
  const text = JSON.stringify(obj);
  let h = 5381;
  for (let i = 0; i < text.length; i += 1) {
    h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  }
  return ('0000000' + h.toString(16)).slice(-8);
}

function decorate(data, forecast) {
  const reservoir = data.reservoirs.find((r) => r.id === forecast.reservoirId);
  const items = (forecast.items || []).slice().sort((a, b) => (a.date < b.date ? -1 : 1));
  const meanFlow = items.length
    ? store.round(items.reduce((s, x) => s + Number(x.flow), 0) / items.length, 2)
    : null;
  return Object.assign({}, forecast, {
    items,
    reservoirName: reservoir ? reservoir.name : '',
    itemCount: items.length,
    dateStart: items.length ? items[0].date : '',
    dateEnd: items.length ? items[items.length - 1].date : '',
    meanFlow,
  });
}

function list(data, query) {
  const q = query || {};
  let rows = data.forecasts.slice();
  if (q.reservoirId) rows = rows.filter((f) => f.reservoirId === q.reservoirId);
  if (q.from) rows = rows.filter((f) => (f.items || []).some((it) => it.date >= q.from));
  if (q.to) rows = rows.filter((f) => (f.items || []).some((it) => it.date <= q.to));
  return rows
    .map((f) => decorate(data, f))
    .sort((a, b) => {
      if (a.issuedAt !== b.issuedAt) return a.issuedAt < b.issuedAt ? 1 : -1;
      if (a.issuedTime !== b.issuedTime) return a.issuedTime < b.issuedTime ? 1 : -1;
      return a.id < b.id ? 1 : -1;
    });
}

function save(data, payload) {
  const reservoir = reservoirs.find(data, payload.reservoirId);
  const errors = {};
  const issuedAt = String(payload.issuedAt || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(issuedAt)) errors.issuedAt = '预报日期要按 年-月-日 填';
  const issuedTime = String(payload.issuedTime || '08:00').trim();
  if (!/^\d{2}:\d{2}$/.test(issuedTime)) errors.issuedTime = '预报时刻要按 时:分 填，比如 08:00';
  const forecaster = String(payload.forecaster || '').trim();
  if (!forecaster) errors.forecaster = '预报人要填';
  const basis = String(payload.basis || '').trim();
  if (!basis) errors.basis = '预报依据要填，比如气象降雨预报、区间来水估计';

  const rawItems = Array.isArray(payload.items) ? payload.items : [];
  if (!rawItems.length) errors.items = '至少要报一天的流量';
  const seen = {};
  const items = rawItems.map((raw, index) => {
    const date = String((raw && raw.date) || '').trim();
    const flow = Number(raw && raw.flow);
    const label = '第 ' + (index + 1) + ' 天';
    const problems = [];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      problems.push('日期要按 年-月-日 填');
    } else if (issuedAt && date < issuedAt) {
      problems.push('（' + date + '）早于预报日期，预报只登记当天及以后');
    } else if (seen[date]) {
      problems.push('（' + date + '）重复了，一天只能有一行');
    }
    seen[date] = true;
    if (!Number.isFinite(flow) || flow < 0) problems.push('流量要填非负数字');
    if (problems.length) errors['items.' + index] = label + problems.join('，');
    return { date, flow };
  });
  if (Object.keys(errors).length) {
    throw new AppError(400, 'VALIDATION_FAILED', '预报没通过校验，请按提示补齐', errors);
  }
  items.sort((a, b) => (a.date < b.date ? -1 : 1));

  // 同库 + 同预报日期 + 同预报时刻：视为同一批，覆盖更新
  const existing = data.forecasts.find(
    (f) => f.reservoirId === reservoir.id && f.issuedAt === issuedAt && f.issuedTime === issuedTime
  );
  if (existing) {
    existing.forecaster = forecaster;
    existing.basis = basis;
    existing.items = items;
    return { updated: true, id: existing.id };
  }
  const record = {
    id: store.nextId('fc', data.forecasts),
    reservoirId: reservoir.id,
    issuedAt,
    issuedTime,
    forecaster,
    basis,
    items,
  };
  data.forecasts.push(record);
  return { updated: false, id: record.id };
}

function remove(data, id) {
  const found = data.forecasts.find((f) => f.id === id);
  if (!found) throw new AppError(404, 'FORECAST_NOT_FOUND', '这批预报不存在');
  data.forecasts = data.forecasts.filter((f) => f.id !== id);
  return { removed: id };
}

// 同一个目标日期可能报过好几次，一律取（预报日期 + 时刻）最新的一批
function latestForecastByDate(data, reservoirId) {
  const batches = data.forecasts
    .filter((f) => f.reservoirId === reservoirId)
    .slice()
    .sort((a, b) => {
      if (a.issuedAt !== b.issuedAt) return a.issuedAt < b.issuedAt ? -1 : 1;
      if (a.issuedTime !== b.issuedTime) return a.issuedTime < b.issuedTime ? -1 : 1;
      return a.id < b.id ? -1 : 1;
    });
  const byDate = {};
  for (const batch of batches) {
    for (const item of batch.items || []) {
      byDate[item.date] = { flow: Number(item.flow), batch };
    }
  }
  return byDate;
}

// 实测与预报排在同一条时间线上：偏差 = 实测 − 预报
function timeline(data, query) {
  const q = query || {};
  if (!q.reservoirId) throw new AppError(400, 'INVALID_PAYLOAD', '请先选一个水库', { reservoirId: '请选水库' });
  const reservoir = reservoirs.find(data, q.reservoirId);
  const forecastByDate = latestForecastByDate(data, reservoir.id);

  const measuredByDate = {};
  for (const row of data.inflows) {
    if (row.reservoirId !== reservoir.id) continue;
    measuredByDate[row.date] = store.round((measuredByDate[row.date] || 0) + Number(row.flow), 3);
  }

  let dates = Object.keys(forecastByDate).concat(Object.keys(measuredByDate));
  dates = Array.from(new Set(dates)).sort();
  if (q.from) dates = dates.filter((d) => d >= q.from);
  if (q.to) dates = dates.filter((d) => d <= q.to);

  const rows = dates.map((date) => {
    const measured = measuredByDate[date] !== undefined ? measuredByDate[date] : null;
    const picked = forecastByDate[date] || null;
    const forecast = picked ? picked.flow : null;
    const deviation = measured !== null && forecast !== null ? store.round(measured - forecast, 2) : null;
    const deviationPct = deviation !== null && forecast ? store.round((deviation / forecast) * 100, 1) : null;
    return {
      date,
      measured,
      forecast,
      deviation,
      deviationPct,
      leadDays: picked ? store.daysBetween(picked.batch.issuedAt, date) : null,
      forecastId: picked ? picked.batch.id : '',
      issuedAt: picked ? picked.batch.issuedAt : '',
      issuedTime: picked ? picked.batch.issuedTime : '',
      forecaster: picked ? picked.batch.forecaster : '',
    };
  });

  const compared = rows.filter((r) => r.deviation !== null);
  const withPct = rows.filter((r) => r.deviationPct !== null);
  const summary = {
    days: rows.length,
    measuredDays: rows.filter((r) => r.measured !== null).length,
    forecastDays: rows.filter((r) => r.forecast !== null).length,
    comparedDays: compared.length,
    meanDeviation: compared.length ? store.round(compared.reduce((s, r) => s + r.deviation, 0) / compared.length, 2) : null,
    meanAbsDeviation: compared.length
      ? store.round(compared.reduce((s, r) => s + Math.abs(r.deviation), 0) / compared.length, 2)
      : null,
    meanAbsDeviationPct: withPct.length
      ? store.round(withPct.reduce((s, r) => s + Math.abs(r.deviationPct), 0) / withPct.length, 1)
      : null,
  };
  return { reservoirId: reservoir.id, reservoirName: reservoir.name, rows, summary };
}

// 调度建议：按预报入库与当前水位算下泄区间，只出结论不动数据
function suggest(data, reservoirId) {
  const reservoir = reservoirs.find(data, reservoirId);
  const settings = data.settings;
  const today = store.todayIso();
  const base = { reservoirId: reservoir.id, reservoirName: reservoir.name, computedOn: today };

  const curve = water.curveOf(data, reservoir.id);
  if (!curve || !water.sortedPoints(curve).length) {
    return Object.assign(base, {
      usable: false,
      reason: '这个水库还没有水位-库容曲线，先在「水库」里维护曲线再算建议',
      current: null,
      storage: null,
      forecast: null,
      advice: null,
      algorithm: [],
      inputHash: fingerprint({ reservoirId: reservoir.id, today, stage: 'no-curve' }),
    });
  }
  const latest = data.levels
    .filter((l) => l.reservoirId === reservoir.id)
    .sort((a, b) => (a.date < b.date ? 1 : -1))[0];
  if (!latest) {
    return Object.assign(base, {
      usable: false,
      reason: '这个水库还没有水位记录，定不了当前水位，先登记水位',
      current: null,
      storage: null,
      forecast: null,
      advice: null,
      algorithm: [],
      inputHash: fingerprint({ reservoirId: reservoir.id, today, stage: 'no-level' }),
    });
  }

  const limit = water.limitLevelOf(reservoir, today, settings);
  const floodSeason = water.inFloodSeason(today, settings);
  const currentLevel = Number(latest.level);
  const currentWan = water.capacityAt(curve, currentLevel, settings);
  const limitWan = water.capacityAt(curve, limit, settings);
  const deadWan = water.capacityAt(curve, Number(reservoir.deadLevel), settings);
  const current = {
    levelDate: latest.date,
    level: currentLevel,
    limit,
    floodSeason,
    overLimitLevel: store.round(currentLevel - limit, 2),
  };
  const storage = {
    currentWan,
    limitWan,
    deadWan,
    overLimitWan: store.round(currentWan - limitWan, 3),
    freeableToDeadWan: store.round(currentWan - deadWan, 3),
  };

  const forecastByDate = latestForecastByDate(data, reservoir.id);
  const horizonDates = Object.keys(forecastByDate)
    .filter((d) => d >= today)
    .sort();

  const storageLines = [
    '限水位口径：今天 ' + today + (floodSeason ? ' 处于汛期' : ' 不在汛期') + '（汛期 ' + settings.floodSeasonStart + ' 至 ' + settings.floodSeasonEnd + '），限水位取 ' + limit + ' m。',
    '当前状态：最新水位 ' + currentLevel + ' m（' + latest.date + '），' + (current.overLimitLevel > 0 ? '超出限水位 ' + current.overLimitLevel + ' m' : '低于限水位 ' + store.round(-current.overLimitLevel, 2) + ' m') + '；按曲线分段插值，当前库容 ' + currentWan + ' 万m³，限水位对应库容 ' + limitWan + ' 万m³，死水位 ' + reservoir.deadLevel + ' m 对应库容 ' + deadWan + ' 万m³。',
    '可腾库容：压回限水位需腾出 ' + storage.overLimitWan + ' 万m³；按当前库容最多可腾到死水位，即能腾 ' + storage.freeableToDeadWan + ' 万m³。',
  ];

  if (!horizonDates.length) {
    return Object.assign(base, {
      usable: false,
      reason: '今天（' + today + '）及以后没有预报入库流量，先在「登记预报」里报未来几天的来水',
      current,
      storage,
      forecast: { days: 0, dates: [], batchesUsed: [] },
      advice: null,
      algorithm: storageLines.concat(['没有可用的预报来水，给不出下泄区间。']),
      inputHash: fingerprint({ reservoirId: reservoir.id, today, levelDate: latest.date, currentLevel, limit, horizon: [] }),
    });
  }

  const days = horizonDates.length;
  const meanInflow = store.round(horizonDates.reduce((s, d) => s + forecastByDate[d].flow, 0) / days, 2);
  const inflowVolumeWan = store.round(flowToWan(meanInflow, days), 3);
  const lossVolumeWan = store.round(days * Number(settings.lossPerDayWan), 3);

  // 下泄下限：时段末水位正好压回限水位所需的平均下泄流量（不需要压时取 0）
  const needReleaseWan = store.round(currentWan + inflowVolumeWan - lossVolumeWan - limitWan, 3);
  const qMin = store.round(Math.max(0, wanToFlow(needReleaseWan, days)), 2);
  // 下泄上限：时段末不跌破死水位
  const maxReleaseWan = store.round(currentWan + inflowVolumeWan - lossVolumeWan - deadWan, 3);
  const qMax = store.round(Math.max(qMin, wanToFlow(maxReleaseWan, days)), 2);

  const suggestedFlow = qMin;
  const orderCount = suggestedFlow > 0 ? days : 0;

  const endWanNoRelease = store.round(currentWan + inflowVolumeWan - lossVolumeWan, 3);
  const endWanAtSuggested = store.round(endWanNoRelease - flowToWan(suggestedFlow, days), 3);
  const endWanAtMax = store.round(endWanNoRelease - flowToWan(qMax, days), 3);
  const endLevelNoRelease = water.levelAt(curve, endWanNoRelease);
  const endLevelAtSuggested = water.levelAt(curve, endWanAtSuggested);
  const endLevelAtMax = water.levelAt(curve, endWanAtMax);
  const levelChangeAtSuggested = store.round(endLevelAtSuggested - currentLevel, 2);

  const batchIds = {};
  const batchesUsed = [];
  for (const date of horizonDates) {
    const batch = forecastByDate[date].batch;
    if (batchIds[batch.id]) {
      batchIds[batch.id].dates.push(date);
    } else {
      batchIds[batch.id] = {
        id: batch.id,
        issuedAt: batch.issuedAt,
        issuedTime: batch.issuedTime,
        forecaster: batch.forecaster,
        basis: batch.basis,
        dates: [date],
      };
      batchesUsed.push(batchIds[batch.id]);
    }
  }

  const forecastInfo = {
    days,
    dates: horizonDates,
    dateStart: horizonDates[0],
    dateEnd: horizonDates[horizonDates.length - 1],
    meanInflow,
    inflowVolumeWan,
    lossVolumeWan,
    batchesUsed,
  };
  const advice = {
    releaseMin: qMin,
    releaseMax: qMax,
    suggestedFlow,
    orderCount,
    perOrderFlow: suggestedFlow,
    orderPlan: orderCount ? '每天一条、共 ' + orderCount + ' 条，每条目标下泄 ' + suggestedFlow + ' m³/s' : '不需要新增泄流指令',
    needReleaseWan,
    maxReleaseWan,
    endWanNoRelease,
    endWanAtSuggested,
    endWanAtMax,
    endLevelNoRelease,
    endLevelAtSuggested,
    endLevelAtMax,
    levelChangeAtSuggested,
  };

  const algorithm = storageLines.concat([
    '预报来水：采用 ' + forecastInfo.dateStart + ' 至 ' + forecastInfo.dateEnd + ' 共 ' + days + ' 天预报（同一日期多次预报取最新一批），平均入库 ' + meanInflow + ' m³/s；入库水量 = ' + meanInflow + ' × ' + days + ' 天 × 86400 ÷ 10000 = ' + inflowVolumeWan + ' 万m³；损失 = ' + days + ' 天 × 每天 ' + Number(settings.lossPerDayWan) + ' = ' + lossVolumeWan + ' 万m³。',
    '下泄下限：要让时段末水位回到限水位，需下泄水量 = 当前库容 ' + currentWan + ' + 入库 ' + inflowVolumeWan + ' − 损失 ' + lossVolumeWan + ' − 限水位库容 ' + limitWan + ' = ' + needReleaseWan + ' 万m³，折合流量 = ' + needReleaseWan + ' × 10000 ÷ (' + days + ' × 86400) = ' + qMin + ' m³/s（不足 0 时按 0 计）。',
    '下泄上限：时段末不跌破死水位，最多可下泄 = 当前库容 + 入库 − 损失 − 死库容 = ' + maxReleaseWan + ' 万m³，折合 ' + qMax + ' m³/s。',
    orderCount
      ? '建议指令：按每天一条、共 ' + orderCount + ' 条，每条目标下泄 ' + suggestedFlow + ' m³/s；按此执行时段末库容回到 ' + endWanAtSuggested + ' 万m³，末水位 ' + endLevelAtSuggested + ' m，水位变化 ' + levelChangeAtSuggested + ' m；若完全不泄流，时段末水位将到 ' + endLevelNoRelease + ' m。'
      : '建议指令：按预报来水演算，时段末水位 ' + endLevelNoRelease + ' m 不超过限水位 ' + limit + ' m，不需要新增泄流指令（0 条）。',
    '本建议只出结论，不写入任何数据；同一组输入重算结论一致。',
  ]);

  const inputHash = fingerprint({
    reservoirId: reservoir.id,
    today,
    levelDate: latest.date,
    currentLevel,
    limit,
    curvePoints: water.sortedPoints(curve),
    lossPerDayWan: Number(settings.lossPerDayWan),
    horizon: horizonDates.map((d) => [d, forecastByDate[d].flow, forecastByDate[d].batch.id]),
  });

  return Object.assign(base, {
    usable: true,
    reason: '',
    current,
    storage,
    forecast: forecastInfo,
    advice,
    algorithm,
    inputHash,
  });
}

module.exports = { list, save, remove, timeline, suggest, latestForecastByDate };
