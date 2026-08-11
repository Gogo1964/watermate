import { formatInstant, formatDuration, toLocalTime } from '../util/time.js';

/**
 * HTML + plain-text email bodies.
 *
 * Everything is built with inline styles and simple tables because that is the
 * only thing mail clients render reliably. Each template returns
 * `{ subject, html, text }` so the mailer stays dumb.
 */

const PALETTE = {
  ink: '#12263a',
  muted: '#5b7085',
  border: '#dde5ed',
  surface: '#f6f9fc',
  water: '#0a7ea4',
  alert: '#b4232c',
  alertSurface: '#fdf1f1',
  warn: '#a15c00',
  ok: '#1f7a44',
};

/** `0.2381 m³ (238.1 L)` — the unit people bill in plus the one they feel. */
export function formatVolume(value, config, { decimals = 4 } = {}) {
  if (value == null || !Number.isFinite(value)) return '—';
  const unit = config.meter.unit;
  const liters = value * config.meter.litersPerUnit;
  const litersText = Math.abs(liters) >= 100 ? liters.toFixed(0) : liters.toFixed(1);
  return `${value.toFixed(decimals)} ${unit} (${litersText} L)`;
}

export function formatRate(volumePerHour, config) {
  if (volumePerHour == null || !Number.isFinite(volumePerHour)) return '—';
  const liters = volumePerHour * config.meter.litersPerUnit;
  return `${liters.toFixed(1)} L/h`;
}

/* ------------------------------------------------------------------ report */

