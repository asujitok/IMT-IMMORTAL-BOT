'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, '..', 'data', 'db.json');

const INITIAL_LOCKER = Object.freeze([
  { name: 'ผลึกทะเล', quantity: 2, unit: 'ชิ้น' },
  { name: 'เศษผลึกทะเล', quantity: 39, unit: 'ชิ้น' },
  { name: 'red ticket', quantity: 13, unit: 'ชิ้น' },
  { name: 'ซีเมน', quantity: 4, unit: 'ชิ้น' },
  { name: 'supply loop', quantity: 15, unit: 'ชิ้น' },
  { name: 'weapon box', quantity: 8, unit: 'ชิ้น' },
  { name: 'red money', quantity: 3299, unit: 'บาท' },
  { name: 'event token', quantity: 3, unit: 'ชิ้น' }
]);
function initialLocker() {
  return INITIAL_LOCKER.map(x => ({ id: randomUUID(), ...x }));
}
function ensureGuildShape(g) {
  g.config ||= null;
  g.items ||= [];
  g.attendance ||= {};
  g.inventory ||= {};
  g.sent ||= {};
  if (!Array.isArray(g.locker)) g.locker = initialLocker();
  if (!Array.isArray(g.lockerManagerRoleIds)) g.lockerManagerRoleIds = [];
  return g;
}
function normalizeName(name) {
  const value = String(name || '').trim();
  if (!value || value.length > 80 || /[\r\n]/.test(value)) throw new Error('ชื่อของต้องมี 1–80 ตัวอักษรและไม่มีการขึ้นบรรทัดใหม่');
  return value;
}
function normalizeUnit(unit = 'ชิ้น') {
  const value = String(unit || '').trim();
  if (!value || value.length > 20 || /[\r\n]/.test(value)) throw new Error('หน่วยไม่ถูกต้อง');
  return value;
}
function validLockerQuantity(quantity, { allowZero = true } = {}) {
  if (!Number.isSafeInteger(quantity) || quantity < (allowZero ? 0 : 1)) {
    throw new Error(allowZero ? 'จำนวนต้องเป็นจำนวนเต็มตั้งแต่ 0 ขึ้นไป' : 'จำนวนต้องเป็นจำนวนเต็มตั้งแต่ 1 ขึ้นไป');
  }
  return quantity;
}


