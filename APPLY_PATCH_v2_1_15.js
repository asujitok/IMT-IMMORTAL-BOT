#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ROOT = process.cwd();
function p(file) { return path.join(ROOT, file); }
function read(file) {
  const full = p(file);
  if (!fs.existsSync(full)) throw new Error(`ไม่พบไฟล์ ${file} — ต้องรันจากโฟลเดอร์โปรเจกต์ที่มี package.json และ src/`);
  return fs.readFileSync(full, 'utf8');
}
function write(file, text) { fs.writeFileSync(p(file), text); }
function replaceOnce(text, from, to, label) {
  if (text.includes(to)) return text;
  if (!text.includes(from)) throw new Error(`หาโค้ดเดิมไม่เจอ: ${label}`);
  return text.replace(from, to);
}
function insertBefore(text, needle, insertion, label) {
  if (text.includes(insertion.trim().split('\n')[0])) return text;
  if (!text.includes(needle)) throw new Error(`หาจุดแทรกไม่เจอ: ${label}`);
  return text.replace(needle, insertion + '\n' + needle);
}

function patchStore() {
  let s = read('src/store.js');

  s = replaceOnce(s,
    "if (!['present', 'late', 'leave'].includes(status)) throw new Error('สถานะเช็กชื่อไม่ถูกต้อง');",
    "if (!['present', 'late', 'leave', 'absent'].includes(status)) throw new Error('สถานะเช็กชื่อไม่ถูกต้อง');",
    'store.attendance allow absent');

  s = replaceOnce(s,
`  if (status === 'present' && reason) throw new Error('สถานะมาไม่ต้องระบุเหตุผล');
  if (status !== 'present' && (reason.length < 3 || reason.length > 250)) {
    throw new Error('มาสายและลาต้องระบุเหตุผล 3–250 ตัวอักษร');
  }`,
`  if (status === 'present' && reason) throw new Error('สถานะมาไม่ต้องระบุเหตุผล');
  if ((status === 'late' || status === 'leave') && (reason.length < 3 || reason.length > 250)) {
    throw new Error('มาสายและลาต้องระบุเหตุผล 3–250 ตัวอักษร');
  }
  if (status === 'absent' && !reason) reason = 'ไม่เช็กชื่อก่อนสรุป 23:59';`,
    'store.attendance absent reason rule');

  s = replaceOnce(s,
    "if (!['present', 'late', 'leave', 'clear'].includes(status)) throw new Error('สถานะใหม่ไม่ถูกต้อง');",
    "if (!['present', 'late', 'leave', 'absent', 'clear'].includes(status)) throw new Error('สถานะใหม่ไม่ถูกต้อง');",
    'store.attendanceAdminEdit allow absent');

  s = replaceOnce(s,
`  if (status !== 'present' && status !== 'clear' && (reason.length < 3 || reason.length > 250)) {
    throw new Error('มาสายและลาต้องระบุเหตุผล 3–250 ตัวอักษร');
  }`,
`  if ((status === 'late' || status === 'leave') && (reason.length < 3 || reason.length > 250)) {
    throw new Error('มาสายและลาต้องระบุเหตุผล 3–250 ตัวอักษร');
  }
  if (status === 'absent' && !reason) reason = 'ปรับเป็นขาดตอนสรุป 23:59';`,
    'store.attendanceAdminEdit absent reason rule');

  const helper = `
function attendanceMarkMissingAbsent(id, date, userIds, reason = 'ไม่เช็กชื่อก่อนสรุป 23:59') {
  date = String(date || today()).trim();
  if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(date)) throw new Error('วันที่ไม่ถูกต้อง');
  const ids = [...new Set((Array.isArray(userIds) ? userIds : [])
    .map(x => String(x || '').trim())
    .filter(x => /^\\d{5,25}$/.test(x)))];
  return update(id, g => {
    g.attendance ||= {};
    g.attendance[date] ||= {};
    const at = new Date().toISOString();
    const added = [];
    for (const userId of ids) {
      if (g.attendance[date][userId]) continue;
      g.attendance[date][userId] = {
        status: 'absent', reason, at,
        revision: randomUUID(), autoAbsent: true
      };
      added.push(userId);
    }
    return { date, count: added.length, userIds: added };
  });
}

function houseMarkMissingAbsent(id, date, reason = 'ไม่เช็กชื่อบ้านก่อนสรุป 23:59') {
  date = String(date || today()).trim();
  if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(date)) throw new Error('วันที่ไม่ถูกต้อง');
  return update(id, g => {
    ensureHouseFields(g);
    g.houseAttendance[date] ||= {};
    const at = new Date().toISOString();
    const entries = [];
    for (const house of g.houses || []) {
      house.memberIds ||= [];
      g.houseAttendance[date][house.id] ||= {};
      const rows = g.houseAttendance[date][house.id];
      for (const userId of house.memberIds) {
        if (rows[userId]) continue;
        const record = { status: 'absent', reason, at, actorId: null, revision: randomUUID(), autoAbsent: true };
        rows[userId] = record;
        const seq = (g.houseAttendanceHistory.at(-1)?.seq || 0) + 1;
        const log = { id: 'HE-' + String(seq).padStart(6, '0'), seq, date,
          houseId: house.id, houseName: house.name, userId, actorId: null,
          from: null, to: 'absent', previousReason: '', reason, at };
        g.houseAttendanceHistory.push(log);
        entries.push(log);
      }
    }
    if (g.houseAttendanceHistory.length > 1000) g.houseAttendanceHistory.splice(0, g.houseAttendanceHistory.length - 1000);
    return { date, count: entries.length, entries };
  });
}

`;
  s = insertBefore(s, 'function markSent(id, date, kind) {', helper, 'insert auto absent helpers');

  s = replaceOnce(s,
    'attendance, attendanceRange, attendanceAdminEdit, attendanceEditHistory, inventory, today, timeBangkok, markSent, lockerAdd, lockerEdit, lockerRemove, lockerIncrease, lockerSummary,',
    'attendance, attendanceRange, attendanceAdminEdit, attendanceEditHistory, attendanceMarkMissingAbsent, inventory, today, timeBangkok, markSent, lockerAdd, lockerEdit, lockerRemove, lockerIncrease, lockerSummary,',
    'export attendanceMarkMissingAbsent');
  s = replaceOnce(s,
    'houseAdd, houseRemove, houseList, houseLeaderSet, houseMemberAdd, houseMemberRemove, housesForLeader, houseMark, houseAttendanceHistory,',
    'houseAdd, houseRemove, houseList, houseLeaderSet, houseMemberAdd, houseMemberRemove, housesForLeader, houseMark, houseMarkMissingAbsent, houseAttendanceHistory,',
    'export houseMarkMissingAbsent');

  write('src/store.js', s);
}