export function renderDailyReport({ summary, config, comparison = null }) {
  const tz = config.timezone;
  const errorCount = summary.issues.filter((issue) => issue.severity === 'error').length;
  const warnCount = summary.issues.filter((issue) => issue.severity === 'warning').length;

  const subject = `Water report ${summary.date} — ${formatVolume(summary.total, config, { decimals: 3 })}`;

  const rows = [
    ['Date', `${summary.date} (${tz})`],
    ['Total consumption', `<strong>${formatVolume(summary.total, config, { decimals: 3 })}</strong>`],
    ['Start meter reading', `${fmt(summary.startValue)} ${config.meter.unit}`
      + subtle(summary.startReadingAt ? ` at ${formatInstant(summary.startReadingAt, tz, { withZone: false })}` : '')
      + subtle(summary.baselineFromPreviousDay ? ' — last reading before midnight' : ' — first reading of the day')],
    ['End meter reading', `${fmt(summary.endValue)} ${config.meter.unit}`
      + subtle(summary.endReadingAt ? ` at ${formatInstant(summary.endReadingAt, tz, { withZone: false })}` : '')],
    ['Valid readings processed', `${summary.readingCount} <span style="color:${PALETTE.muted}">of ~${summary.expectedReadings} expected</span>`],
  ];

  if (summary.peakInterval) {
    rows.push([
      'Busiest interval',
      `${formatVolume(summary.peakInterval.contribution, config, { decimals: 3 })} ` +
        subtle(`around ${toLocalTime(summary.peakInterval.toTs, tz)}`),
    ]);
  }
  if (summary.flowEpisodes.length > 0) {
    const longest = summary.flowEpisodes.reduce((a, b) => (b.durationMs > a.durationMs ? b : a));
    rows.push([
      'Continuous flow episodes',
      `${summary.flowEpisodes.length} ` + subtle(`longest ${formatDuration(longest.durationMs)}`),
    ]);
  }
  if (comparison) {
    const delta = summary.total - comparison.average;
    const direction = delta >= 0 ? '▲' : '▼';
    const color = delta >= 0 ? PALETTE.warn : PALETTE.ok;
    const percent = comparison.average > 0 ? ` (${((delta / comparison.average) * 100).toFixed(0)}%)` : '';
    rows.push([
      `Average of last ${comparison.days} day(s)`,
      `${formatVolume(comparison.average, config, { decimals: 3 })} ` +
        `<span style="color:${color}">${direction} ${formatVolume(Math.abs(delta), config, { decimals: 3 })}${percent}</span>`,
    ]);
  }

  const badge =
    errorCount > 0
      ? chip(`${errorCount} data issue(s)`, PALETTE.alert)
      : warnCount > 0
        ? chip(`${warnCount} note(s)`, PALETTE.warn)
        : chip('Data complete', PALETTE.ok);

  const html = layout({
    title: 'Daily water report',
    subtitle: `${summary.date} · ${tz}`,
    accent: PALETTE.water,
    body: [
      `<p style="margin:0 0 18px;color:${PALETTE.muted};font-size:14px">${badge}</p>`,
      hero(formatVolume(summary.total, config, { decimals: 3 }), 'consumed yesterday'),
      table(rows),
      hourlyChart(summary, config),
      issueList(summary.issues),
    ].join('\n'),
    footer: `Channel <code>${escapeHtml(summary.channel)}</code> · generated ${formatInstant(Date.now(), tz)}`,
  });

  const text = [
    `WATER CONSUMPTION REPORT — ${summary.date} (${tz})`,
    ''.padEnd(52, '='),
    row('Total consumption:', formatVolume(summary.total, config, { decimals: 3 })),
    row(
      'Start meter reading:',
      `${fmt(summary.startValue)} ${config.meter.unit}` +
        (summary.startReadingAt ? ` at ${formatInstant(summary.startReadingAt, tz, { withZone: false })}` : ''),
    ),
    row(
      'End meter reading:',
      `${fmt(summary.endValue)} ${config.meter.unit}` +
        (summary.endReadingAt ? ` at ${formatInstant(summary.endReadingAt, tz, { withZone: false })}` : ''),
    ),
    row('Valid readings:', `${summary.readingCount} (expected ~${summary.expectedReadings})`),
    summary.peakInterval
      ? row(
          'Busiest interval:',
          `${formatVolume(summary.peakInterval.contribution, config, { decimals: 3 })} around ${toLocalTime(summary.peakInterval.toTs, tz)}`,
        )
      : null,
    comparison
      ? row(`Avg. last ${comparison.days} day(s):`, formatVolume(comparison.average, config, { decimals: 3 }))
      : null,
    '',
    'DATA QUALITY',
    ''.padEnd(52, '-'),
    ...(summary.issues.length === 0
      ? ['No issues detected — all expected readings were present and plausible.']
      : summary.issues.map((issue) => `[${issue.severity.toUpperCase()}] ${issue.message}`)),
    '',
    `Channel: ${summary.channel} · generated ${formatInstant(Date.now(), tz)}`,
  ]
    .filter((line) => line !== null)
    .join('\n');

  return { subject, html, text };
}

/* ----------------------------------------------------- high consumption */

