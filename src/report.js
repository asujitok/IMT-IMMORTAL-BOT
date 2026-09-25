'use strict';

// Pure report formatting. Discord user mentions resolve to server nicknames without pinging
// when the caller sets allowedMentions: { parse: [] }.
const STATUS = Object.freeze({ present: 'มา', late: 'มาสาย', leave: 'ลา' });

function clean(value) {
  return String(value || '').replace(/@/g, '@\u200b').replace(/[\r\n`*_|]/g, ' ').trim().slice(0, 250);
}

function formatLines(lines, max = 1000) {
  if (!lines.length) return 'ไม่มี';
  let value = '', used = 0;
  for (const line of lines) {
    const addition = (value ? '\n' : '') + line;
    if (value.length + addition.length + 32 > max) break;
    value += addition;
    used++;
  }
  if (!used) {
    value = lines[0].slice(0, max - 36);
    used = 1;
  }
  if (used < lines.length) value += `\n…และอีก ${lines.length - used} คน`;
  return value;
}

function mentions(users) {
  return users.map((u, idx) => `${idx + 1}. <@${u.id}>`);
}
function bangkokClock(iso) {
  if (!iso) return '--:--';
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
}
function lateMinutes(iso, cutoff = '20:00') {
  const time = bangkokClock(iso), [h, m] = time.split(':').map(Number);
  const [endH, endM] = cutoff.split(':').map(Number);
  return Math.max(0, h * 60 + m - endH * 60 - endM);
}

function attendanceEmbed(g, date, roster = null, mode = 'live') {
  const entries = Object.entries(g.attendance?.[date] || {});
  const groups = { present: [], late: [], leave: [] };
  for (const [id, record] of entries) {
    if (groups[record.status]) groups[record.status].push({ id, ...record });
  }
  for (const key of Object.keys(groups)) {
    groups[key].sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')) || a.id.localeCompare(b.id));
  }
  const missing = Array.isArray(roster) ? roster.filter(m => !(g.attendance?.[date] || {})[m.id]) : null;
  const pendingText = missing ? formatLines(mentions(missing)) :
    'ยังไม่เปิดการอ่านรายชื่อสมาชิกทั้งหมด จึงยังระบุผู้ไม่เช็กไม่ได้';
  const counts = Object.fromEntries(Object.entries(groups).map(([key, users]) => [key, users.length]));
  const submitted = counts.present + counts.late + counts.leave;
  const header = mode === 'final' ? '📋 รายงานสรุปเช็กชื่อรายวัน' :
    mode === 'private' ? '📋 รายงานเช็กชื่อล่าสุด' : '📋 รายงานเช็กชื่อ (อัปเดตอัตโนมัติ)';
  const deadline = g.config?.time || '20:00';
  const fields = [
    { name: `✅ มา (${counts.present} คน)`,
      value: formatLines(groups.present.map((x, idx) => {
        const minutes = lateMinutes(x.at, deadline);
        return `${idx + 1}. <@${x.id}> เวลา ${bangkokClock(x.at)} ${minutes ? `สาย ${minutes} นาที` : 'ไม่สาย'}`;
      })), inline: false },
    { name: `🕒 มาสาย (${counts.late} คน)`,
      value: formatLines(groups.late.map((x, idx) => `${idx + 1}. <@${x.id}> เวลา ${bangkokClock(x.at)}` +
        (lateMinutes(x.at, deadline) ? ` (สาย ${lateMinutes(x.at, deadline)} นาที)` : ' (แจ้งมาสายล่วงหน้า)') +
        `${x.reason ? ' — ' + clean(x.reason) : ''}`)), inline: false },
    { name: `📝 ลา (${counts.leave} คน)`,
      value: formatLines(groups.leave.map((x, idx) => `${idx + 1}. <@${x.id}>${x.reason ? ' — ' + clean(x.reason) : ''}`)), inline: false },
    { name: `⬜ ยังไม่เช็ก (${missing ? missing.length + ' คน' : 'ไม่ทราบจำนวน'})`, value: pendingText, inline: false }
  ];
  return {
    title: `[IMT] IMMORTAL • ${header} • ${date}`,
    description: `เช็กชื่อแล้ว **${submitted} คน**${roster ? ` จากสมาชิกตามบทบาท **${roster.length} คน**` : ''}\n` +
      `เปิดเช็กชื่อ **18:00** • กำหนดเวลา **${deadline}** น.\n` +
      (mode === 'final' ? 'สรุป ณ เวลาที่บอตส่งรายงาน; รายงานสดยังอัปเดตได้' : 'บอตอัปเดตรายงานนี้เมื่อมีสมาชิกยืนยันสถานะ'),
    color: 0x5865F2,
    fields,
    footer: { text: 'เวลาไทย • ดึงชื่อจากบัญชี Discord โดยตรง • ไม่มีการส่งข้อมูลไป Google Sheets หรือ Webhook' },
    timestamp: new Date().toISOString()
  };
}

function inventoryText(g, date, roster = null) {
  const inventory = g.inventory?.[date] || {};
  const users = roster || Object.keys(inventory).map(id => ({ id }));
  const fullyChecked = users.filter(u => g.items.length && g.items.every(it => inventory[u.id]?.[it.id]));
  const incomplete = users.filter(u => g.items.length && !g.items.every(it => inventory[u.id]?.[it.id]));
  const expected = users.length * g.items.length;
  const submitted = users.reduce((count, u) => count + g.items.filter(it => inventory[u.id]?.[it.id]).length, 0);
  const issues = users.flatMap(u => g.items.filter(it => {
    const record = inventory[u.id]?.[it.id];
    return record && (record.foundQty < record.requiredQty || record.condition !== 'normal');
  }).map(it => ({ id: u.id, item: it, record: inventory[u.id][it.id] })));
  if (!g.items.length) return `📦 **รายงานเช็กของ ${date}**\nยังไม่มีรายการของ ให้ผู้ดูแลเพิ่มด้วย /item add`;
  const parts = [
    `📦 **รายงานเช็กของ ${date}**`,
    `ตรวจแล้ว: ${submitted}/${expected} รายการ${roster ? '' : ' (นับเฉพาะคนที่เคยส่งข้อมูล)'}`,
    `**ตรวจครบแล้ว (${fullyChecked.length} คน):** ${formatLines(mentions(fullyChecked), 450)}`,
    roster ? `**ยังตรวจไม่ครบ (${incomplete.length} คน):** ${formatLines(mentions(incomplete), 450)}` :
      'ผู้ที่ยังไม่เริ่มตรวจ: ไม่ทราบ (ต้องเปิดสิทธิ์อ่านรายชื่อสมาชิกก่อน)',
    `**ของไม่ครบ/ชำรุด/สูญหาย:** ${issues.length} รายการ`
  ];
  if (issues.length) {
    parts.push(...issues.slice(0, 8).map(x =>
      `• <@${x.id}>: ${clean(x.item.name)} ${x.record.foundQty}/${x.record.requiredQty} (${({ normal: 'จำนวนไม่ครบ', damaged: 'ชำรุด', lost: 'สูญหาย' })[x.record.condition] || 'ตรวจสอบ'})`));
    if (issues.length > 8) parts.push(`และอีก ${issues.length - 8} รายการ`);
  }
  return parts.join('\n').slice(0, 1900);
}

module.exports = { STATUS, clean, formatLines, bangkokClock, lateMinutes, attendanceEmbed, inventoryText };