function patchReport() {
  let s = read('src/report.js');
  s = replaceOnce(s,
    "const STATUS = Object.freeze({ present: 'มา', late: 'มาสาย', leave: 'ลา' });",
    "const STATUS = Object.freeze({ present: 'มา', late: 'มาสาย', leave: 'ลา', absent: 'ขาด' });",
    'report STATUS absent');
  s = replaceOnce(s,
    'const groups = { present: [], late: [], leave: [] };',
    'const groups = { present: [], late: [], leave: [], absent: [] };',
    'report groups absent');
  s = replaceOnce(s,
    'const submitted = counts.present + counts.late + counts.leave;',
    'const submitted = counts.present + counts.late + counts.leave + counts.absent;',
    'report submitted absent');
  s = replaceOnce(s,
`    { name: \\`📝 ลา (\\${counts.leave} คน)\\`,
      value: formatLines(groups.leave.map((x, idx) => \\`\\${idx + 1}. <@\\${x.id}>\\${x.reason ? ' — ' + clean(x.reason) : ''}\\`)), inline: false },
    { name: \\`⬜ ยังไม่เช็ก (\\${missing ? missing.length + ' คน' : 'ไม่ทราบจำนวน'})\\`, value: pendingText, inline: false }`,
`    { name: \\`📝 ลา (\\${counts.leave} คน)\\`,
      value: formatLines(groups.leave.map((x, idx) => \\`\\${idx + 1}. <@\\${x.id}>\\${x.reason ? ' — ' + clean(x.reason) : ''}\\`)), inline: false },
    { name: \\`❌ ขาด (\\${counts.absent} คน)\\`,
      value: formatLines(groups.absent.map((x, idx) => \\`\\${idx + 1}. <@\\${x.id}>\\${x.reason ? ' — ' + clean(x.reason) : ''}\\`)), inline: false },
    { name: \\`⬜ ยังไม่เช็ก (\\${missing ? missing.length + ' คน' : 'ไม่ทราบจำนวน'})\\`, value: pendingText, inline: false }`,
    'report absent field');
  write('src/report.js', s);
}

