'use strict';
const { bangkokClock, lateMinutes, clean } = require('./report');
const TYPES = Object.freeze({ present: '✅ มา', late: '🕒 มาสาย', leave: '📝 ลา', missing: '⬜ ไม่เช็กชื่อ' });
const KEYS = ['present', 'late', 'leave', 'missing'];
const MAX_LEAVE_DAYS = 31;
const MAX_FUTURE_DAYS = 90;
const VIEW_MS = 5 * 60 * 1000;
const UTC_DAY = 24 * 60 * 60 * 1000;

function utcDay(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('วันที่ต้องเป็น YYYY-MM-DD หรือ วว/ดด/ปปปป');
  const [y, m, d] = date.split('-').map(Number);
  const ms = Date.UTC(y, m - 1, d);
  if (new Date(ms).toISOString().slice(0, 10) !== date) throw new Error('วันที่ไม่ถูกต้อง');
  return ms;
}
function parseThaiDate(value) {
  const raw = String(value || '').trim();
  let iso = raw;
  const thai = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (thai) {
    const y = Number(thai[3]) > 2400 ? Number(thai[3]) - 543 : Number(thai[3]);
    iso = `${y}-${thai[2].padStart(2, '0')}-${thai[1].padStart(2, '0')}`;
  }
  utcDay(iso);
  return iso;
}
function thaiDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return `${d}/${m}/${y + 543}`;
}
function leaveDates(startValue, endValue, nowDate) {
  const start = parseThaiDate(startValue || nowDate);
  const end = parseThaiDate(endValue || start);
  const first = utcDay(start), last = utcDay(end), today = utcDay(nowDate);
  if (first < today) throw new Error('แจ้งลาย้อนหลังไม่ได้ กรุณาเลือกวันนี้หรือวันในอนาคต');
  if (first > today + MAX_FUTURE_DAYS * UTC_DAY) throw new Error('แจ้งลาล่วงหน้าได้ไม่เกิน 90 วัน');
  if (last < first) throw new Error('วันสิ้นสุดต้องไม่อยู่ก่อนวันเริ่มต้น');
  const total = Math.round((last - first) / UTC_DAY) + 1;
  if (total > MAX_LEAVE_DAYS) throw new Error('แจ้งลาต่อครั้งได้ไม่เกิน 31 วัน');
  return Array.from({ length: total }, (_, n) => new Date(first + n * UTC_DAY).toISOString().slice(0, 10));
}
function yesterday(today) { return new Date(utcDay(today) - UTC_DAY).toISOString().slice(0, 10); }
function readableLate(mins) {
  if (!mins) return 'ไม่สาย';
  if (mins < 60) return `สาย ${mins} นาที`;
  const hours = Math.floor(mins / 60), rest = mins % 60;
  return `สาย ${hours} ชั่วโมง${rest ? ` ${rest} นาที` : ''}`;
}
function entries(g, userId, currentDate) {
  const result = { present: [], late: [], leave: [], missing: [] };
  for (const [date, users] of Object.entries(g.attendance || {})) {
    const record = users?.[userId];
    if (record && result[record.status]) result[record.status].push({ date, ...record });
  }
  // ไม่เดารายชื่อย้อนหลังจาก Role ปัจจุบัน: นับขาดเฉพาะวันที่เคยบันทึก roster ณ สิ้นวัน
  for (const [date, ids] of Object.entries(g.rostersAtClose || {})) {
    if (date >= currentDate || !Array.isArray(ids) || !ids.includes(userId) || g.attendance?.[date]?.[userId]) continue;
    result.missing.push({ date });
  }
  for (const list of Object.values(result)) list.sort((a, b) => b.date.localeCompare(a.date));
  return result;
}
function line(type, r, cutoff) {
  const day = thaiDate(r.date);
  if (type === 'missing') return `${day} ไม่เช็กชื่อ`;
  if (type === 'leave') return `${day} ลาเหตุผล ${clean(r.reason)}`;
  const time = bangkokClock(r.at);
  const minutes = lateMinutes(r.at, cutoff);
  const lateness = type === 'late' && !minutes ? 'แจ้งมาสายล่วงหน้า' : readableLate(minutes);
  return `${day} เวลา ${time} ${lateness}${type === 'late' ? ` — ${clean(r.reason)}` : ''}`;
}
function sliceLines(lines, maxChars = 930) {
  if (!lines.length) return ['ไม่มี'];
  const pages = []; let current = [], size = 0;
  for (const [idx, lineText] of lines.entries()) {
    const text = `${idx + 1}. ${lineText}`.slice(0, maxChars - 30);
    if (current.length && size + text.length + 2 > maxChars) {
      pages.push(current.join('\n')); current = []; size = 0;
    }
    current.push(text); size += text.length + 2;
  }
  if (current.length) pages.push(current.join('\n'));
  return pages;
}
function buildHistory(g, userId, today) {
  const groups = entries(g, userId, today);
  const cutoff = g.config?.time || '20:00';
  const slices = Object.fromEntries(KEYS.map(type => [type, sliceLines(groups[type].map(r => line(type, r, cutoff)))]));
  const total = Math.max(...KEYS.map(type => slices[type].length));
  const pages = Array.from({ length: total }, (_, p) => ({
    title: `[IMT] IMMORTAL • ประวัติ <@${userId}>`,
    description: `บัญชี: <@${userId}> • หน้า ${p + 1}/${total}\nประวัติเรียกดูได้ตลอด แต่ข้อความนี้ลบใน 5 นาที`,
    color: 0x5865F2,
    fields: KEYS.map(type => ({
      name: `${TYPES[type]} (${groups[type].length} ครั้ง)`,
      value: slices[type][p] || (p ? '—' : 'ไม่มี'),
      inline: false
    })),
    footer: { text: 'เวลาไทย • 1 วันนับ 1 สถานะ • วันไม่เช็กนับจากรายชื่อที่เก็บ ณ สิ้นวันเท่านั้น' },
    timestamp: new Date().toISOString()
  }));
  return { pages, totals: Object.fromEntries(KEYS.map(type => [type, groups[type].length])) };
}
module.exports = { TYPES, VIEW_MS, MAX_LEAVE_DAYS, parseThaiDate, thaiDate, leaveDates, yesterday, readableLate, entries, buildHistory };
