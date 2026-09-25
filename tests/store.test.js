'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-bot-test-'));
process.env.DATA_FILE = path.join(dir, 'db.json');
const db = require('../src/store');

test('วันที่และเวลาใช้เขตเวลาไทย', () => {
  assert.equal(db.today(new Date('2026-09-24T18:00:00Z')), '2026-09-25');
  assert.equal(db.timeBangkok(new Date('2026-09-25T13:00:00Z')), '20:00');
});
test('ตั้งค่า เพิ่มของ และป้องกันชื่อซ้ำ', () => {
  db.setConfig('test-server', { attendanceChannelId: 'a', inventoryChannelId: 'i', roleId: 'r', time: '20:00' });
  const item = db.addItem('test-server', 'ดาบ', 1);
  assert.equal(db.getGuild('test-server').items[0].id, item.id);
  assert.throws(() => db.addItem('test-server', 'ดาบ', 2), /มีชื่อรายการ/);
});
test('เช็กชื่อ มา/มาสาย/ลา เก็บเหตุผลและไม่บันทึกซ้ำ', () => {
  const date = db.today();
  const item = db.getGuild('test-server').items[0];
  const first = db.attendance('test-server', date, 'user1', 'present');
  assert.equal(first.previous, null);
  const duplicate = db.attendance('test-server', date, 'user1', 'present');
  assert.equal(duplicate.unchanged, true);
  assert.equal(duplicate.record.revision, first.record.revision);
  const late = db.attendance('test-server', date, 'user1', 'late', 'รถติดหนักมาก');
  assert.equal(late.previous.status, 'present');
  assert.equal(late.record.reason, 'รถติดหนักมาก');
  assert.equal(db.attendance('test-server', date, 'user1', 'leave', 'ต้องไปโรงพยาบาล').record.status, 'leave');
  db.inventory('test-server', date, 'user1', item.id, 1, 'normal');
  db.inventory('test-server', date, 'user1', item.id, 0, 'lost');
  const g = db.getGuild('test-server');
  assert.equal(Object.keys(g.attendance[date]).length, 1);
  assert.equal(Object.keys(g.inventory[date].user1).length, 1);
  assert.equal(g.inventory[date].user1[item.id].foundQty, 0);
});

test('ต้องระบุเหตุผลสำหรับมาสายและลา และไม่ทับข้อมูลที่ถูกแก้ไขระหว่างรอยืนยัน', () => {
  const date = db.today(), user = 'user2';
  assert.throws(() => db.attendance('test-server', date, user, 'late'), /เหตุผล/);
  assert.throws(() => db.attendance('test-server', date, user, 'leave', 'ลา'), /เหตุผล/);
  assert.throws(() => db.attendance('test-server', date, user, 'present', 'เหตุผลไม่ควรมี'), /ไม่ต้องระบุ/);
  assert.equal(db.getGuild('test-server').attendance[date]?.[user], undefined);
  const snapshot = 'null';
  db.attendance('test-server', date, user, 'present');
  assert.throws(() => db.attendance('test-server', date, user, 'late', 'รถติดหนักมาก', snapshot), /เปลี่ยนแปลง/);
  assert.equal(db.getGuild('test-server').attendance[date][user].status, 'present');
});

test('สรุปหนึ่งครั้งต่อวันแยกแต่ละห้อง และไม่ลบประวัติเมื่อถอดรายการ', () => {
  const date = db.today();
  db.markSent('test-server', date, 'attendance');
  assert.equal(db.getGuild('test-server').sent[date].attendance, true);
  const item = db.getGuild('test-server').items[0];
  db.removeItem('test-server', item.id);
  assert.equal(db.getGuild('test-server').inventory[date].user1[item.id].name, 'ดาบ');
});

test('ผู้ดูแลแก้ไขสถานะเช็กชื่อแทนสมาชิกและเก็บประวัติพร้อมเวลา', () => {
  const date = db.today(), user = '123456789012345678', admin = '987654321098765432';
  db.attendanceAdminEdit('test-server', date, user, 'leave', 'แจ้งลาไว้ก่อน', admin, '18:15');
  assert.equal(db.getGuild('test-server').attendance[date][user].status, 'leave');
  const result = db.attendanceAdminEdit('test-server', date, user, 'present', 'มาจริงแล้ว ยกเลิกลา', admin, '19:30');
  assert.equal(result.previous.status, 'leave');
  assert.equal(db.getGuild('test-server').attendance[date][user].status, 'present');
  assert.equal(db.getGuild('test-server').attendance[date][user].at, new Date(`${date}T19:30:00+07:00`).toISOString());
  const rows = db.attendanceEditHistory('test-server', { userId: user, limit: 2 });
  assert.equal(rows[0].from, 'leave');
  assert.equal(rows[0].to, 'present');
  assert.equal(rows[0].actorId, admin);
  assert.equal(rows[0].time, '19:30');
});

