'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'imt-v14-history-'));
process.env.DATA_FILE = path.join(tmp, 'db.json');
const { leaveDates, thaiDate, readableLate, entries, buildHistory, VIEW_MS, yesterday } = require('../src/history');
const { isStatusOpen } = require('../src/clock');
const flow = require('../src/attendance-flow');
const store = require('../src/store');
const guild = 'history-guild';
const member = 'someone';

test('มาเปิดเวลา 18:00–23:59 แต่มาสายและลาเปิดก่อน 18:00 ตามเวลาไทย', () => {
  const at1759 = new Date('2026-09-25T10:59:00Z');
  const at1800 = new Date('2026-09-25T11:00:00Z');
  const at2359 = new Date('2026-09-25T16:59:59Z');
  const at0000 = new Date('2026-09-24T17:00:00Z');
  assert.equal(isStatusOpen('present', at1759), false);
  assert.equal(isStatusOpen('present', at1800), true);
  assert.equal(isStatusOpen('present', at2359), true);
  assert.equal(isStatusOpen('present', at0000), false);
  for (const status of ['late', 'leave']) {
    assert.equal(isStatusOpen(status, at1759), true);
    assert.equal(isStatusOpen(status, at0000), true);
  }
  assert.equal(isStatusOpen('none', at1800), false);
});

test('ช่วงลา 22–23 กันยายน พ.ศ.2569 = 2 วัน รวมวันเริ่มและวันสุดท้าย', () => {
  assert.deepEqual(leaveDates('22/09/2569', '23/09/2569', '2026-09-22'),
    ['2026-09-22', '2026-09-23']);
  assert.equal(thaiDate('2026-09-25'), '25/9/2569');
  assert.deepEqual(leaveDates('2026-09-25', '', '2026-09-25'), ['2026-09-25']);
  assert.deepEqual(leaveDates('28/02/2571', '29/02/2571', '2028-02-28'), ['2028-02-28', '2028-02-29']);
  assert.equal(yesterday('2027-01-01'), '2026-12-31');
  assert.throws(() => leaveDates('31/02/2569', null, '2026-02-01'), /วันที่/);
  assert.throws(() => leaveDates('24/09/2569', '23/09/2569', '2026-09-24'), /ก่อน/);
  assert.throws(() => leaveDates('24/09/2569', null, '2026-09-25'), /ย้อนหลัง/);
  assert.throws(() => leaveDates('25/09/2569', '26/10/2569', '2026-09-25'), /31 วัน/);
});

test('ยืนยันลาหลายวันครั้งเดียว ห้ามทับข้อมูลที่มีคนเปลี่ยนก่อนยืนยัน', () => {
  const days = ['2026-09-22', '2026-09-23'];
  const preview = flow.prepare({ guildId: guild, userId: member, status: 'leave', reason: 'ไม่สบาย',
    date: days[0], dates: days, previousByDate: { [days[0]]: null, [days[1]]: null }, now: 1000 });
  assert.equal(preview.duplicate, false);
  const pending = flow.take(preview.record.id, guild, member, 2000);
  assert.deepEqual(pending.dates, days);
  const written = store.attendanceRange(guild, days, member, pending.reason, pending.previousSnapshots);
  assert.equal(written.changes.length, 2);
  assert.equal(entries(store.getGuild(guild), member, '2026-09-25').leave.length, 2);
  const same = Object.fromEntries(days.map(day => [day, JSON.stringify(store.getGuild(guild).attendance[day][member])]));
  const repeat = store.attendanceRange(guild, days, member, 'ไม่สบาย', same);
  assert.equal(repeat.unchanged, true);
  const data = store.getGuild(guild);
  assert.equal(data.attendance[days[0]][member].revision,
    JSON.parse(same[days[0]]).revision);
  // ลองแก้วันที่สองระหว่างกดพรีวิวและกดยืนยัน การแก้ต้องไม่ลงครึ่งช่วง
  store.attendance(guild, days[1], member, 'late', 'รถติดมาก');
  const firstBefore = store.getGuild(guild).attendance[days[0]][member].revision;
  assert.throws(() => store.attendanceRange(guild, days, member, 'ธุระ', same), /เปลี่ยนแปลง/);
  assert.equal(store.getGuild(guild).attendance[days[0]][member].revision, firstBefore);
  assert.equal(store.getGuild(guild).attendance[days[1]][member].status, 'late');
});

