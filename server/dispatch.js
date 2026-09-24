// 调度建议：只读计算，不写任何数据。
// 全部输入取自库内记录（最新水位、预报、曲线、设置），不取当前时刻，
// 所以同一组预报连着算两次，结论与输入指纹都一致。
const { AppError } = require('./errors');
const store = require('./store');
const water = require('./water');
const forecasts = require('./forecasts');

const FLOW_STEP = 0.1; // 建议流量按 0.1 m³/s 取整

function ceilStep(value) {
  return Math.ceil(Number(value) / FLOW_STEP) * FLOW_STEP;
}

function floorStep(value) {
  return Math.floor(Number(value) / FLOW_STEP) * FLOW_STEP;
}

// 输入指纹：把参与计算的输入排好序拼成串，取 FNV-1a 哈希，证明两次算的是同一组输入
function fingerprint(parts) {
  const text = JSON.stringify(parts);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return 'fc-' + ('0000000' + hash.toString(16)).slice(-8);
}

const ALGORITHM = [
  '锚定：取该库最新一条水位记录作为当前水位与起算日期，当前库容按水位-库容曲线分段插值。',
  '预报期：起算日次日到最远预报日；同一目标日期取预报时刻最新的一份；期内没登记预报的日子按入库 0 计并在备注里点名。',
  '逐日水量平衡：当日蓄变（万m³）=（预报入库 − 建议下泄）× 86400 ÷ 10000 − 每天损失（取设置里的 lossPerDayWan）。',
  '限水位：逐日按日期判定汛期（含起止两端），汛期取汛限水位、非汛期取正常蓄水位，再按曲线得当日限库容。',
  '当日建议下泄：让当末库容不超限库容的最小流量，按 0.1 m³/s 向上取整；同时不超过「泄到死库容」的上限（按 0.1 m³/s 向下取整）。',
  '区间与指令：建议下泄区间 = 逐日建议流量的最小值～最大值；相邻且流量相同的天合并成一条建议指令。',
  '恒定口径：若全程只用一个流量，把期末水位压到限水位所需的恒定流量 = max(0, 当前库容 + 预报总水量 − 总损失 − 期末限库容) × 10000 ÷（天数 × 86400）。',
  '腾出库容：压到限水位可腾出 = 当前库容 − 限水位库容；极限腾库 = 当前库容 − 死水位库容。',
  '水位影响：按逐日方案回代演算期末水位、水位变化与期最高水位；库容反查水位按同一分段曲线反解。',
  '本建议只出结论、不写数据；输入全部取自库内记录，不取当前时刻，同一组输入重算结论一致。',
];