export function renderHighConsumptionAlert({ config, scope, total, threshold, periodLabel, from, to, summary = null }) {
  const tz = config.timezone;
  const overshoot = total - threshold;
  const percent = threshold > 0 ? (total / threshold) * 100 : 0;

  const subject =
    scope === 'daily'
      ? `ALERT: high water consumption — ${formatVolume(total, config, { decimals: 3 })} on ${periodLabel}`
      : `ALERT: high water consumption — ${formatVolume(total, config, { decimals: 3 })} in ${periodLabel}`;

  const rows = [
    ['Period', `${periodLabel} (${tz})`],
    ['Measured consumption', `<strong style="color:${PALETTE.alert}">${formatVolume(total, config, { decimals: 3 })}</strong>`],
    ['Configured threshold', formatVolume(threshold, config, { decimals: 3 })],
    ['Above threshold by', `${formatVolume(overshoot, config, { decimals: 3 })} (${percent.toFixed(0)}% of threshold)`],
    ['Window', `${formatInstant(from, tz, { withZone: false })} → ${formatInstant(to, tz, { withZone: false })}`],
  ];
  if (summary?.peakInterval) {
    rows.push([
      'Busiest interval',
      `${formatVolume(summary.peakInterval.contribution, config, { decimals: 3 })} around ${toLocalTime(summary.peakInterval.toTs, tz)}`,
    ]);
  }

  const settingName = scope === 'daily' ? 'HIGH_CONSUMPTION_THRESHOLD' : 'HOURLY_HIGH_CONSUMPTION_THRESHOLD';
  const cooldown = scope === 'daily' ? config.highConsumption.cooldownHours : config.highConsumption.hourlyCooldownHours;

  const html = layout({
    title: 'High water consumption',
    subtitle: `${periodLabel} · ${tz}`,
    accent: PALETTE.alert,
    body: [
      hero(formatVolume(total, config, { decimals: 3 }), `threshold is ${formatVolume(threshold, config, { decimals: 3 })}`, PALETTE.alert),
      table(rows),
      callout(
        'What to check',
        `<ul style="margin:8px 0 0;padding-left:20px;color:${PALETTE.ink}">
           <li>Any tap, toilet or garden hose left running</li>
           <li>A dripping or leaking fitting</li>
           <li>Appliances that ran unusually often</li>
         </ul>`,
      ),
      note(
        `This alert is sent at most once per ${cooldown} hour(s) for the same period. ` +
          `Adjust <code>${settingName}</code> to change the trigger level.`,
      ),
    ].join('\n'),
    footer: `Channel <code>${escapeHtml(config.meter.channel)}</code> · sent ${formatInstant(Date.now(), tz)}`,
  });

  const text = [
    `HIGH WATER CONSUMPTION ALERT`,
    ''.padEnd(52, '='),
    `Period:               ${periodLabel} (${tz})`,
    `Measured:             ${formatVolume(total, config, { decimals: 3 })}`,
    `Threshold:            ${formatVolume(threshold, config, { decimals: 3 })}`,
    `Above threshold by:   ${formatVolume(overshoot, config, { decimals: 3 })}`,
    `Window:               ${formatInstant(from, tz, { withZone: false })} -> ${formatInstant(to, tz, { withZone: false })}`,
    '',
    'Check for taps left running, leaking fittings or unusual appliance use.',
    `This alert repeats at most once per ${cooldown} hour(s). Tune ${settingName} to change it.`,
  ].join('\n');

  return { subject, html, text };
}

/* ------------------------------------------------------ continuous flow */

