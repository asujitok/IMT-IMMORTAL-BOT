'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, '..', 'data', 'db.json');

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
  db.guilds[guildId] ||= { config: null, items: [], attendance: {}, inventory: {}, sent: {} };
  return db.guilds[guildId];
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
function getGuild(id) { return load().guilds[id] || null; }
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


function displayItemName(name) {
  const value = String(name || '').trim();
  const key = value.toLocaleLowerCase();
  if (key === 'red money') return 'เงินแดง';
  if (key === 'money') return 'เงินเขียว';
  return value;
}
function normName(name) {
  const value = displayItemName(name);
  if (!value || value.length > 80 || /[\r\n]/.test(value)) throw new Error('ชื่อของต้องมี 1–80 ตัวอักษรและไม่มีการขึ้นบรรทัดใหม่');
  return value;
}
function normUnit(unit = 'ชิ้น') {
  const value = String(unit || 'ชิ้น').trim();
  if (!value || value.length > 20 || /[\r\n]/.test(value)) throw new Error('หน่วยต้องมี 1–20 ตัวอักษรและไม่มีการขึ้นบรรทัดใหม่');
  return value;
}
function deliveryItemUpsert(id, name, quantity, unit = 'ชิ้น') {
  name = normName(name); unit = normUnit(unit);
  if (!Number.isSafeInteger(quantity) || quantity < 0 || quantity > 1000000000000) throw new Error('จำนวนต้องเป็นจำนวนเต็ม 0–1,000,000,000,000');
  return update(id, g => {
    g.deliveryItems ||= [];
    const entry = g.deliveryItems.find(x => x.name.toLocaleLowerCase() === name.toLocaleLowerCase());
    if (entry) { entry.requiredQty = quantity; entry.unit = unit; return { entry, created: false }; }
    const created = { id: randomUUID(), name, requiredQty: quantity, unit };
    g.deliveryItems.push(created); return { entry: created, created: true };
  });
}
function deliveryItemRemove(id, name) {
  name = normName(name);
  return update(id, g => {
    g.deliveryItems ||= [];
    const idx = g.deliveryItems.findIndex(x => x.name.toLocaleLowerCase() === name.toLocaleLowerCase());
    if (idx < 0) throw new Error('ไม่พบรายการของที่ต้องส่ง');
    return g.deliveryItems.splice(idx, 1)[0];
  });
}
function deliveryItemRemoveById(id, itemId) {
  itemId = String(itemId || '').trim();
  if (!itemId) throw new Error('รายการของที่ต้องส่งไม่ถูกต้อง');
  return update(id, g => {
    g.deliveryItems ||= [];
    const idx = g.deliveryItems.findIndex(x => x.id === itemId);
    if (idx < 0) throw new Error('ไม่พบรายการของที่ต้องส่ง');
    return g.deliveryItems.splice(idx, 1)[0];
  });
}
function deliveryRoleAdd(id, roleId) {
  roleId = String(roleId || '').trim();
  if (!roleId) throw new Error('Role ไม่ถูกต้อง');
  return update(id, g => {
    g.deliveryManagerRoleIds ||= [];
    if (!g.deliveryManagerRoleIds.includes(roleId)) g.deliveryManagerRoleIds.push(roleId);
    return [...g.deliveryManagerRoleIds];
  });
}
function deliveryRoleRemove(id, roleId) {
  roleId = String(roleId || '').trim();
  return update(id, g => {
    g.deliveryManagerRoleIds ||= [];
    g.deliveryManagerRoleIds = g.deliveryManagerRoleIds.filter(x => x !== roleId);
    return [...g.deliveryManagerRoleIds];
  });
}
function lockerIncrease(id, name, quantity, unit = 'ชิ้น') {
  name = normName(name); unit = normUnit(unit);
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 1000000000000) throw new Error('จำนวนต้องเป็นจำนวนเต็ม 1–1,000,000,000,000');
  return update(id, g => {
    g.locker ||= [];
    const entry = g.locker.find(x => x.name.toLocaleLowerCase() === name.toLocaleLowerCase());
    if (entry) {
      const beforeQty = entry.quantity;
      const next = entry.quantity + quantity;
      if (!Number.isSafeInteger(next)) throw new Error('ยอดรวมเกินจำนวนที่ระบบรองรับ');
      entry.quantity = next;
      if (unit) entry.unit = unit;
      return { entry, created: false, beforeQty, afterQty: entry.quantity };
    }
    const created = { id: randomUUID(), name, quantity, unit };
    g.locker.push(created);
    return { entry: created, created: true, beforeQty: 0, afterQty: quantity };
  });
}