function load() {
  if (!fs.existsSync(DATA_FILE)) return { guilds: {} };
  const obj = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  if (!obj || typeof obj !== 'object' || !obj.guilds) throw new Error('รูปแบบไฟล์ข้อมูลไม่ถูกต้อง');
  return obj;
}
function save(db) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const temp = DATA_FILE + '.' + process.pid + '.' + randomUUID() + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(db, null, 2), { mode: 0o600 });
  fs.renameSync(temp, DATA_FILE);
}
function guild(db, guildId) {
  db.guilds[guildId] ||= { config: null, items: [], attendance: {}, inventory: {}, sent: {}, locker: initialLocker(), lockerManagerRoleIds: [] };
  return ensureGuildShape(db.guilds[guildId]);
}
function today(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(now);
}
function timeBangkok(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(now);
  return parts.find(x => x.type === 'hour').value + ':' + parts.find(x => x.type === 'minute').value;
}
function getGuild(id) { const g = load().guilds[id] || null; return g ? ensureGuildShape(g) : null; }
function getGuildIds() { return Object.keys(load().guilds); }
function update(id, fn) {
  const db = load();
  const g = guild(db, id);
  const result = fn(g);
  save(db);
  return result;
}
function setConfig(id, config) { update(id, g => { g.config = { ...(g.config || {}), ...config }; }); }
function addItem(id, name, requiredQty) {
  return update(id, g => {
    if (g.items.some(i => i.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      throw new Error('มีชื่อรายการนี้อยู่แล้ว');
    }
    const item = { id: randomUUID(), name, requiredQty };
    g.items.push(item);
    return item;
  });
}
function removeItem(id, itemId) {
  return update(id, g => {
    const idx = g.items.findIndex(i => i.id === itemId);
    if (idx < 0) throw new Error('ไม่พบรายการของ');
    return g.items.splice(idx, 1)[0];
  });
}
function attendance(id, date, userId, status, reason = '', expectedSnapshot) {
  if (!['present', 'late', 'leave'].includes(status)) throw new Error('สถานะเช็กชื่อไม่ถูกต้อง');
  if (typeof reason !== 'string') throw new Error('เหตุผลไม่ถูกต้อง');
  reason = reason.trim();
  if (status === 'present' && reason) throw new Error('สถานะมาไม่ต้องระบุเหตุผล');
  if (status !== 'present' && (reason.length < 3 || reason.length > 250)) {
    throw new Error('มาสายและลาต้องระบุเหตุผล 3–250 ตัวอักษร');
  }
  return update(id, g => {
    g.attendance[date] ||= {};
    const previous = g.attendance[date][userId] || null;
    if (expectedSnapshot !== undefined && JSON.stringify(previous) !== expectedSnapshot) {
      throw new Error('ข้อมูลเช็กชื่อมีการเปลี่ยนแปลงแล้ว กรุณาเริ่มทำรายการใหม่');
    }
    if (previous?.status === status && (previous.reason || '') === reason) {
      return { previous, unchanged: true, record: previous };
    }
    const record = { status, reason, at: new Date().toISOString(), revision: randomUUID() };
    g.attendance[date][userId] = record;
    return { previous, unchanged: false, record };
  });
}
// ยืนยันลาเป็นช่วงวันในธุรกรรมเดียว ป้องกันการบันทึกค้างเพียงครึ่งช่วง
function attendanceRange(id, dates, userId, reason, expectedSnapshots) {
  if (!Array.isArray(dates) || !dates.length || dates.length > 31 || new Set(dates).size !== dates.length) {
    throw new Error('ช่วงวันลาไม่ถูกต้อง');
  }
  if (typeof reason !== 'string' || reason.trim().length < 3 || reason.trim().length > 250) {
    throw new Error('การลาต้องมีเหตุผล 3–250 ตัวอักษร');
  }
  if (!expectedSnapshots || typeof expectedSnapshots !== 'object') throw new Error('ข้อมูลยืนยันไม่ครบ');
  return update(id, g => {
    const changes = [];
    // ตรวจสอบทุกวันก่อนแก้ไขแม้แต่วันเดียว
    for (const date of dates) {
      const previous = g.attendance?.[date]?.[userId] || null;
      if (!Object.hasOwn(expectedSnapshots, date) || JSON.stringify(previous) !== expectedSnapshots[date]) {
        throw new Error('ข้อมูลเช็กชื่อระหว่างช่วงวันลามีการเปลี่ยนแปลง กรุณาเริ่มใหม่');
      }
      changes.push({ date, previous, unchanged: previous?.status === 'leave' && previous.reason === reason.trim() });
    }
    const at = new Date().toISOString();
    for (const entry of changes) {
      if (entry.unchanged) continue;
      g.attendance[entry.date] ||= {};
      g.attendance[entry.date][userId] = {
        status: 'leave', reason: reason.trim(), at, revision: randomUUID(),
        leaveRange: { from: dates[0], to: dates[dates.length - 1] }
      };
    }
    return { changes, unchanged: changes.every(x => x.unchanged) };
  });
}
// ถ้าอ่านสมาชิกไม่ได้ ห้ามสร้างวันขาดย้อนหลังจากรายชื่อปัจจุบัน
function saveRosterAtClose(id, date, userIds) {
  if (!Array.isArray(userIds)) throw new Error('ต้องมีรายชื่อสมาชิกจริงที่อ่านได้');
  return update(id, g => {
    g.rostersAtClose ||= {};
    if (g.rostersAtClose[date]) return false;
    g.rostersAtClose[date] = [...new Set(userIds)];
    return true;
  });
}
function saveHistoryView(id, view) {
  return update(id, g => { g.historyViews ||= {}; g.historyViews[view.messageId] = view; });
}
function removeHistoryView(id, messageId) {
  return update(id, g => {
    if (!g.historyViews?.[messageId]) return false;
    delete g.historyViews[messageId]; return true;
  });
}
function inventory(id, date, userId, itemId, foundQty, condition, note = '') {
  return update(id, g => {
    const item = g.items.find(i => i.id === itemId);
    if (!item) throw new Error('รายการนี้ถูกลบหรือไม่มีอยู่แล้ว');
    g.inventory[date] ||= {};
    g.inventory[date][userId] ||= {};
    const previous = g.inventory[date][userId][itemId] || null;
    g.inventory[date][userId][itemId] = {
      name: item.name, requiredQty: item.requiredQty, foundQty, condition, note,
      at: new Date().toISOString()
    };
    return { item, previous };
  });
}

// ตู้แก๊งส่วนกลาง แยกจากรายการเช็กของเดิมต่อสมาชิก
function lockerSummary(g) {
  ensureGuildShape(g);
  const rows = g.locker || [];
  const moneyTotal = rows.reduce((sum, x) => {
    const name = String(x.name || '').toLocaleLowerCase();
    const unit = String(x.unit || '').trim();
    return sum + ((unit === 'บาท' || name.includes('money') || name.includes('เงิน')) ? Number(x.quantity || 0) : 0);
  }, 0);
  return { totalItems: rows.length, moneyTotal, rows };
}
function lockerAdd(id, name, quantity, unit = 'ชิ้น') {
  name = normalizeName(name); unit = normalizeUnit(unit); quantity = validLockerQuantity(quantity, { allowZero: false });
  return update(id, g => {
    g.locker ||= [];
    const entry = g.locker.find(x => x.name.toLocaleLowerCase() === name.toLocaleLowerCase());
    if (entry) {
      const next = entry.quantity + quantity;
      if (!Number.isSafeInteger(next)) throw new Error('ยอดรวมเกินจำนวนที่ระบบรองรับ');
      entry.quantity = next;
      entry.unit = unit || entry.unit;
      return { ...entry, added: quantity, existed: true };
    }
    const created = { id: randomUUID(), name, quantity, unit };
    g.locker.push(created);
    return { ...created, added: quantity, existed: false };
  });
}
function lockerEdit(id, name, quantity, unit = null, newName = null) {
  name = normalizeName(name); quantity = validLockerQuantity(quantity);
  return update(id, g => {
    const entry = (g.locker || []).find(x => x.name.toLocaleLowerCase() === name.toLocaleLowerCase());
    if (!entry) throw new Error('ไม่พบรายการในตู้แก๊ง');
    const before = { ...entry };
    if (newName !== null && String(newName).trim()) {
      const targetName = normalizeName(newName);
      const duplicate = (g.locker || []).find(x => x.id !== entry.id && x.name.toLocaleLowerCase() === targetName.toLocaleLowerCase());
      if (duplicate) throw new Error('มีชื่อรายการนี้อยู่แล้ว');
      entry.name = targetName;
    }
    entry.quantity = quantity;
    if (unit !== null && String(unit).trim()) entry.unit = normalizeUnit(unit);
    return { ...entry, before };
  });
}
function lockerRemove(id, name, quantity = null) {
  name = normalizeName(name);
  return update(id, g => {
    const idx = (g.locker || []).findIndex(x => x.name.toLocaleLowerCase() === name.toLocaleLowerCase());
    if (idx < 0) throw new Error('ไม่พบรายการในตู้แก๊ง');
    const entry = g.locker[idx];
    if (quantity === null || quantity === undefined) return g.locker.splice(idx, 1)[0];
    quantity = validLockerQuantity(quantity, { allowZero: false });
    if (entry.quantity < quantity) throw new Error(`จำนวนในตู้มีเพียง ${entry.quantity.toLocaleString('en-US')} ${entry.unit}`);
    entry.quantity -= quantity;
    const result = { ...entry, removed: quantity, deleted: entry.quantity === 0 };
    if (entry.quantity === 0) g.locker.splice(idx, 1);
    return result;
  });
}
function lockerRoleAdd(id, roleId) {
  if (!roleId) throw new Error('ต้องระบุ Role');
  return update(id, g => {
    g.lockerManagerRoleIds ||= [];
    if (!g.lockerManagerRoleIds.includes(roleId)) g.lockerManagerRoleIds.push(roleId);
    return [...g.lockerManagerRoleIds];
  });
}
function lockerRoleRemove(id, roleId) {
  if (!roleId) throw new Error('ต้องระบุ Role');
  return update(id, g => {
    g.lockerManagerRoleIds ||= [];
    g.lockerManagerRoleIds = g.lockerManagerRoleIds.filter(x => x !== roleId);
    return [...g.lockerManagerRoleIds];
  });
}
function lockerRoles(id) {
  const g = getGuild(id);
  return [...(g?.lockerManagerRoleIds || [])];
}


function markSent(id, date, kind) {
  update(id, g => { g.sent[date] ||= {}; g.sent[date][kind] = true; });
}
module.exports = {
  DATA_FILE, load, getGuild, getGuildIds, update, setConfig, addItem, removeItem,
  attendance, attendanceRange, inventory, today, timeBangkok, markSent,
  INITIAL_LOCKER, lockerSummary, lockerAdd, lockerEdit, lockerRemove, lockerRoleAdd, lockerRoleRemove, lockerRoles,
  saveRosterAtClose, saveHistoryView, removeHistoryView
};