export function renderContinuousFlowAlert({ config, event, repeat = false }) {
  const tz = config.timezone;
  const hours = event.durationMs / 3_600_000;
  const rate = hours > 0 ? event.volume / hours : 0;

  const subject =
    `${repeat ? 'REMINDER' : 'ALERT'}: continuous water flow for ${formatDuration(event.durationMs)}` +
    ` — ${formatVolume(event.volume, config, { decimals: 3 })}`;

  const rows = [
    ['Flow started', formatInstant(event.startedAt, tz)],
    ['Still running at', formatInstant(event.throughTs, tz)],
    ['Duration so far', `<strong style="color:${PALETTE.alert}">${formatDuration(event.durationMs)}</strong>`],
    ['Volume during flow', formatVolume(event.volume, config, { decimals: 3 })],
    ['Average rate', formatRate(rate, config)],
    ['Alert threshold', `${config.continuousFlow.durationHours} h of uninterrupted flow`],
    [
      'Flow detection',
      `at least ${formatVolume(config.continuousFlow.detectionThreshold, config)} between two readings`,
    ],
  ];

  const html = layout({
    title: repeat ? 'Water is still flowing' : 'Continuous water flow detected',
    subtitle: `since ${formatInstant(event.startedAt, tz, { withZone: false })} · ${tz}`,
    accent: PALETTE.alert,
    body: [
      hero(formatDuration(event.durationMs), 'of uninterrupted water flow', PALETTE.alert),
      `<p style="margin:0 0 18px;font-size:15px;line-height:1.55;color:${PALETTE.ink}">
         The meter has moved in <em>every</em> measurement interval since
         ${escapeHtml(formatInstant(event.startedAt, tz, { withZone: false }))}, which is longer than the
         configured limit of ${config.continuousFlow.durationHours} hour(s). Continuous flow that never
         pauses is the classic signature of a leak or a tap left open.
       </p>`,
      table(rows),
      callout(
        'Suggested next steps',
        `<ul style="margin:8px 0 0;padding-left:20px;color:${PALETTE.ink}">
           <li>Check toilets, taps and outside hoses</li>
           <li>Look for damp patches near pipes and the water heater</li>
           <li>If nothing is running, consider closing the main valve and calling a plumber</li>
         </ul>`,
      ),
      note(
        config.continuousFlow.reAlertHours > 0
          ? `A reminder follows every ${config.continuousFlow.reAlertHours} hour(s) while the flow continues.`
          : 'No further alert is sent for this episode; a new one can only start after the flow has stopped.',
      ),
    ].join('\n'),
    footer: `Channel <code>${escapeHtml(config.meter.channel)}</code> · sent ${formatInstant(Date.now(), tz)}`,
  });

  const text = [
    `${repeat ? 'REMINDER' : 'ALERT'}: CONTINUOUS WATER FLOW`,
    ''.padEnd(52, '='),
    `Flow started:      ${formatInstant(event.startedAt, tz)}`,
    `Still running at:  ${formatInstant(event.throughTs, tz)}`,
    `Duration so far:   ${formatDuration(event.durationMs)}`,
    `Volume:            ${formatVolume(event.volume, config, { decimals: 3 })}`,
    `Average rate:      ${formatRate(rate, config)}`,
    `Threshold:         ${config.continuousFlow.durationHours} h`,
    '',
    'The meter moved in every interval since the flow started — check for a leak',
    'or a tap left open. If nothing is running, consider closing the main valve.',
  ].join('\n');

  return { subject, html, text };
}

/* -------------------------------------------------------------- helpers */