// ตู้แก๊งส่วนกลาง แยกจากรายการเช็กของเดิมต่อสมาชิก
function lockerAdd(id, name, quantity, unit = 'ชิ้น') {
  name = normName(name); unit = normUnit(unit);
  if (!Number.isSafeInteger(quantity) || quantity < 0 || quantity > 1000000000000) throw new Error('จำนวนต้องเป็นจำนวนเต็มตั้งแต่ 0 ขึ้นไป');
  return update(id, g => {
    g.locker ||= [];
    const entry = g.locker.find(x => normName(x.name).toLocaleLowerCase() === name.toLocaleLowerCase());
    if (entry) {
      entry.name = name;
      entry.quantity = (entry.quantity || 0) + quantity;
      entry.unit = unit || entry.unit || 'ชิ้น';
      return entry;
    }
    const created = { id: randomUUID(), name, quantity, unit };
    g.locker.push(created);
    return created;
  });
}
function lockerEdit(id, name, quantity, unit = null, newName = null) {
  name = normName(name);
  if (!Number.isSafeInteger(quantity) || quantity < 0 || quantity > 1000000000000) throw new Error('จำนวนต้องเป็นจำนวนเต็มตั้งแต่ 0 ขึ้นไป');
  return update(id, g => {
    g.locker ||= [];
    const entry = g.locker.find(x => normName(x.name).toLocaleLowerCase() === name.toLocaleLowerCase());
    if (!entry) throw new Error('ไม่พบรายการในตู้แก๊ง');
    if (newName !== null && String(newName).trim()) entry.name = normName(newName);
    else entry.name = normName(entry.name);
    entry.quantity = quantity;
    if (unit !== null && String(unit).trim()) entry.unit = normUnit(unit);
    return entry;
  });
}
function lockerRemove(id, name, quantity = null) {
  name = normName(name);
  return update(id, g => {
    g.locker ||= [];
    const idx = g.locker.findIndex(x => normName(x.name).toLocaleLowerCase() === name.toLocaleLowerCase());
    if (idx < 0) throw new Error('ไม่พบรายการในตู้แก๊ง');
    const entry = g.locker[idx];
    entry.name = normName(entry.name);
    if (quantity === null || quantity === undefined) return g.locker.splice(idx, 1)[0];
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 1000000000000) throw new Error('จำนวนต้องเป็นจำนวนเต็ม 1–1,000,000,000,000');
    if ((entry.quantity || 0) <= quantity) {
      const removed = g.locker.splice(idx, 1)[0];
      return { ...removed, deleted: true, quantity: 0 };
    }
    entry.quantity -= quantity;
    return { ...entry, deleted: false };
  });
}
function lockerSummary(g) {
  const rows = (g?.locker || []).map(x => ({ ...x, name: displayItemName(x.name), quantity: Number(x.quantity || 0), unit: x.unit || 'ชิ้น' }));
  const moneyTotal = rows.filter(x => ['เงินแดง','เงินเขียว'].includes(displayItemName(x.name)) || String(x.unit || '').trim() === 'บาท')
    .reduce((sum, x) => sum + Number(x.quantity || 0), 0);
  return { rows, totalItems: rows.length, moneyTotal };
}
function lockerRoleAdd(id, roleId) {
  roleId = String(roleId || '').trim();
  if (!roleId) throw new Error('Role ไม่ถูกต้อง');
  return update(id, g => {
    g.lockerManagerRoleIds ||= [];
    if (!g.lockerManagerRoleIds.includes(roleId)) g.lockerManagerRoleIds.push(roleId);
    return [...g.lockerManagerRoleIds];
  });
}
function lockerRoleRemove(id, roleId) {
  roleId = String(roleId || '').trim();
  return update(id, g => {
    g.lockerManagerRoleIds ||= [];
    g.lockerManagerRoleIds = g.lockerManagerRoleIds.filter(x => x !== roleId);
    return [...g.lockerManagerRoleIds];
  });
}