function patchIndex() {
  let s = read('src/index.js');
  s = replaceOnce(s,
    "return ({ present: '✅ มา', late: '🕒 มาสาย', leave: '📝 ลา' })[status] || sanitize(status || '-');",
    "return ({ present: '✅ มา', late: '🕒 มาสาย', leave: '📝 ลา', absent: '❌ ขาด' })[status] || sanitize(status || '-');",
    'index attendanceStatusLabel absent');
  s = replaceOnce(s,
    "return ({ present: 0x2ECC71, late: 0xF1C40F, leave: 0x95A5A6 })[status] || 0x5865F2;",
    "return ({ present: 0x2ECC71, late: 0xF1C40F, leave: 0x95A5A6, absent: 0xE74C3C })[status] || 0x5865F2;",
    'index attendanceWebhookColor absent');

  s = replaceOnce(s,
`function attendanceDailyGroups(g, date, roster = null) {
  const entries = Object.entries(g.attendance?.[date] || {});
  const groups = { present: [], late: [], leave: [] };
  for (const [id, record] of entries) if (groups[record.status]) groups[record.status].push({ id, ...record });
  const missing = Array.isArray(roster) ? roster.filter(m => !(g.attendance?.[date] || {})[m.id]).map(m => ({ id: m.id })) : [];
  return { ...groups, missing };
}`,
`function attendanceDailyGroups(g, date, roster = null) {
  const entries = Object.entries(g.attendance?.[date] || {});
  const groups = { present: [], late: [], leave: [], absent: [] };
  for (const [id, record] of entries) if (groups[record.status]) groups[record.status].push({ id, ...record });
  const missing = Array.isArray(roster) ? roster.filter(m => !(g.attendance?.[date] || {})[m.id]).map(m => ({ id: m.id })) : [];
  return { ...groups, missing };
}`,
    'index attendanceDailyGroups absent');

  s = replaceOnce(s,
    'const total = groups.present.length + groups.late.length + groups.leave.length;',
    'const total = groups.present.length + groups.late.length + groups.leave.length + groups.absent.length;',
    'index total include absent');
  s = replaceOnce(s,
`        { name: \\`📝 ลา (\\${groups.leave.length} คน)\\`, value: line(groups.leave), inline: false },
        Array.isArray(roster) ? { name: \\`❌ ขาด/ยังไม่เช็ก (\\${groups.missing.length} คน)\\`, value: line(groups.missing), inline: false } : { name: '❌ ขาด/ยังไม่เช็ก', value: 'ยังไม่สามารถแสดงรายชื่อทั้งหมดได้ ต้องเปิด SERVER MEMBERS INTENT และกำหนด Role สมาชิก', inline: false },`,
`        { name: \\`📝 ลา (\\${groups.leave.length} คน)\\`, value: line(groups.leave), inline: false },
        { name: \\`❌ ขาด (\\${groups.absent.length} คน)\\`, value: line(groups.absent), inline: false },
        Array.isArray(roster) ? { name: \\`⬜ ยังไม่เช็ก (\\${groups.missing.length} คน)\\`, value: line(groups.missing), inline: false } : { name: '⬜ ยังไม่เช็ก', value: 'ยังไม่สามารถแสดงรายชื่อทั้งหมดได้ ต้องเปิด SERVER MEMBERS INTENT และกำหนด Role สมาชิก', inline: false },`,
    'index daily summary absent field');

  s = replaceOnce(s,
    'const g = store.getGuild(id);\n    if (!g) continue;',
    'let g = store.getGuild(id);\n    if (!g) continue;',
    'dailyWebhookSummaries let g');
  s = replaceOnce(s,
`    if (guild && g.config) {
      try { roster = await optionalRoster(guild, g.config); }
      catch { roster = null; }
    }`,
`    if (guild && g.config) {
      try { roster = await optionalRoster(guild, g.config); }
      catch { roster = null; }
    }
    if (Array.isArray(roster)) {
      const marked = store.attendanceMarkMissingAbsent(id, date, roster.map(m => m.id));
      if (marked.count) console.log(\`ปรับเช็กชื่อปกติเป็นขาดอัตโนมัติ \\${marked.count} คน สำหรับ \\${date}\`);
    }
    if ((g.houses || []).length) {
      const markedHome = store.houseMarkMissingAbsent(id, date);
      if (markedHome.count) console.log(\`ปรับเช็กชื่อบ้านเป็นขาดอัตโนมัติ \\${markedHome.count} คน สำหรับ \\${date}\`);
    }
    g = store.getGuild(id) || g;`,
    'dailyWebhookSummaries mark absent before webhook');

  s = replaceOnce(s,
`    const date = store.today(), now = store.timeBangkok();
    for (const id of store.getGuildIds()) {`,
`    const date = store.today(), now = store.timeBangkok();
    if (now !== '23:59') return;
    for (const id of store.getGuildIds()) {`,
    'dailySummaries only 23:59');
  s = replaceOnce(s,
    "if (!g?.config || now < (g.config.time || '20:00')) continue;",
    "if (!g?.config) continue;",
    'dailySummaries remove early cutoff summary');
  s = replaceOnce(s,
`      const texts = await reportsFor(discordGuild, g, date);`,
`      const rosterForClose = await optionalRoster(discordGuild, g.config);
      if (Array.isArray(rosterForClose)) {
        try { store.saveRosterAtClose(id, date, rosterForClose.map(m => m.id)); } catch {}
        store.attendanceMarkMissingAbsent(id, date, rosterForClose.map(m => m.id));
      }
      if ((g.houses || []).length) store.houseMarkMissingAbsent(id, date);
      const latestGuildData = store.getGuild(id) || g;
      const texts = await reportsFor(discordGuild, latestGuildData, date);`,
    'dailySummaries mark absent before channel reports');

  write('src/index.js', s);
}

