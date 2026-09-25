'use strict';
const { randomUUID } = require('node:crypto');

const STATUSES = Object.freeze({ present: '✅ มา', late: '🕒 มาสาย', leave: '📝 ลา' });
const TTL_MS = 5 * 60 * 1000;
const pending = new Map();
const activeByMember = new Map();

function validate(status, reason) {
  if (!Object.hasOwn(STATUSES, status)) throw new Error('สถานะเช็กชื่อไม่ถูกต้อง');
  if (typeof reason !== 'string') throw new Error('เหตุผลไม่ถูกต้อง');
  const trimmed = reason.trim();
  if (status === 'present' && trimmed) throw new Error('สถานะมาไม่ต้องระบุเหตุผล');
  if (status !== 'present' && (trimmed.length < 3 || trimmed.length > 250)) {
    throw new Error('มาสายและลาต้องระบุเหตุผล 3–250 ตัวอักษร');
  }
  return trimmed;
}

function key(guildId, userId) { return `${guildId}:${userId}`; }

function prepare({ guildId, userId, status, reason = '', date, previous = null, dates = null,
  previousByDate = null, now = Date.now() }) {
  reason = validate(status, reason);
  const range = dates || [date];
  if (!Array.isArray(range) || !range.length || range.length > 31 ||
    (status !== 'leave' && range.length !== 1)) throw new Error('ช่วงวันที่ไม่ถูกต้อง');
  // กดเริ่มรายการใหม่ทุกครั้ง ยกเลิกการยืนยันเก่าที่อาจยังเปิดค้างอยู่
  const memberKey = key(guildId, userId);
  const oldId = activeByMember.get(memberKey);
  if (oldId) pending.delete(oldId);
  activeByMember.delete(memberKey);
  // เก็บไว้เฉพาะรายการที่ยังไม่หมดอายุ เพื่อไม่ให้หน่วยความจำโตเรื่อย ๆ
  for (const [expiredId, entry] of pending) {
    if (now > entry.expiresAt) {
      pending.delete(expiredId);
      const expiredKey = key(entry.guildId, entry.userId);
      if (activeByMember.get(expiredKey) === expiredId) activeByMember.delete(expiredKey);
    }
  }
  const snapshots = Object.fromEntries(range.map(day => [day, JSON.stringify(previousByDate?.[day] || (day === date ? previous : null))]));
  const duplicate = range.every(day => {
    const old = previousByDate ? previousByDate[day] : (day === date ? previous : null);
    return old?.status === status && (old.reason || '') === reason;
  });
  if (duplicate) {
    return { duplicate: true, previous };
  }
  const id = randomUUID();
  const record = {
    id, guildId, userId, status, reason, date, dates: range, previousSnapshots: snapshots,
    previousSnapshot: JSON.stringify(previous || null),
    expiresAt: now + TTL_MS
  };
  pending.set(id, record);
  activeByMember.set(memberKey, id);
  return { duplicate: false, record };
}

function take(id, guildId, userId, now = Date.now()) {
  const record = pending.get(id);
  if (!record) throw new Error('รายการนี้ถูกใช้ไปแล้วหรือถูกแทนที่ กรุณาเริ่มใหม่');
  if (record.guildId !== guildId || record.userId !== userId) {
    throw new Error('ปุ่มยืนยันนี้ไม่ใช่ของคุณ');
  }
  pending.delete(id); // Only the rightful member can consume; prevents double submit.
  if (activeByMember.get(key(guildId, userId)) === id) {
    activeByMember.delete(key(guildId, userId));
  }
  if (now > record.expiresAt) throw new Error('รายการยืนยันหมดอายุแล้ว กรุณากดเช็กชื่อใหม่');
  return record;
}

function cancel(id, guildId, userId, now = Date.now()) {
  return take(id, guildId, userId, now);
}

module.exports = { STATUSES, TTL_MS, validate, prepare, take, cancel };
