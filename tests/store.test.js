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

test('ผู้ดูแลแก้ไขสถานะเช็กชื่อแทนสมาชิกและเก็บประวัติ', () => {
  const date = db.today(), user = '123456789012345678', admin = '987654321098765432';
  db.attendanceAdminEdit('test-server', date, user, 'leave', 'แจ้งลาไว้ก่อน', admin);
  assert.equal(db.getGuild('test-server').attendance[date][user].status, 'leave');
  const result = db.attendanceAdminEdit('test-server', date, user, 'present', 'มาจริงแล้ว ยกเลิกลา', admin);
  assert.equal(result.previous.status, 'leave');
  assert.equal(db.getGuild('test-server').attendance[date][user].status, 'present');
  const rows = db.attendanceEditHistory('test-server', { userId: user, limit: 2 });
  assert.equal(rows[0].from, 'leave');
  assert.equal(rows[0].to, 'present');
  assert.equal(rows[0].actorId, admin);
});
