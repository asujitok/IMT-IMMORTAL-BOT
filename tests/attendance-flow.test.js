'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const flow = require('../src/attendance-flow');

const params = { guildId: 'guild', userId: 'member', date: '2026-09-25' };

test('มาสายและลาต้องมีเหตุผลยาว 3-250 ตัวอักษร', () => {
  assert.throws(() => flow.validate('late', ''), /เหตุผล/);
  assert.throws(() => flow.validate('leave', 'ลา'), /เหตุผล/);
  assert.throws(() => flow.validate('leave', 'a'.repeat(251)), /เหตุผล/);
  assert.equal(flow.validate('late', ' รถเสียระหว่างทาง '), 'รถเสียระหว่างทาง');
  assert.equal(flow.validate('present', ''), '');
  assert.throws(() => flow.validate('present', 'ใส่ไม่ถูกช่อง'), /ไม่ต้อง/);
  assert.throws(() => flow.validate('unknown', ''), /สถานะ/);
});

test('ยืนยันได้เฉพาะเจ้าของ และกดยืนยันซ้ำไม่ได้', () => {
  const { record } = flow.prepare({ ...params, status: 'late', reason: 'รถเสียระหว่างทาง', now: 1000 });
  assert.throws(() => flow.take(record.id, 'guild', 'other-member', 2000), /ไม่ใช่ของคุณ/);
  assert.throws(() => flow.take(record.id, 'other-guild', 'member', 2000), /ไม่ใช่ของคุณ/);
  const taken = flow.take(record.id, 'guild', 'member', 2000);
  assert.equal(taken.reason, 'รถเสียระหว่างทาง');
  assert.equal(taken.previousSnapshot, 'null');
  assert.throws(() => flow.take(record.id, 'guild', 'member', 2000), /ถูกใช้ไปแล้ว/);
});

test('การยกเลิกไม่บันทึก และรายการยืนยันเก่าจะถูกแทนที่', () => {
  const first = flow.prepare({ ...params, status: 'present', now: 1000 }).record;
  const second = flow.prepare({ ...params, status: 'leave', reason: 'ติดธุระครอบครัว', now: 1001 }).record;
  assert.throws(() => flow.take(first.id, 'guild', 'member', 1002), /ถูกแทนที่/);
  flow.cancel(second.id, 'guild', 'member', 1002);
  assert.throws(() => flow.take(second.id, 'guild', 'member', 1003), /ถูกใช้ไปแล้ว/);
});

test('ปุ่มยืนยันหมดอายุ 5 นาที และไม่บันทึกสถานะซ้ำ', () => {
  const r = flow.prepare({ ...params, status: 'present', now: 1000 }).record;
  assert.throws(() => flow.take(r.id, 'guild', 'member', 1000 + flow.TTL_MS + 1), /หมดอายุ/);
  const duplicate = flow.prepare({ ...params, status: 'present', previous: { status: 'present', reason: '' } });
  assert.equal(duplicate.duplicate, true);
});
