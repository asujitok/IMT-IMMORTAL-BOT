'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imt-bot-test-'));
process.env.DATA_FILE = path.join(dir, 'db.json');
const store = require('../src/store');
const delivery = require('../src/delivery');
const guild = 'testguild';
const date = '2026-09-25';

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
test('ชื่อและจำนวนส่งของถูกตรวจสอบ ป้องกันข้อมูลไม่ถูกต้อง', () => {
  assert.throws(() => delivery.prepare(guild, 'a', '', 3, date), /ชื่อ/);
  assert.throws(() => delivery.prepare(guild, 'a', 'หิน', 0, date), /จำนวน/);
  assert.throws(() => delivery.prepare(guild, 'a', 'เงิน', 1e20, date), /จำนวน/);
});
test('ตรวจยืนยันเฉพาะผู้ส่ง และกดยืนยันซ้ำไม่ได้', () => {
  const p = delivery.prepare(guild, 'a', 'เงิน', 1000000, date);
  assert.throws(() => delivery.take(p.id, guild, 'b'), /ไม่ใช่ของคุณ/);
  const result = delivery.take(p.id, guild, 'a');
  assert.equal(result.quantity, 1000000);
  assert.throws(() => delivery.take(p.id, guild, 'a'), /หมดอายุ|แทนที่/);
});
test('ส่งของ: ✅/❌ เปลี่ยนเฉพาะสถานะ ไม่แก้ยอดตู้แก๊ง และไม่บันทึกซ้ำ', () => {
  // ตั้งยอดตู้เอง: การรับของต้องไม่เพิ่มยอด 1,000,000 โดยอัตโนมัติ
  store.lockerAdd(guild, 'เงิน', 400, 'หน่วย');
  const record = delivery.submit(guild, delivery.prepare(guild, 'a', 'เงิน', 1000000, date));
  delivery.attachMessage(guild, date, record.id, 'ch1', 'msg1');
  assert.equal(delivery.findByMessage(guild, 'msg1').entry.id, record.id);
  assert.equal(delivery.review(guild, date, record.id, 'approved', 'mod').entry.status, 'approved');
  assert.equal(store.getGuild(guild).locker.find(x => x.name === 'เงิน').quantity, 400);
  assert.equal(delivery.review(guild, date, record.id, 'approved', 'mod').unchanged, true);
  assert.equal(store.getGuild(guild).locker.find(x => x.name === 'เงิน').quantity, 400);
  assert.equal(delivery.review(guild, date, record.id, 'rejected', 'mod').entry.status, 'rejected');
  assert.equal(store.getGuild(guild).locker.find(x => x.name === 'เงิน').quantity, 400);
});
test('การส่งใหม่แทนรายการถูกปฏิเสธ และบล็อกการตรวจรายการเก่า', () => {
  const row = delivery.list(store.getGuild(guild), date)[0];
  const replacement = delivery.submit(guild, delivery.prepare(guild, 'a', 'เงิน', 500000, date));
  assert.throws(() => delivery.review(guild, date, row.id, 'approved', 'mod'), /แทนที่/);
  assert.equal(delivery.list(store.getGuild(guild), date).length, 1);
  assert.equal(delivery.review(guild, date, replacement.id, 'approved', 'mod').entry.quantity, 500000);
  assert.equal(store.getGuild(guild).locker.find(x => x.name === 'เงิน').quantity, 400);
});
test('ตู้แก๊งเพิ่ม แก้ไข ลบได้ และกันชื่อซ้ำ', () => {
  const item = store.lockerAdd(guild, 'หิน', 5);
  assert.equal(item.quantity, 5);
  assert.throws(() => store.lockerAdd(guild, 'หิน', 3), /มีรายการนี้แล้ว/);
  assert.equal(store.lockerEdit(guild, 'หิน', 10).quantity, 10);
  assert.equal(store.lockerRemove(guild, 'หิน').name, 'หิน');
});
test('รายงานแจ้งผู้ส่งแล้ว/ขาดส่ง/ยังไม่ส่ง ตามเวลาสรุป', () => {
  const roster = [{id:'a'},{id:'b'}];
  const g = store.getGuild(guild);
  assert.match(delivery.summary(g, date, roster, '20:00','19:30'), /<@a> ✅/);
  assert.match(delivery.summary(g, date, roster, '20:00','19:30'), /<@b> ⬜/);
  assert.match(delivery.summary(g, date, roster, '20:00','20:01'), /<@b> ❌/);
  assert.match(delivery.summary(g, date, null, '20:00','20:01'), /SERVER MEMBERS INTENT/);
});
test('ลด/ลบยอดในตู้แก๊งไม่เปลี่ยนรายงานส่งของ และไม่กีดกันการปฏิเสธย้อนหลัง', () => {
  store.lockerEdit(guild, 'เงิน', 0);
  const entry = delivery.list(store.getGuild(guild), date)[0];
  assert.equal(entry.status, 'approved');
  assert.equal(delivery.review(guild, date, entry.id, 'rejected', 'mod').entry.status, 'rejected');
  assert.equal(store.getGuild(guild).locker.find(x => x.name === 'เงิน').quantity, 0);
  // แก้กลับเป็นอนุมัติอีกครั้ง ต้องไม่เพิ่มยอดตู้
  assert.equal(delivery.review(guild, date, entry.id, 'approved', 'mod').entry.status, 'approved');
  assert.equal(store.getGuild(guild).locker.find(x => x.name === 'เงิน').quantity, 0);
  store.lockerRemove(guild, 'เงิน');
  assert.equal(store.getGuild(guild).locker.find(x => x.name === 'เงิน'), undefined);
  assert.equal(delivery.list(store.getGuild(guild), date)[0].status, 'approved');
});
test('สองระบบใช้ชื่อของเดียวกันได้โดยไม่รบกวนกัน', () => {
  const stock = store.lockerAdd(guild, 'น้ำมัน', 10, 'ชิ้น');
  const record = delivery.submit(guild, delivery.prepare(guild, 'b', 'น้ำมัน', 4, date));
  assert.equal(delivery.review(guild, date, record.id, 'approved', 'mod').entry.status, 'approved');
  assert.equal(store.getGuild(guild).locker.find(x => x.id === stock.id).quantity, 10);
  assert.equal(store.lockerEdit(guild, 'น้ำมัน', 7).quantity, 7);
  assert.equal(delivery.list(store.getGuild(guild), date).find(x => x.id === record.id).quantity, 4);
  store.lockerRemove(guild, 'น้ำมัน');
  assert.equal(delivery.list(store.getGuild(guild), date).find(x => x.id === record.id).status, 'approved');
});
test('ยืนยันการส่งชื่อของใหม่ที่ไม่เคยมีในตู้ ต้องไม่สร้างของใหม่ในตู้', () => {
  const record = delivery.submit(guild, delivery.prepare(guild, 'c', 'เหล็ก', 9, date));
  delivery.review(guild, date, record.id, 'approved', 'mod');
  assert.equal((store.getGuild(guild).locker || []).some(x => x.name === 'เหล็ก'), false);
});
