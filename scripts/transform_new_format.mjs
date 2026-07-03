#!/usr/bin/env node
/**
 * Transform a "new-format" Wiom NPS export (Google Sheets column layout with
 * USER_RATING, COMMENT, Channel, Sprint = "RSP<N> <Mon>'<yy>", Tenure = "6+ months",
 * etc.) into the canonical sprint CSV schema used by public/data/sprints/*.csv:
 *
 *   respondent_id, score, feedback, nps_reason_primary, nps_reason_secondary,
 *   primary_category, plan_type, city, tenure_days, source, sprint_id,
 *   sprint_start, device
 *
 * Usage:
 *   node scripts/transform_new_format.mjs <input.tsv|csv> <output>
 *
 * If <output> ends in .csv, all rows go to that single file.
 * Otherwise <output> is treated as a directory and rows are split by
 * sprint_id into sprint_<id>.csv (e.g. sprint_rsp9.csv).
 *
 * Auto-detects delimiter (tab or comma). Discards columns not in the canonical
 * schema. Tertiary reason is dropped intentionally (product decision).
 */

import fs from 'node:fs';
import path from 'node:path';
import Papa from 'papaparse';

const CANONICAL_HEADERS = [
  'respondent_id', 'score', 'feedback', 'nps_reason_primary',
  'nps_reason_secondary', 'primary_category', 'plan_type', 'city',
  'tenure_days', 'source', 'sprint_id', 'sprint_start', 'device',
];

// Header aliases: canonical → possible source headers (case-insensitive, trimmed).
const HEADER_ALIASES = {
  respondent_id: ['mobile', 'phone', 'phone number', 'user_id', 'respondent_id'],
  score:         ['user_rating', 'score', 'rating', 'nps_score', 'nps_rating'],
  feedback:      ['comment', 'comments', 'feedback', 'open_text', 'verbatim'],
  nps_reason_primary:   ['nps reason - primary', 'nps_reason_primary', 'primary_reason'],
  nps_reason_secondary: ['nps reason - secondary', 'nps_reason_secondary', 'secondary_reason'],
  city:          ['city'],
  tenure_days:   ['tenure // install', 'tenure_days', 'tenure'],
  source:        ['channel', 'source'],
  sprint_id:     ['sprint', 'sprint_id'],
  sprint_start:  ['timestamp', 'date', 'sprint_start', 'created_at'],
  device:        ['device type', 'device_type', 'device'],
  // primary_category, plan_type: left blank to match existing files.
};

// "RSP9 Jun'26" | "Sprint RSP9" | "RSP9" | "9" → "Sprint RSP9"
// "Sprint 12" | "12" (regular sprint) → "Sprint 12"
function normalizeSprintId(raw) {
  if (!raw) return '';
  const s = raw.toString().trim();
  const rspMatch = s.match(/RSP\s*(\d+)/i);
  if (rspMatch) return `Sprint RSP${rspMatch[1]}`;
  const alreadyLabelled = s.match(/^Sprint\s+(\d+)$/i);
  if (alreadyLabelled) return `Sprint ${alreadyLabelled[1]}`;
  const numeric = s.match(/^\d+$/);
  if (numeric) return `Sprint ${s}`;
  return s;
}

// "6+ months" → 200, "3-6 months" → 120, "1-2 months" → 45, numeric → itself.
// Anything unrecognized returns '' so the app treats it as unknown.
function normalizeTenureDays(raw) {
  if (raw == null || raw === '') return '';
  const s = raw.toString().trim().toLowerCase();
  const asInt = parseInt(s, 10);
  if (!isNaN(asInt) && /^-?\d+$/.test(s)) return asInt >= 0 ? asInt : '';
  if (s.includes('6+') || s.includes('6 +') || s.includes('long')) return 200;
  if (s.includes('3-6') || s.includes('3 to 6') || s.includes('mid')) return 120;
  if (s.includes('1-2') || s.includes('1 to 2') || s.includes('early')) return 45;
  return '';
}

// "Jun 5, 2026, 22:03"        → "2026-06-05"
// "2026-06-04T10:11:35+05:30" → "2026-06-04"
// "27-01-2024" (DD-MM-YYYY)   → "2024-01-27"
function normalizeDate(raw) {
  if (!raw) return '';
  const s = raw.toString().trim();
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const ddmmyyyy = s.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (ddmmyyyy) return `${ddmmyyyy[3]}-${ddmmyyyy[2]}-${ddmmyyyy[1]}`;
  const d = new Date(s);
  if (!isNaN(d.getTime())) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
  return '';
}