test('ประวัติ 4 หมวด แสดงวันที่ พ.ศ. เวลา ความสาย และนับวันลาทีละวัน', () => {
  const g = {
    config: { time: '20:00' },
    attendance: {
      '2026-09-25': { [member]: { status: 'present', at: '2026-09-25T13:00:00Z' } },
      '2026-09-24': { [member]: { status: 'late', at: '2026-09-24T16:00:00Z', reason: 'รถติด' } },
      '2026-09-23': { [member]: { status: 'leave', reason: 'ไม่สบาย' } },
      '2026-09-22': { [member]: { status: 'leave', reason: 'ไม่สบาย' } }
    },
    rostersAtClose: {
      '2026-09-20': [member],
      '2026-09-24': [member],
      '2026-09-25': [member]
    }
  };
  const { pages, totals } = buildHistory(g, member, '2026-09-26');
  assert.deepEqual(totals, { present: 1, late: 1, leave: 2, missing: 1 });
  assert.match(pages[0].fields[0].value, /25\/9\/2569 เวลา 20:00 ไม่สาย/);
  assert.match(pages[0].fields[1].value, /24\/9\/2569 เวลา 23:00 สาย 3 ชั่วโมง — รถติด/);
  assert.match(pages[0].fields[2].value, /23\/9\/2569 ลาเหตุผล ไม่สบาย/);
  assert.match(pages[0].fields[2].value, /22\/9\/2569 ลาเหตุผล ไม่สบาย/);
  assert.match(pages[0].fields[3].value, /20\/9\/2569 ไม่เช็กชื่อ/);
  assert.equal(readableLate(10), 'สาย 10 นาที');
  assert.equal(readableLate(180), 'สาย 3 ชั่วโมง');
  assert.equal(readableLate(195), 'สาย 3 ชั่วโมง 15 นาที');
  assert.equal(VIEW_MS, 300000);
});

test('แจ้งมาสายก่อนกำหนดเวลาแสดงว่าแจ้งล่วงหน้า ไม่สับสนกับ มาไม่สาย', () => {
  const g = { config: { time: '20:00' }, attendance: {
    '2026-09-25': { [member]: { status: 'late', at: '2026-09-25T10:00:00Z', reason: 'แจ้งรถเสียก่อน' } }
  } };
  const data = buildHistory(g, member, '2026-09-26');
  assert.match(data.pages[0].fields[1].value, /เวลา 17:00 แจ้งมาสายล่วงหน้า/);
});

test('วันที่ไม่มี snapshot สมาชิก ณ สิ้นวัน ไม่ถูกเดาว่าขาดเช็กย้อนหลัง', () => {
  const g = { attendance: { '2026-09-21': { other: { status: 'present' } } }, rostersAtClose: {} };
  assert.equal(entries(g, member, '2026-09-26').missing.length, 0);
  store.saveRosterAtClose(guild, '2026-09-20', [member, member, 'other']);
  assert.equal(store.saveRosterAtClose(guild, '2026-09-20', []), false);
  assert.deepEqual(store.getGuild(guild).rostersAtClose['2026-09-20'], [member, 'other']);
  assert.equal(entries(store.getGuild(guild), member, '2026-09-26').missing.length, 1);
  assert.equal(entries(store.getGuild(guild), member, '2026-09-20').missing.length, 0);
});

test('ประวัติจำนวนมากแบ่งหลายหน้าโดยแต่ละ field ไม่เกิน 1024 ตัวอักษร', () => {
  const g = { config: { time: '20:00' }, attendance: {} };
  for (let n = 1; n <= 60; n++) {
    const day = new Date(Date.UTC(2026, 0, n)).toISOString().slice(0, 10);
    g.attendance[day] = { [member]: { status: 'leave', reason: 'เหตุผลการลาที่ต้องตรวจสอบ'.repeat(8) } };
  }
  const { pages, totals } = buildHistory(g, member, '2026-09-25');
  assert.equal(totals.leave, 60);
  assert.ok(pages.length > 1);
  for (const page of pages) {
    assert.equal(page.fields.length, 4);
    for (const field of page.fields) assert.ok(field.value.length <= 1024);
  }
});

test('ข้อมูลคำขอประวัติแบบชั่วคราวเก็บแยกจากประวัติเช็กชื่อ', () => {
  const view = { messageId: 'message-1', userId: member, targetId: member,
    channelId: 'attendance', page: 0, expiresAt: Date.now() + VIEW_MS };
  const before = store.getGuild(guild).attendance;
  store.saveHistoryView(guild, view);
  assert.equal(store.getGuild(guild).historyViews['message-1'].expiresAt, view.expiresAt);
  assert.equal(store.removeHistoryView(guild, 'message-1'), true);
  assert.equal(store.removeHistoryView(guild, 'message-1'), false);
  assert.deepEqual(store.getGuild(guild).attendance, before);
});
