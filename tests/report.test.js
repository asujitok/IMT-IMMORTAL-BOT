'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { attendanceEmbed, inventoryText, formatLines } = require('../src/report');

const date = '2026-09-25';
const guild = {
  attendance: { [date]: {
    '111111111111111111': { status: 'present', at: '2026-09-25T01:00:00Z' },
    '222222222222222222': { status: 'late', reason: 'รถติด', at: '2026-09-25T02:00:00Z' },
    '333333333333333333': { status: 'leave', reason: 'ธุระครอบครัว', at: '2026-09-25T03:00:00Z' }
  }},
  items: [{ id: 'sword', name: 'ดาบ', requiredQty: 1 }],
  inventory: { [date]: {
    '111111111111111111': { sword: { foundQty: 1, requiredQty: 1, condition: 'normal' } },
    '222222222222222222': { sword: { foundQty: 0, requiredQty: 1, condition: 'lost' } }
  }}
};
const roster = ['111111111111111111', '222222222222222222', '333333333333333333', '444444444444444444'].map(id => ({ id }));

test('รายงาน Discord แยกรายชื่อ มา/มาสาย/ลาและเหตุผล ไม่ใช่จำนวนอย่างเดียว', () => {
  const r = attendanceEmbed(guild, date);
  assert.match(r.fields[0].value, /<@111111111111111111>/);
  assert.match(r.fields[1].value, /<@222222222222222222> เวลา .* — รถติด/);
  assert.match(r.fields[2].value, /<@333333333333333333> — ธุระครอบครัว/);
  assert.match(r.fields[3].value, /ยังไม่เปิดการอ่านรายชื่อ/);
  assert.match(r.description, /3 คน/);
});

test('เมื่ออ่านสมาชิกได้ บอกชื่อคนที่ยังไม่เช็กและจำนวนจริง', () => {
  const r = attendanceEmbed(guild, date, roster, 'final');
  assert.match(r.fields[3].name, /1 คน/);
  assert.match(r.fields[3].value, /<@444444444444444444>/);
  assert.match(r.title, /รายงานสรุป/);
});

test('จัดกลุ่มการแก้ไขสถานะครั้งล่าสุดของแต่ละ Discord ID เท่านั้น', () => {
  const copy = structuredClone(guild);
  copy.attendance[date]['111111111111111111'] = { status: 'late', reason: 'เดินทางล่าช้า' };
  const r = attendanceEmbed(copy, date);
  assert.equal(r.fields[0].value, 'ไม่มี');
  assert.match(r.fields[1].value, /111111111111111111.*เดินทางล่าช้า/);
});

test('จำกัดความยาว embed field และแสดงจำนวนชื่อที่ซ่อนไว้', () => {
  const copy = { attendance: { [date]: {} } };
  for (let i = 0; i < 240; i++) {
    const id = String(100000000000000000n + BigInt(i));
    copy.attendance[date][id] = { status: 'present', at: new Date(2026, 8, 25, 0, 0, i).toISOString() };
  }
  const r = attendanceEmbed(copy, date);
  assert.ok(r.fields.every(f => f.value.length <= 1024));
  assert.match(r.fields[0].name, /240 คน/);
  assert.match(r.fields[0].value, /และอีก/);
  assert.ok(formatLines([]).includes('ไม่มี'));
});

test('รายงานเช็กของแสดงชื่อผู้ตรวจครบ ผู้ตรวจไม่ครบ และรายการผิดปกติ', () => {
  const r = inventoryText(guild, date, roster);
  assert.match(r, /<@111111111111111111>/);
  assert.match(r, /<@333333333333333333>/);
  assert.match(r, /<@222222222222222222>.*ดาบ/);
});

test('เหตุผลที่มี markdown หรือ @everyone ถูกทำให้ไม่เป็นการ ping หรือ markup แปลก', () => {
  const copy = structuredClone(guild);
  copy.attendance[date]['222222222222222222'].reason = '@everyone **บางอย่าง**';
  const value = attendanceEmbed(copy, date).fields[1].value;
  assert.doesNotMatch(value, /@everyone/);
  assert.doesNotMatch(value, /\*\*/);
});