function pickHeader(headers, aliases) {
  const lower = headers.map(h => h.toLowerCase().trim());
  for (const alias of aliases) {
    const idx = lower.indexOf(alias.toLowerCase());
    if (idx !== -1) return headers[idx];
  }
  return null;
}

function transformRow(row, headerMap) {
  const get = (canonical) => {
    const src = headerMap[canonical];
    if (!src) return '';
    const v = row[src];
    return v == null ? '' : v.toString().trim();
  };

  const score = parseInt(get('score'), 10);
  if (isNaN(score)) return null;

  return {
    respondent_id:        get('respondent_id').replace(/\.0$/, '').replace(/^\+91/, ''),
    score:                Math.max(0, Math.min(10, score)),
    feedback:             get('feedback'),
    nps_reason_primary:   get('nps_reason_primary'),
    nps_reason_secondary: get('nps_reason_secondary'),
    primary_category:     '',
    plan_type:            '',
    city:                 get('city'),
    tenure_days:          normalizeTenureDays(get('tenure_days')),
    source:               get('source'),
    sprint_id:            normalizeSprintId(get('sprint_id')),
    sprint_start:         normalizeDate(get('sprint_start')),
    device:               get('device'),
  };
}

function transform(inputPath, outputPath) {
  const raw = fs.readFileSync(inputPath, 'utf8');
  // Simple delimiter sniff: prefer tab if it appears in the header line.
  const firstLine = raw.split(/\r?\n/, 1)[0] || '';
  const delimiter = firstLine.includes('\t') ? '\t' : ',';

  const parsed = Papa.parse(raw, {
    header: true,
    skipEmptyLines: true,
    delimiter,
    transformHeader: (h) => h.replace(/^﻿/, '').trim(),
  });

  const headers = parsed.meta.fields || [];
  const headerMap = {};
  for (const canonical of Object.keys(HEADER_ALIASES)) {
    const src = pickHeader(headers, HEADER_ALIASES[canonical]);
    if (src) headerMap[canonical] = src;
  }

  const missing = ['score', 'sprint_id'].filter(k => !headerMap[k]);
  if (missing.length) {
    console.error(`FATAL: source file missing required column(s): ${missing.join(', ')}`);
    console.error(`Available headers: ${headers.join(' | ')}`);
    process.exit(1);
  }

  const out = [];
  let skipped = 0;
  for (const row of parsed.data) {
    const rec = transformRow(row, headerMap);
    if (rec) out.push(rec); else skipped++;
  }

  const writeGroup = (rows, target) => {
    const csv = Papa.unparse({
      fields: CANONICAL_HEADERS,
      data: rows.map(r => CANONICAL_HEADERS.map(h => r[h])),
    });
    fs.writeFileSync(target, csv, 'utf8');
    console.log(`  ${rows.length.toString().padStart(5)} rows → ${target}`);
  };

  console.log(`Parsed ${out.length} rows (skipped ${skipped} with invalid score)`);
  console.log(`Delimiter detected: ${delimiter === '\t' ? 'TAB' : 'COMMA'}`);
  console.log(`Header mapping used:`);
  for (const [canonical, src] of Object.entries(headerMap)) {
    console.log(`  ${canonical.padEnd(22)} ← ${src}`);
  }

  if (outputPath.endsWith('.csv')) {
    writeGroup(out, outputPath);
    return;
  }

  // Directory mode: split by sprint_id.
  fs.mkdirSync(outputPath, { recursive: true });
  const groups = {};
  for (const rec of out) {
    const key = (rec.sprint_id || 'unknown').toLowerCase().replace(/^sprint\s+/, '').replace(/\s+/g, '');
    if (!groups[key]) groups[key] = [];
    groups[key].push(rec);
  }
  console.log(`Splitting by sprint into ${outputPath}/`);
  for (const [key, rows] of Object.entries(groups)) {
    writeGroup(rows, path.join(outputPath, `sprint_${key}.csv`));
  }
}

const [, , inputArg, outputArg] = process.argv;
if (!inputArg || !outputArg) {
  console.error('Usage: node scripts/transform_new_format.mjs <input.tsv|csv> <output.csv>');
  process.exit(2);
}
transform(path.resolve(inputArg), path.resolve(outputArg));