function patchReadme() {
  const file = 'README_TH.md';
  let s = fs.existsSync(p(file)) ? read(file) : '';
  const block = `

## PATCH v2.1.15 — สรุป 23:59 และ Reset ส่งของ

นโยบายที่เพิ่มในแพตช์นี้:

- เวลา 23:59 ประเทศไทย ระบบเช็กชื่อปกติจะปรับสมาชิกใน Role ที่ยังไม่เช็กชื่อเป็น **❌ ขาด** อัตโนมัติ ก่อนส่งสรุปเข้า Time_log
- เวลา 23:59 ประเทศไทย ระบบเช็กชื่อบ้านจะปรับลูกบ้านที่ยังไม่ถูกเช็กชื่อเป็น **❌ ขาด** อัตโนมัติ ก่อนส่งสรุปเข้า home_log
- สรุปรายงานจะยังแยกสถานะ: ✅ มา / 🕒 มาสาย / 📝 ลา / ❌ ขาด / ⬜ ยังไม่เช็ก
- ระบบส่งของสรุปผลตอน 23:59 ได้ตามเดิม
- การ reset รายชื่อส่งของจะล้างเฉพาะรายการส่งของรายวัน ไม่ลบ **รายการของที่ต้องส่ง** ที่ผู้ดูแลตั้งไว้
- รายการของที่ต้องส่งยังอยู่ต่อจนกว่าผู้ดูแลจะกด Reset ของเอง
`;
  if (!s.includes('PATCH v2.1.15')) write(file, s + block);
}

try {
  patchStore();
  patchReport();
  patchIndex();
  patchReadme();
  console.log('✅ PATCH v2.1.15 applied successfully');
  console.log('✅ 23:59: ไม่เช็กชื่อ → ขาด');
  console.log('✅ ส่งของ: reset รายชื่อรายวันได้ แต่รายการของที่ตั้งไว้ไม่หาย');
  console.log('ต่อไป: git status → commit → Railway Redeploy');
} catch (err) {
  console.error('❌ PATCH v2.1.15 failed');
  console.error(err.message || err);
  process.exit(1);
}