function layout({ title, subtitle, body, footer, accent }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:24px 12px;background:${PALETTE.surface};font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${PALETTE.ink}">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid ${PALETTE.border};border-radius:12px;overflow:hidden">
    <tr>
      <td style="padding:22px 28px;background:${accent};color:#ffffff">
        <div style="font-size:19px;font-weight:600;letter-spacing:-0.2px">${escapeHtml(title)}</div>
        <div style="font-size:13px;opacity:0.85;margin-top:4px">${escapeHtml(subtitle)}</div>
      </td>
    </tr>
    <tr><td style="padding:24px 28px">
${body}
    </td></tr>
    <tr>
      <td style="padding:14px 28px;background:${PALETTE.surface};border-top:1px solid ${PALETTE.border};font-size:12px;color:${PALETTE.muted}">
        ${footer}<br>Sent by WaterMate
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function hero(value, caption, color = PALETTE.water) {
  return `<div style="margin:0 0 22px;padding:18px 20px;background:${color === PALETTE.alert ? PALETTE.alertSurface : PALETTE.surface};border-radius:10px;border-left:4px solid ${color}">
    <div style="font-size:30px;font-weight:700;color:${color};letter-spacing:-0.5px">${escapeHtml(value)}</div>
    <div style="font-size:13px;color:${PALETTE.muted};margin-top:2px">${escapeHtml(caption)}</div>
  </div>`;
}

function table(rows) {
  const body = rows
    .map(
      ([label, value]) => `<tr>
      <td style="padding:9px 0;border-bottom:1px solid ${PALETTE.border};font-size:13px;color:${PALETTE.muted};width:42%;vertical-align:top">${escapeHtml(label)}</td>
      <td style="padding:9px 0;border-bottom:1px solid ${PALETTE.border};font-size:14px;text-align:right">${value}</td>
    </tr>`,
    )
    .join('\n');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 22px">${body}</table>`;
}

/** Bar chart drawn with table cells so it survives every mail client. */
function hourlyChart(summary, config) {
  const buckets = summary.hourly ?? [];
  const peak = Math.max(...buckets.map((bucket) => bucket.total), 0);
  if (peak <= 0) return '';

  const bars = buckets
    .map((bucket) => {
      const height = Math.max(2, Math.round((bucket.total / peak) * 90));
      const color = bucket.total >= peak * 0.75 ? PALETTE.alert : PALETTE.water;
      const liters = (bucket.total * config.meter.litersPerUnit).toFixed(0);
      return `<td style="vertical-align:bottom;padding:0 1px" title="${bucket.hour}:00 — ${liters} L">
        <div style="height:${height}px;background:${color};border-radius:2px 2px 0 0;opacity:${bucket.total > 0 ? 1 : 0.25}"></div>
      </td>`;
    })
    .join('');

  const labels = buckets
    .map(
      (bucket) =>
        `<td style="text-align:center;font-size:8px;color:${PALETTE.muted};padding-top:3px">${
          bucket.hour % 6 === 0 ? String(bucket.hour).padStart(2, '0') : ''
        }</td>`,
    )
    .join('');

  return `<div style="margin:0 0 22px">
    <div style="font-size:12px;color:${PALETTE.muted};margin-bottom:8px;text-transform:uppercase;letter-spacing:0.6px">Consumption by hour · peak ${(peak * config.meter.litersPerUnit).toFixed(0)} L</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
      <tr style="height:92px">${bars}</tr>
      <tr>${labels}</tr>
    </table>
  </div>`;
}

function issueList(issues) {
  if (issues.length === 0) {
    return `<div style="padding:12px 14px;background:#f1f9f4;border-left:4px solid ${PALETTE.ok};border-radius:8px;font-size:13px;color:${PALETTE.ink}">
      <strong>No data-quality issues.</strong> All expected readings were present and plausible.
    </div>`;
  }
  const items = issues
    .map((issue) => {
      const color = issue.severity === 'error' ? PALETTE.alert : PALETTE.warn;
      return `<li style="margin-bottom:7px;line-height:1.5">
        <span style="color:${color};font-weight:600;text-transform:uppercase;font-size:11px;letter-spacing:0.4px">${issue.severity}</span>
        <span style="color:${PALETTE.ink}"> — ${escapeHtml(issue.message)}</span>
      </li>`;
    })
    .join('\n');
  return `<div style="padding:14px 16px;background:${PALETTE.surface};border-radius:8px">
    <div style="font-size:12px;color:${PALETTE.muted};margin-bottom:8px;text-transform:uppercase;letter-spacing:0.6px">Data quality</div>
    <ul style="margin:0;padding-left:18px;font-size:13px">${items}</ul>
  </div>`;
}

function callout(title, inner) {
  return `<div style="margin:0 0 18px;padding:14px 16px;background:${PALETTE.surface};border-radius:8px">
    <div style="font-size:12px;color:${PALETTE.muted};text-transform:uppercase;letter-spacing:0.6px">${escapeHtml(title)}</div>
    <div style="font-size:13px;line-height:1.5">${inner}</div>
  </div>`;
}

function note(message) {
  return `<p style="margin:0;font-size:12px;color:${PALETTE.muted};line-height:1.5">${message}</p>`;
}

function chip(label, color) {
  return `<span style="display:inline-block;padding:3px 10px;border-radius:999px;background:${color};color:#fff;font-size:11px;font-weight:600;letter-spacing:0.3px">${escapeHtml(label)}</span>`;
}

/** Aligned `label ....... value` line for the plain-text alternative. */
function row(label, value) {
  return `${label.padEnd(24)}${value}`;
}

function subtle(text) {
  return text ? `<span style="color:${PALETTE.muted};font-size:12px">${escapeHtml(text)}</span>` : '';
}

function fmt(value, decimals = 4) {
  return value == null || !Number.isFinite(value) ? '—' : value.toFixed(decimals);
}

export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