test('ผู้ดูแลแก้ไขเช็กชื่อด้วยเวลาไม่ถูกต้องไม่ได้', () => {
  assert.throws(() => db.attendanceAdminEdit('test-server', db.today(), '123456789012345678', 'present', '', '987654321098765432', '25:99'), /เวลาไม่ถูกต้อง/);
});

test('เช็กชื่อบ้านแยกจากเช็กชื่อปกติและหัวหน้าบ้านเช็กแทนได้', () => {
  const house = db.houseAdd('g-house', 'บ้าน 1');
  db.houseLeaderSet('g-house', 'บ้าน 1', '111111111111111111');
  db.houseMemberAdd('g-house', 'บ้าน 1', '222222222222222222');
  const result = db.houseMark('g-house', '2026-09-25', house.id, '222222222222222222', 'present', '111111111111111111', 'เช็กโดยหัวหน้าบ้าน');
  assert.equal(result.house.name, 'บ้าน 1');
  assert.equal(result.record.status, 'present');
  const g = db.getGuild('g-house');
  assert.equal(g.houseAttendance['2026-09-25'][house.id]['222222222222222222'].status, 'present');
  assert.equal(g.attendance?.['2026-09-25']?.['222222222222222222'], undefined);
  assert.equal(g.houseAttendanceHistory.length, 1);
});

test('สมาชิกหนึ่งคนถูกย้ายได้บ้านเดียวและห้ามเช็กคนที่ไม่ได้อยู่ในบ้าน', () => {
  const a = db.houseAdd('g-house2', 'บ้าน A');
  const b = db.houseAdd('g-house2', 'บ้าน B');
  db.houseMemberAdd('g-house2', 'บ้าน A', '333333333333333333');
  db.houseMemberAdd('g-house2', 'บ้าน B', '333333333333333333');
  const g = db.getGuild('g-house2');
  assert.equal(g.houses.find(h => h.id === a.id).memberIds.includes('333333333333333333'), false);
  assert.equal(g.houses.find(h => h.id === b.id).memberIds.includes('333333333333333333'), true);
  assert.throws(() => db.houseMark('g-house2', '2026-09-25', a.id, '333333333333333333', 'present', '111111111111111111'), /ไม่ได้อยู่ในบ้านนี้/);
});



test('locker add บวกยอดเองและ locker remove ลดจำนวนเอง', () => {
  const gid = 'g_lock_calc';
  const first = db.lockerAdd(gid, 'ผลึกทะเล', 10, 'ชิ้น');
  assert.equal(first.beforeQty, 0);
  assert.equal(first.afterQty, 10);
  assert.equal(first.created, true);

  const added = db.lockerAdd(gid, 'ผลึกทะเล', 5, 'ชิ้น');
  assert.equal(added.beforeQty, 10);
  assert.equal(added.afterQty, 15);
  assert.equal(added.created, false);

  const removed = db.lockerRemove(gid, 'ผลึกทะเล', 3);
  assert.equal(removed.beforeQty, 15);
  assert.equal(removed.afterQty, 12);
  assert.equal(removed.deleted, false);
  assert.equal(db.getGuild(gid).locker.find(x => x.name === 'ผลึกทะเล').quantity, 12);

  assert.throws(() => db.lockerRemove(gid, 'ผลึกทะเล', 99), /ของในตู้มีแค่/);
});

test('lockerSummary returns rows and item count', () => {
  db.lockerAdd('g_lock_summary', 'red money', 3299, 'บาท');
  db.lockerAdd('g_lock_summary', 'weapon box', 8, 'ชิ้น');
  const g = db.getGuild('g_lock_summary');
  const summary = db.lockerSummary(g);
  assert.equal(summary.totalItems, 2);
  assert.equal(summary.rows.some(x => x.name === 'red money'), true);
});
