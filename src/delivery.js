'use strict';
const { randomUUID } = require('node:crypto');
const store = require('./store');

const pending = new Map();
const active = new Map();
const TTL = 5 * 60 * 1000;
const MAX_QUANTITY = 1000000000000;
const STATUS = Object.freeze({ pending: '⏳ รอตรวจ', approved: '✅ ส่งแล้ว', rejected: '❌ ขาดส่ง' });

function validName(name) {
  const value = String(name || '').trim();
  if (!value || value.length > 80 || /[\r\n]/.test(value)) throw new Error('ชื่อของต้องมี 1–80 ตัวอักษรและไม่มีการขึ้นบรรทัดใหม่');
  return value;
}
function validQuantity(qty) {
  if (!Number.isSafeInteger(qty) || qty < 1 || qty > MAX_QUANTITY) throw new Error('จำนวนต้องเป็นจำนวนเต็ม 1–1,000,000,000,000');
  return qty;
}
function prepare(guildId, userId, name, quantity, date, now = Date.now()) {
  name = validName(name); quantity = validQuantity(quantity);
  const key = `${guildId}:${userId}`;
  const oldId = active.get(key);
  if (oldId) pending.delete(oldId);
  for (const [id, p] of pending) if (now > p.expiresAt) pending.delete(id);
  const id = randomUUID();
  const record = { id, guildId, userId, name, quantity, date, expiresAt: now + TTL };
  pending.set(id, record); active.set(key, id);
  return record;
}
function take(id, guildId, userId, now = Date.now()) {
  const p = pending.get(id);
  if (!p) throw new Error('รายการนี้หมดอายุหรือถูกแทนที่แล้ว');
  if (p.guildId !== guildId || p.userId !== userId) throw new Error('รายการนี้ไม่ใช่ของคุณ');
  if (active.get(`${guildId}:${userId}`) !== id) throw new Error('รายการนี้หมดอายุหรือถูกแทนที่แล้ว');
  if (now > p.expiresAt) { pending.delete(id); active.delete(`${guildId}:${userId}`); throw new Error('หมดเวลายืนยัน 5 นาที กรุณาส่งรายการใหม่'); }
  pending.delete(id); active.delete(`${guildId}:${userId}`);
  return p;
}
function cancel(id, guildId, userId) { take(id, guildId, userId); }

// ส่งของบันทึกแยกตามรายวัน และไม่แก้ไขจำนวนในตู้แก๊งโดยเด็ดขาด
function submit(guildId, p) {
  return store.update(guildId, g => {
    g.deliveries ||= {};
    g.deliveries[p.date] ||= [];
    const sameItem = g.deliveries[p.date].filter(x => x.userId === p.userId && x.name.toLocaleLowerCase() === p.name.toLocaleLowerCase() && !x.supersededBy);
    if (sameItem.some(x => x.status === 'pending')) throw new Error('คุณมีรายการนี้ที่รอตรวจอยู่แล้ว ไม่ต้องส่งซ้ำ');
    const record = { id: randomUUID(), seq: g.deliveries[p.date].length + 1, userId: p.userId, name: p.name,
      quantity: p.quantity, at: new Date().toISOString(), status: 'pending', messageId: null, channelId: null,
      reviewedBy: null, reviewedAt: null };
    for (const prev of sameItem) if (prev.status === 'rejected') prev.supersededBy = record.id;
    g.deliveries[p.date].push(record);
    return record;
  });
}
function attachMessage(guildId, date, id, channelId, messageId) {
  return store.update(guildId, g => {
    const entry = g.deliveries?.[date]?.find(x => x.id === id);
    if (!entry) throw new Error('ไม่พบรายการส่งของ');
    entry.channelId = channelId; entry.messageId = messageId;
    return entry;
  });
}
function removeUnposted(guildId, date, id) {
  store.update(guildId, g => {
    const rows = g.deliveries?.[date] || [];
    const idx = rows.findIndex(x => x.id === id && !x.messageId && x.status === 'pending');
    if (idx >= 0) {
      const [entry] = rows.splice(idx, 1);
      for (const x of rows) if (x.supersededBy === entry.id) delete x.supersededBy;
    }
  });
}
function findByMessage(guildId, messageId) {
  const g = store.getGuild(guildId);
  for (const [date, entries] of Object.entries(g?.deliveries || {})) {
    const entry = entries.find(x => x.messageId === messageId);
    if (entry) return { date, entry };
  }
  return null;
}
function review(guildId, date, id, result, reviewerId) {
  if (!['approved','rejected'].includes(result)) throw new Error('ผลตรวจไม่ถูกต้อง');
  return store.update(guildId, g => {
    const entry = g.deliveries?.[date]?.find(x => x.id === id);
    if (!entry) throw new Error('ไม่พบรายการส่งของ');
    if (entry.supersededBy) throw new Error('รายการนี้ถูกแทนที่แล้ว ให้ตรวจรายการล่าสุด');
    if (entry.status === result) return { entry, unchanged: true };
    // ✅/❌ เปลี่ยนเฉพาะสถานะการส่งของ ไม่สร้าง/เพิ่ม/หัก/ลบของในตู้แก๊ง
    // ผู้ดูแลต้องจัดการตู้แก๊งเองผ่าน /locker add, /locker edit, /locker remove
    entry.status = result; entry.reviewedBy = reviewerId; entry.reviewedAt = new Date().toISOString();
    return { entry, unchanged: false };
  });
}
function list(g, date) { return (g.deliveries?.[date] || []).filter(x => !x.supersededBy); }
function summary(g, date, roster = null, cutoff = '20:00', currentTime = store.timeBangkok()) {
  const entries = list(g, date);
  const ids = new Set([...entries.map(x => x.userId), ...(roster || []).map(m => m.id)]);
  const groups = { approved: [], rejected: [], pending: [], absent: [] };
  for (const id of ids) {
    const userEntries = entries.filter(x => x.userId === id);
    if (!userEntries.length) groups.absent.push(id);
    else if (userEntries.some(x => x.status === 'rejected')) groups.rejected.push(id);
    else if (userEntries.some(x => x.status === 'pending')) groups.pending.push(id);
    else groups.approved.push(id);
  }
  const nl = (rows, icon, label) => {
    const visible = rows.slice(0, 20);
    return `${icon} **${label} (${rows.length} คน)**\n` +
      (rows.length ? visible.map((id, idx) => `${idx + 1}. <@${id}> ${icon}`).join('\n') +
      (rows.length > visible.length ? `\n…และอีก ${rows.length - visible.length} คน` : '') : 'ไม่มี');
  };
  let lines = [`📦 **[IMT] IMMORTAL — สรุปส่งของ ${date}**`,
    nl(groups.approved,'✅','ส่งแล้ว'), nl(groups.pending,'⏳','รอตรวจ'), nl(groups.rejected,'❌','ขาดส่ง')];
  if (roster) lines.push(nl(groups.absent, currentTime >= cutoff ? '❌' : '⬜', currentTime >= cutoff ? 'ขาดส่ง (ยังไม่มีรายการ)' : 'ยังไม่ส่ง'));
  else lines.push('หมายเหตุ: ยังไม่สามารถแสดงชื่อผู้ไม่ส่งทั้งหมดได้ ต้องเปิด SERVER MEMBERS INTENT และกำหนด Role สมาชิก');
  return lines.join('\n\n');
}
module.exports = { MAX_QUANTITY, STATUS, validName, validQuantity, prepare, take, cancel, submit,
  attachMessage, removeUnposted, findByMessage, review, list, summary };