function deliveryLogAdd(id, type, data = {}) {
  if (!type || typeof type !== 'string') throw new Error('ประเภทประวัติส่งของไม่ถูกต้อง');
  return update(id, g => {
    g.deliveryHistory ||= [];
    const seq = (g.deliveryHistory.at(-1)?.seq || 0) + 1;
    const entry = {
      id: 'DL-' + String(seq).padStart(6, '0'), seq, type,
      date: data.date || today(), at: new Date().toISOString(),
      actorId: data.actorId || null, userId: data.userId || null, reviewerId: data.reviewerId || null,
      deliveryId: data.deliveryId || null, itemName: data.itemName || null,
      quantity: Number.isSafeInteger(data.quantity) ? data.quantity : null,
      unit: data.unit || null, status: data.status || null, lockerAction: data.lockerAction || null,
      beforeQty: Number.isSafeInteger(data.beforeQty) ? data.beforeQty : null,
      afterQty: Number.isSafeInteger(data.afterQty) ? data.afterQty : null,
      note: data.note || null
    };
    g.deliveryHistory.push(entry);
    if (g.deliveryHistory.length > 1000) g.deliveryHistory.splice(0, g.deliveryHistory.length - 1000);
    return entry;
  });
}
function deliveryHistory(id, { userId = null, itemName = null, date = null, limit = 10 } = {}) {
  const g = getGuild(id);
  let rows = [...(g?.deliveryHistory || [])];
  if (userId) rows = rows.filter(x => x.userId === userId || x.actorId === userId || x.reviewerId === userId);
  if (itemName) {
    const target = String(itemName).trim().toLocaleLowerCase();
    rows = rows.filter(x => String(x.itemName || '').toLocaleLowerCase().includes(target));
  }
  if (date) rows = rows.filter(x => x.date === date);
  return rows.reverse().slice(0, Math.max(1, Math.min(Number(limit) || 10, 25)));
}


function deliveryResetRows(id, date) {
  date = String(date || today()).trim();
  return update(id, g => {
    g.deliveries ||= {};
    const removed = g.deliveries[date] || [];
    g.deliveries[date] = [];
    return { date, count: removed.length };
  });
}
function deliveryResetItems(id) {
  return update(id, g => {
    g.deliveryItems ||= [];
    const removed = g.deliveryItems;
    g.deliveryItems = [];
    return { count: removed.length, items: removed };
  });
}

function markSent(id, date, kind) {
  update(id, g => { g.sent[date] ||= {}; g.sent[date][kind] = true; });
}
module.exports = {
  DATA_FILE, load, getGuild, getGuildIds, update, setConfig, addItem, removeItem,
  attendance, attendanceRange, inventory, today, timeBangkok, markSent, lockerAdd, lockerEdit, lockerRemove, lockerIncrease,
  deliveryItemUpsert, deliveryItemRemove, deliveryItemRemoveById, deliveryResetRows, deliveryResetItems, deliveryRoleAdd, deliveryRoleRemove,
  lockerSummary, lockerRoleAdd, lockerRoleRemove,
  deliveryLogAdd, deliveryHistory, saveRosterAtClose, saveHistoryView, removeHistoryView
};