function suggestion(data, reservoirId) {
  const reservoir = data.reservoirs.find((r) => r.id === reservoirId);
  if (!reservoir) throw new AppError(404, 'RESERVOIR_NOT_FOUND', '这个水库不存在');
  const curve = water.curveOf(data, reservoirId);
  if (!curve || !(curve.points || []).length) {
    throw new AppError(404, 'CURVE_NOT_FOUND', '这个水库还没有水位-库容曲线，算不了建议');
  }
  const settings = data.settings;

  // 1. 锚定当前水位：最新一条水位记录（同日取时刻最晚的，再按编号稳定）
  const anchor = data.levels
    .filter((l) => l.reservoirId === reservoirId)
    .sort((a, b) => {
      const ka = String(a.date) + 'T' + String(a.time || '') + '#' + String(a.id);
      const kb = String(b.date) + 'T' + String(b.time || '') + '#' + String(b.id);
      return ka < kb ? 1 : -1;
    })[0];
  if (!anchor) throw new AppError(409, 'NO_LEVEL_RECORD', '这个水库还没有水位记录，定不了当前水位');
  const currentLevel = Number(anchor.level);
  const currentCapacity = water.capacityAt(curve, currentLevel, settings);
  const limitToday = water.limitLevelOf(reservoir, anchor.date, settings);
  const capacityAtLimit = water.capacityAt(curve, limitToday, settings);
  const capacityAtDead = water.capacityAt(curve, reservoir.deadLevel, settings);
  const floodSeasonNow = water.inFloodSeason(anchor.date, settings);

  // 2. 预报期：起算日次日 → 最远预报日；同一目标日期取预报时刻最新的一份
  const future = data.forecasts.filter((f) => f.reservoirId === reservoirId && f.date > anchor.date);
  const byDate = {};
  for (const f of future) {
    const key = f.date;
    if (!byDate[key]) byDate[key] = [];
    byDate[key].push(f);
  }
  const usedDates = Object.keys(byDate).sort();
  const usedForecasts = usedDates.map((date) => forecasts.pickLatest(byDate[date]));
  const lastDate = usedDates.length ? usedDates[usedDates.length - 1] : null;
  const horizonDays = lastDate ? store.daysBetween(anchor.date, lastDate) : 0;

  const plan = [];
  const missingDays = [];
  for (let i = 1; i <= horizonDays; i += 1) {
    const date = store.addDays(anchor.date, i);
    const forecast = byDate[date] ? forecasts.pickLatest(byDate[date]) : null;
    plan.push({ date, flow: forecast ? Number(forecast.flow) : 0, forecast });
    if (!forecast) missingDays.push(date);
  }

  // 3. 逐日演算：当日所需泄量取整后回代，保证给出的流量与演算的水位一致
  const lossPerDay = Number(settings.lossPerDayWan);
  let capacity = currentCapacity;
  const daily = [];
  const clampedDays = [];
  for (const day of plan) {
    const limit = water.limitLevelOf(reservoir, day.date, settings);
    const limitCapacity = water.capacityAt(curve, limit, settings);
    const inflowVol = store.round((day.flow * 86400) / 10000, 4);
    const needVol = capacity + inflowVol - lossPerDay - limitCapacity;
    const maxVol = capacity + inflowVol - lossPerDay - capacityAtDead;
    const needFlow = (Math.max(needVol, 0) * 10000) / 86400;
    const maxFlow = (Math.max(maxVol, 0) * 10000) / 86400;
    let releaseFlow = store.round(ceilStep(needFlow), 1);
    const maxFlowFloor = store.round(floorStep(maxFlow), 1);
    if (releaseFlow > maxFlowFloor) {
      releaseFlow = maxFlowFloor;
      clampedDays.push(day.date);
    }
    const releaseVol = store.round((releaseFlow * 86400) / 10000, 4);
    capacity = store.round(capacity + inflowVol - lossPerDay - releaseVol, 4);
    daily.push({
      date: day.date,
      inflowFlow: day.flow,
      forecastId: day.forecast ? day.forecast.id : null,
      limit,
      limitCapacity,
      releaseFlow,
      releaseVolumeWan: releaseVol,
      endCapacity: capacity,
      endLevel: water.levelAt(curve, capacity),
    });
  }

  // 4. 汇总：区间、指令分段、水位影响
  const totalInflowVol = store.round(daily.reduce((s, d) => s + (d.inflowFlow * 86400) / 10000, 0), 3);
  const totalLoss = store.round(horizonDays * lossPerDay, 3);
  const releaseVolumeWan = store.round(daily.reduce((s, d) => s + d.releaseVolumeWan, 0), 3);
  const positiveFlows = daily.map((d) => d.releaseFlow).filter((q) => q > 0);
  const range = positiveFlows.length
    ? { low: Math.min.apply(null, positiveFlows), high: Math.max.apply(null, positiveFlows) }
    : { low: 0, high: 0 };

  const segments = [];
  for (const d of daily) {
    if (d.releaseFlow <= 0) continue;
    const last = segments[segments.length - 1];
    if (last && last.flow === d.releaseFlow) {
      last.to = d.date;
      last.days += 1;
    } else {
      segments.push({ from: d.date, to: d.date, days: 1, flow: d.releaseFlow });
    }
  }

  const endCapacity = daily.length ? daily[daily.length - 1].endCapacity : currentCapacity;
  const endLevel = daily.length ? daily[daily.length - 1].endLevel : currentLevel;
  let maxRow = null;
  let minRow = null;
  for (const d of daily) {
    if (!maxRow || d.endLevel > maxRow.endLevel) maxRow = d;
    if (!minRow || d.endLevel < minRow.endLevel) minRow = d;
  }
  const staysUnderLimit = daily.every((d) => store.round(d.endLevel - d.limit, 2) <= 0);

  // 恒定口径：全程一个流量把期末水位压到限水位
  const limitEnd = lastDate ? water.limitLevelOf(reservoir, lastDate, settings) : limitToday;
  const capacityAtLimitEnd = water.capacityAt(curve, limitEnd, settings);
  const needTotalVol = currentCapacity + totalInflowVol - totalLoss - capacityAtLimitEnd;
  const constantFlow = horizonDays > 0
    ? store.round(ceilStep((Math.max(needTotalVol, 0) * 10000) / (horizonDays * 86400)), 1)
    : 0;

  const meanForecastFlow = daily.length
    ? store.round(daily.reduce((s, d) => s + d.inflowFlow, 0) / daily.length, 2)
    : 0;
  let maxForecast = null;
  for (const d of daily) {
    if (!maxForecast || d.inflowFlow > maxForecast.inflowFlow) maxForecast = d;
  }

  const notes = [];
  if (!data.forecasts.some((f) => f.reservoirId === reservoirId)) {
    notes.push('这个水库还没有登记任何预报。');
  }
  if (missingDays.length) {
    notes.push('预报期内有 ' + missingDays.length + ' 天没登记预报，按入库 0 计：' + missingDays.join('、'));
  }
  if (clampedDays.length) {
    notes.push('这些日子所需泄量受死水位限制，当天压不到限水位：' + clampedDays.join('、'));
  }
  const overNow = store.round(currentLevel - limitToday, 2);
  if (overNow > 0) {
    notes.push('当前水位已超' + (floodSeasonNow ? '汛限水位' : '正常蓄水位') + ' ' + overNow + ' m。');
  }

  let conclusion;
  if (!daily.length) {
    conclusion = '起算日（' + anchor.date + '）之后还没有预报，登记未来几天的预报后再来算。';
  } else if (range.high <= 0) {
    conclusion = '预报期内不需要泄流：按当前水位与预报来水，不泄流期末水位 '
      + endLevel + ' m 仍不超过限水位，建议指令 0 条。';
  } else {
    conclusion = '建议下泄 ' + range.low + '～' + range.high + ' m³/s，分 ' + segments.length
      + ' 条指令；期末水位由 ' + currentLevel + ' m 到 ' + endLevel + ' m（变化 '
      + store.round(endLevel - currentLevel, 2) + ' m），'
      + (staysUnderLimit ? '全程不超限水位。' : '部分日子仍超限水位（见备注）。');
  }

  const inputFingerprint = fingerprint({
    version: 1,
    reservoirId,
    anchor: [anchor.id, anchor.date, anchor.time || '', currentLevel],
    curve: [curve.id, curve.verifiedOn || '', water.sortedPoints(curve).map((p) => [Number(p.level), Number(p.capacity)])],
    forecasts: usedForecasts.map((f) => [f.id, f.date, Number(f.flow)]),
    settings: [Number(settings.lossPerDayWan), String(settings.floodSeasonStart), String(settings.floodSeasonEnd)],
    levels: [Number(reservoir.normalLevel), Number(reservoir.floodLimitLevel), Number(reservoir.deadLevel)],
  });

  return {
    reservoirId,
    reservoirName: reservoir.name,
    reservoirCode: reservoir.code,
    anchor: {
      levelId: anchor.id,
      date: anchor.date,
      time: anchor.time || '',
      level: currentLevel,
      capacity: currentCapacity,
      limit: limitToday,
      limitName: floodSeasonNow ? '汛限水位' : '正常蓄水位',
      floodSeason: floodSeasonNow,
      overLimit: overNow,
      exceeded: overNow > 0,
    },
    horizon: {
      from: daily.length ? daily[0].date : null,
      to: lastDate,
      days: horizonDays,
      forecastDays: usedForecasts.length,
      missingDays,
      usedForecasts: usedForecasts.map((f) => ({
        id: f.id,
        date: f.date,
        flow: Number(f.flow),
        issuedAt: f.issuedAt,
        issuedTime: f.issuedTime,
        forecaster: f.forecaster,
        basis: f.basis,
      })),
    },
    inflow: {
      meanFlow: meanForecastFlow,
      maxFlow: maxForecast ? maxForecast.inflowFlow : 0,
      maxFlowDate: maxForecast ? maxForecast.date : null,
      volumeWan: totalInflowVol,
      lossWan: totalLoss,
      netVolumeWan: store.round(totalInflowVol - totalLoss, 3),
    },
    storage: {
      currentCapacity,
      capacityAtLimit,
      capacityAtDead,
      freeableToLimit: store.round(currentCapacity - capacityAtLimit, 3),
      freeableToDead: store.round(currentCapacity - capacityAtDead, 3),
      roomToLimit: store.round(capacityAtLimit - currentCapacity, 3),
    },
    required: {
      releaseVolumeWan,
      constantFlow,
      meanFlow: horizonDays > 0 ? store.round((releaseVolumeWan * 10000) / (horizonDays * 86400), 2) : 0,
    },
    range,
    orders: { count: segments.length, segments },
    impact: {
      endLevel,
      endCapacity,
      levelChange: store.round(endLevel - currentLevel, 2),
      freedCapacityWan: store.round(currentCapacity - endCapacity, 3),
      maxLevel: maxRow ? maxRow.endLevel : currentLevel,
      maxLevelDate: maxRow ? maxRow.date : null,
      minLevel: minRow ? minRow.endLevel : currentLevel,
      minLevelDate: minRow ? minRow.date : null,
      staysUnderLimit,
    },
    daily,
    conclusion,
    notes,
    algorithm: ALGORITHM,
    inputFingerprint,
  };
}

module.exports = { suggestion };
