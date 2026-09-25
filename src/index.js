'use strict';
require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const cron = require('node-cron');
const {
  Client, GatewayIntentBits, Events, MessageFlags, PermissionFlagsBits, Partials,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle, EmbedBuilder
} = require('discord.js');
const store = require('./store');
const attendanceFlow = require('./attendance-flow');
const report = require('./report');
const delivery = require('./delivery');
const clock = require('./clock');
const history = require('./history');
const logoFile = path.join(__dirname, '..', 'assets', 'IMMORTAL-2.png');
const hasLogo = fs.existsSync(logoFile);
const token = process.env.DISCORD_TOKEN;
const deliveryLogWebhookUrl = process.env.DELIVERY_LOG_WEBHOOK_URL || '';
const vaultLogWebhookUrl = process.env.VAULT_LOG_WEBHOOK_URL || process.env.VAULT_LOG || process.env.Vault_log || '';
const timeLogWebhookUrl = process.env.TIME_LOG_WEBHOOK_URL || process.env.TIME_LOG || process.env.Time_log || '';
const homeLogWebhookUrl = process.env.HOME_LOG_WEBHOOK_URL || process.env.HOME_LOG || process.env.home_log || process.env.Home_log || process.env.homeLog || '';
const reminderLogWebhookUrl = process.env.REMINDER_LOG_WEBHOOK_URL || process.env.REMINDER_LOG || process.env.reminder_log || '';
const homeReminderWebhookUrl = process.env.HOME_REMINDER_LOG_WEBHOOK_URL || process.env.HOME_REMINDER_LOG || process.env.home_reminder_log || reminderLogWebhookUrl || '';
const disciplineLogWebhookUrl = process.env.DISCIPLINE_LOG_WEBHOOK_URL || process.env.DISCIPLINE_LOG || process.env.discipline_log || '';
const weeklyLogWebhookUrl = process.env.WEEKLY_LOG_WEBHOOK_URL || process.env.WEEKLY_LOG || process.env.weekly_log || '';
const adminLogWebhookUrl = process.env.ADMIN_LOG_WEBHOOK_URL || process.env.ADMIN_LOG || process.env.admin_log || '';
const backupLogWebhookUrl = process.env.BACKUP_LOG_WEBHOOK_URL || process.env.BACKUP_LOG || process.env.backup_log || '';
const profileLogWebhookUrl = process.env.PROFILE_LOG_WEBHOOK_URL || process.env.PROFILE_LOG || process.env.profile_log || '';
if (!token || token === 'PUT_YOUR_BOT_TOKEN_HERE') {
  console.error('กรุณาใส่ DISCORD_TOKEN ในไฟล์ .env');
  process.exit(1);
}
// บังคับเปิด GuildMembers intent เพื่ออ่านรายชื่อสมาชิกสำหรับปุ่ม 📋 ดูรายชื่อ
// ต้องเปิด SERVER MEMBERS INTENT ใน Discord Developer Portal ด้วย
const hasMemberIntent = true;
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildMembers
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction]
});
const silent = { parse: [] };
const attendanceNames = attendanceFlow.STATUSES;
const conditionNames = { normal: 'ปกติ', damaged: 'ชำรุด', lost: 'สูญหาย' };

function sanitize(value) {
  return String(value || '-').replace(/@/g, '@\u200b').replace(/[\r\n`*_|]/g, ' ').slice(0, 250);
}
function displayItemName(value) {
  const raw = String(value || '').trim();
  const key = raw.toLocaleLowerCase();
  if (key === 'red money') return 'เงินแดง';
  if (key === 'money') return 'เงินเขียว';
  return raw;
}
function itemLabel(value) { return sanitize(displayItemName(value)); }
function nextDateISO(date) {
  const [y, m, d] = String(date || '').split('-').map(Number);
  if (!y || !m || !d) return store.today();
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return next.toISOString().slice(0, 10);
}
function attendanceStatusLabel(status) {
  return ({ present: '✅ มา', late: '🕒 มาสาย', leave: '📝 ลา' })[status] || sanitize(status || '-');
}
function attendanceWebhookColor(status) {
  return ({ present: 0x2ECC71, late: 0xF1C40F, leave: 0x95A5A6 })[status] || 0x5865F2;
}
function timeFooterText(kind = 'Time Log') {
  return `[IMT] IMMORTAL • ${kind} • เวลาไทย`;
}
function onlyTeam(i, g) {
  const roles = i.member?.roles;
  return i.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ||
    Boolean(g?.config && (roles?.cache?.has(g.config.roleId) || roles?.includes?.(g.config.roleId)));
}
function isHouseMember(g, userId) {
  return Boolean((g?.houses || []).some(h => Array.isArray(h.memberIds) && h.memberIds.includes(userId)));
}
function canUseDelivery(i, g) {
  return onlyTeam(i, g) || isHouseMember(g, i.user.id);
}
function manager(i) { return i.memberPermissions?.has(PermissionFlagsBits.ManageGuild); }
function ep(content) { return { content, flags: MessageFlags.Ephemeral, allowedMentions: silent }; }
function configOf(i) {
  const g = store.getGuild(i.guildId);
  if (!g?.config) throw new Error('ยังไม่ได้ตั้งค่า กรุณาให้ผู้ดูแลใช้ /setup ก่อน');
  return g;
}
async function announce(guild, channelId, message) {
  try {
    const channel = await guild.channels.fetch(channelId);
    if (!channel?.isTextBased()) throw new Error('ห้องไม่รองรับการส่งข้อความ');
    await channel.send(typeof message === 'string'
      ? { content: message.slice(0, 1900), allowedMentions: silent }
      : { ...message, allowedMentions: silent });
    return true;
  } catch (error) {
    console.error('ส่งข้อความไปที่ห้องไม่ได้:', channelId, error.message);
    return false;
  }
}
// หนึ่งข้อความรายงานต่อวันในห้อง Discord; อัปเดตข้อความเดิมทุกครั้งที่เช็กชื่อ
const dashboardQueues = new Map();
const rosterCache = new Map();
const ROSTER_CACHE_MS = 120000;
async function optionalRoster(guild, config, force = false) {
  const key = `${guild.id}:${config.roleId || 'none'}`;
  const cached = rosterCache.get(key);
  if (!force && cached && Date.now() - cached.at < ROSTER_CACHE_MS) return cached.members;
  try {
    const members = await guild.members.fetch({ withPresences: false });
    const roster = [...members.values()].filter(m => !m.user.bot && m.roles.cache.has(config.roleId));
    rosterCache.set(key, { at: Date.now(), members: roster });
    return roster;
  } catch (error) {
    console.error('อ่านสมาชิกเพื่อรายงานไม่ได้:', error?.code || '', error?.message || error);
    if (cached?.members?.length) return cached.members;
    return { __error: true, message: error?.message || String(error), code: error?.code || null };
  }
}
function historyButtons(page, total) {
  return total <= 1 ? [] : [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('history:prev').setLabel('◀ ก่อนหน้า')
      .setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
    new ButtonBuilder().setCustomId('history:next').setLabel('ถัดไป ▶')
      .setStyle(ButtonStyle.Primary).setDisabled(page + 1 >= total)
  )];
}
const deletionTimers = new Map();
async function removeHistoryMessage(guildId, messageId) {
  const entry = store.getGuild(guildId)?.historyViews?.[messageId];
  if (!entry || Date.now() < entry.expiresAt) return;
  try {
    const server = await client.guilds.fetch(guildId);
    const channel = await server.channels.fetch(entry.channelId);
    if (!channel?.isTextBased()) throw new Error('ไม่พบห้องข้อความสำหรับลบประวัติ');
    const message = await channel.messages.fetch(messageId).catch(e => {
      if (e.code === 10008) return null;
      throw e;
    });
    if (message) await message.delete();
    store.removeHistoryView(guildId, messageId);
    deletionTimers.delete(messageId);
  } catch (error) {
    console.error('ลบข้อความประวัติยังไม่สำเร็จ (จะลองใหม่):', error.message);
  }
}
function scheduleHistoryDelete(guildId, messageId, expiresAt, deleteInteractionReply = null) {
  if (deletionTimers.has(messageId)) clearTimeout(deletionTimers.get(messageId));
  const timer = setTimeout(() => {
    deletionTimers.delete(messageId);
    (async () => {
      if (deleteInteractionReply) {
        try {
          await deleteInteractionReply();
          store.removeHistoryView(guildId, messageId);
          return;
        } catch (error) {
          console.error('ลบผ่านคำตอบเดิมไม่ได้ ลองลบผ่านห้อง:', error.message);
        }
      }
      await removeHistoryMessage(guildId, messageId);
    })().catch(console.error);
  }, Math.max(0, expiresAt - Date.now()));
  timer.unref();
  deletionTimers.set(messageId, timer);
}
async function cleanupHistoryViews() {
  for (const id of store.getGuildIds()) {
    const views = store.getGuild(id)?.historyViews || {};
    for (const [messageId, entry] of Object.entries(views)) {
      if (Date.now() >= entry.expiresAt) await removeHistoryMessage(id, messageId);
      else if (!deletionTimers.has(messageId)) scheduleHistoryDelete(id, messageId, entry.expiresAt);
    }
  }
}
// ถ้าบอตออนไลน์ ณ 23:59 ให้เก็บรายชื่อใน Role ณ สิ้นวันเพื่ออ้างอิงการขาดเช็ก
// ไม่สร้างประวัติขาดสำหรับวันที่ไม่ได้ snapshot (เช่น บอตปิด หรือยังไม่ได้เปิด Member Intent)
async function snapshotRosterNearMidnight() {
  if (store.timeBangkok() !== '23:59' || !hasMemberIntent) return;
  const date = store.today();
  for (const guildId of store.getGuildIds()) {
    const data = store.getGuild(guildId);
    if (!data?.config || data.rostersAtClose?.[date]) continue;
    const guild = client.guilds.cache.get(guildId);
    if (!guild) continue;
    const roster = await optionalRoster(guild, data.config);
    if (roster !== null) store.saveRosterAtClose(guildId, date, roster.map(m => m.id));
  }
}
async function refreshDashboard(guild, date = store.today()) {
  const key = `${guild.id}:${date}`;
  const previous = dashboardQueues.get(key) || Promise.resolve();
  const task = previous.catch(() => {}).then(async () => {
    const g = store.getGuild(guild.id);
    if (!g?.config) return false;
    const channel = await guild.channels.fetch(g.config.attendanceChannelId);
    if (!channel?.isTextBased()) throw new Error('ห้องรายงานเช็กชื่อใช้ไม่ได้');
    const roster = await optionalRoster(guild, g.config);
    const current = g.dashboard?.[date];
    const embedData = report.attendanceEmbed(g, date, roster, 'live');
    if (current?.logo && hasLogo) embedData.thumbnail = { url: 'attachment://IMMORTAL-2.png' };
    const embed = new EmbedBuilder(embedData);
    if (current?.channelId === channel.id && current.messageId) {
      try {
        // บอตรุ่นเก่ามีรายงานเดิมที่ยังไม่มีโลโก้: เพิ่มไฟล์ไปยังข้อความเดิมครั้งเดียว
        if (hasLogo && !current.logo) {
          embed.setThumbnail('attachment://IMMORTAL-2.png');
          await channel.messages.edit(current.messageId, { embeds: [embed], files: [logoFile], allowedMentions: silent });
          store.update(guild.id, data => { data.dashboard[date].logo = true; });
        } else {
          await channel.messages.edit(current.messageId, { embeds: [embed], allowedMentions: silent });
        }
        return true;
      } catch (error) {
        if (error.code !== 10008) console.error('แก้ไขรายงานเดิมไม่ได้ ลองสร้างใหม่:', error.message);
      }
    }
    if (hasLogo) embed.setThumbnail('attachment://IMMORTAL-2.png');
    const message = await channel.send({ embeds: [embed], ...(hasLogo ? { files: [logoFile] } : {}), allowedMentions: silent });
    store.update(guild.id, data => {
      data.dashboard ||= {};
      data.dashboard[date] = { messageId: message.id, channelId: channel.id, logo: hasLogo };
    });
    return true;
  });
  dashboardQueues.set(key, task);
  try { return await task; }
  finally { if (dashboardQueues.get(key) === task) dashboardQueues.delete(key); }
}

// เมื่อถึงวันลาที่ลงล่วงหน้า รายงานสดของวันใหม่ต้องแสดงสถานะนั้น
// แม้วันนั้นยังไม่มีใครกดปุ่ม; หากบอตเพิ่งออนไลน์หลัง 18:00 จะสร้างย้อนหลังเฉพาะวันนี้
async function ensureDailyDashboard() {
  if (!clock.isAttendanceOpen()) return;
  const date = store.today();
  for (const guildId of store.getGuildIds()) {
    const g = store.getGuild(guildId);
    if (!g?.config || g.dashboard?.[date]) continue;
    const guild = client.guilds.cache.get(guildId);
    if (!guild) continue;
    try { await refreshDashboard(guild, date); }
    catch (error) { console.error('สร้างรายงานสดประจำวันไม่ได้:', error.message); }
  }
}

function reasonModal(status, startDate = null, endDate = null) {
  const modal = new ModalBuilder().setCustomId(`attendance:reason:${status}`)
    .setTitle(status === 'late' ? 'แจ้งมาสาย' : 'แจ้งลา');
  const reason = new TextInputBuilder().setCustomId('reason')
    .setLabel(status === 'late' ? 'เหตุผลที่มาสาย' : 'เหตุผลที่ลา')
    .setPlaceholder(status === 'late' ? 'เช่น รถเสียระหว่างเดินทาง' : 'เช่น มีธุระส่วนตัว')
    .setStyle(TextInputStyle.Paragraph).setMinLength(3).setMaxLength(250)
    .setRequired(true);
  if (status === 'leave') {
    const today = store.today();
    const start = new TextInputBuilder().setCustomId('leaveStart')
      .setLabel('วันแรกของการลา (วว/ดด/ปปปป หรือ YYYY-MM-DD)')
      .setStyle(TextInputStyle.Short).setRequired(true).setValue(startDate || today).setMaxLength(10);
    const end = new TextInputBuilder().setCustomId('leaveEnd')
      .setLabel('วันสุดท้าย (ลา 1 วันให้ใช้วันเดิม)')
      .setStyle(TextInputStyle.Short).setRequired(true).setValue(endDate || startDate || today).setMaxLength(10);
    modal.addComponents(new ActionRowBuilder().addComponents(start), new ActionRowBuilder().addComponents(end));
  }
  modal.addComponents(new ActionRowBuilder().addComponents(reason));
  return modal;
}

async function beginAttendance(i, status, reason = '', startDate = null, endDate = null) {
  const g = configOf(i);
  if (!clock.isStatusOpen(status)) throw new Error('สถานะมาเปิดให้เช็กตั้งแต่ 18:00–23:59 น. (เวลาไทย)');
  if (!onlyTeam(i, g)) throw new Error('คุณยังไม่มีบทบาทสมาชิกทีมที่กำหนด');
  if (!Object.hasOwn(attendanceNames, status)) throw new Error('สถานะเช็กชื่อไม่ถูกต้อง');
  if (status !== 'leave' && (startDate || endDate)) throw new Error('ช่วงวันที่ใช้ได้เฉพาะการลา');
  // สำหรับมาสาย/ลาให้กรอกเหตุผลก่อนเสมอ; การกดปุ่มยังไม่บันทึกข้อมูล
  if (status !== 'present' && !reason.trim()) return await i.showModal(reasonModal(status, startDate, endDate));
  const date = store.today();
  const previous = g.attendance[date]?.[i.user.id] || null;
  const dates = status === 'leave' ? history.leaveDates(startDate, endDate, date) : [date];
  const previousByDate = Object.fromEntries(dates.map(day => [day, g.attendance?.[day]?.[i.user.id] || null]));
  const prepared = attendanceFlow.prepare({
    guildId: i.guildId, userId: i.user.id, status, reason, date, previous,
    dates, previousByDate
  });
  if (prepared.duplicate) {
    return await i.reply(ep(`คุณบันทึกเป็น ${attendanceNames[status]} สำหรับวันที่เลือกไปแล้ว ไม่บันทึกซ้ำ`));
  }
  const { record } = prepared;
  const overwritten = dates.filter(day => previousByDate[day]);
  const isEdit = overwritten.length > 0;
  const content = `📋 **ตรวจสอบก่อนยืนยัน** (ยังไม่ได้บันทึก)\n` +
    `วันที่: ${dates.length > 1 ? `${history.thaiDate(dates[0])}–${history.thaiDate(dates[dates.length - 1])} (${dates.length} วัน)` : history.thaiDate(dates[0])}\nบัญชี: <@${i.user.id}>\n` +
    (isEdit ? `วันซึ่งจะถูกแทนที่: ${overwritten.map(history.thaiDate).join(', ')}\n` : '') +
    `สถานะใหม่: ${attendanceNames[status]}\n` +
    (record.reason ? `เหตุผล: ${sanitize(record.reason)}\n` : '') +
    `\n${isEdit ? '⚠️ คุณกำลังแก้ไขการเช็กชื่อเดิม\n' : ''}` +
    `กด **ยืนยัน** เพื่อบันทึก หรือ **ยกเลิก** หากกดผิด (หมดอายุใน 5 นาที)`;
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`attendance:confirm:${record.id}`)
      .setLabel(isEdit ? 'ยืนยันการแก้ไข' : 'ยืนยันเช็กชื่อ').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`attendance:cancel:${record.id}`)
      .setLabel('ยกเลิก').setStyle(ButtonStyle.Danger)
  );
  return await i.reply({ ...ep(content), components: [row] });
}

async function confirmAttendance(i, id) {
  const g = configOf(i);
  if (!onlyTeam(i, g)) throw new Error('คุณยังไม่มีบทบาทสมาชิกทีมที่กำหนด');
  const pending = attendanceFlow.take(id, i.guildId, i.user.id);
  await i.deferUpdate();
  if (!clock.isStatusOpen(pending.status)) throw new Error('สถานะมาเปิดให้เช็กตั้งแต่ 18:00 น.');
  if (pending.date !== store.today()) {
    throw new Error('ข้ามวันแล้ว กรุณาเริ่มเช็กชื่อของวันใหม่');
  }
  // หากข้อมูลเปลี่ยนระหว่างหน้าพรีวิวและกดยืนยัน จะไม่ทับข้อมูลใหม่
  const range = pending.dates || [pending.date];
  const multi = pending.status === 'leave' && (range.length !== 1 || range[0] !== pending.date);
  const result = multi
    ? store.attendanceRange(i.guildId, range, i.user.id, pending.reason, pending.previousSnapshots)
    : store.attendance(i.guildId, pending.date, i.user.id,
      pending.status, pending.reason, pending.previousSnapshot);
  if (result.unchanged) {
    return await i.editReply({ content: 'ข้อมูลนี้ได้รับการบันทึกไว้แล้ว ไม่ส่งประกาศซ้ำ', components: [] });
  }
  postTimeWebhook(attendanceActionWebhookPayload({
    guildId: i.guildId, userId: i.user.id, status: pending.status, reason: pending.reason,
    dates: range, actorId: i.user.id, isEdit: Boolean(!multi && result.previous)
  }), 'time attendance').catch(e => console.error('ส่ง Time_log เช็กชื่อไม่สำเร็จ:', e.message));
  // ข้อมูลไม่ออกไป Google/ระบบภายนอก: บันทึก JSON ในเครื่อง + อัปเดตข้อความรายงานใน Discord
  let dashboardUpdated = false;
  try { dashboardUpdated = range.includes(pending.date) ? await refreshDashboard(i.guild, pending.date) : true; }
  catch (error) { console.error('อัปเดตรายงานเช็กชื่อไม่สำเร็จ:', error.message); }
  if (!multi && result.previous) {
    // เก็บร่องรอยการแก้ไขสถานะไว้ใน Discord ด้วย (ข้อความรายงานสดแสดงเฉพาะสถานะล่าสุด)
    await announce(i.guild, g.config.attendanceChannelId,
      `🔄 แก้ไขเช็กชื่อ ${pending.date}: <@${i.user.id}> เปลี่ยนจาก ${attendanceNames[result.previous.status]} เป็น ${attendanceNames[pending.status]}` +
      (pending.reason ? `\nเหตุผลใหม่: ${sanitize(pending.reason)}` : ''));
  }
  return await i.editReply({
    content: `✅ ${multi ? 'บันทึกช่วงวันลา' : (result.previous ? 'แก้ไข' : 'บันทึก')}แล้ว: ${attendanceNames[pending.status]} (${range.length > 1 ? `${history.thaiDate(range[0])}–${history.thaiDate(range[range.length - 1])} รวม ${range.length} วัน` : history.thaiDate(range[0])})` +
      (pending.reason ? `\nเหตุผล: ${sanitize(pending.reason)}` : '') +
      (dashboardUpdated ? '\n📋 ข้อมูลเก็บในประวัติแล้ว รายงานวันนี้จะอัปเดตเมื่อเกี่ยวข้อง' : '\n⚠️ บันทึกแล้ว แต่ยังอัปเดตรายงานไม่ได้ กรุณาแจ้งผู้ดูแล'),
    components: [], allowedMentions: silent
  });
}

// ระบบส่งของ: UI ปุ่ม + ยศผู้จัดการส่งของ + ตัวเลือกนำเข้าตู้หลังรับของ
const deliveryQueue = new Map();
function memberHasRole(member, roleIds = []) {
  if (!member || !Array.isArray(roleIds) || !roleIds.length) return false;
  return roleIds.some(id => member.roles?.cache?.has(id) || member.roles?.includes?.(id));
}
function deliveryManager(i, g) {
  return i.guild?.ownerId === i.user.id || i.memberPermissions?.has(PermissionFlagsBits.ManageGuild) || memberHasRole(i.member, g?.deliveryManagerRoleIds || []);
}
function requireDeliveryManager(i, g) {
  if (!deliveryManager(i, g)) throw new Error('คุณไม่มียศสำหรับแก้ไข/ยืนยันระบบส่งของ');
}
function lockerManager(i, g) {
  return i.guild?.ownerId === i.user.id || i.memberPermissions?.has(PermissionFlagsBits.ManageGuild) || memberHasRole(i.member, g?.lockerManagerRoleIds || []);
}
function requireLockerManager(i, g) {
  if (!lockerManager(i, g)) throw new Error('คุณไม่มียศสำหรับแก้ไขตู้แก๊ง');
}
function lockerMoneyBreakdown(g) {
  const result = { green: 0, red: 0 };
  for (const x of (g?.locker || [])) {
    const name = displayItemName(x.name);
    const qty = Number(x.quantity || 0);
    if (!Number.isFinite(qty)) continue;
    if (name === 'เงินเขียว') result.green += qty;
    else if (name === 'เงินแดง') result.red += qty;
  }
  return result;
}
function lockerMoneyText(g) {
  const money = lockerMoneyBreakdown(g);
  return `🟩เงินเขียว ${money.green.toLocaleString('en-US')} บาท\n🟥เงินแดง — **${money.red.toLocaleString('en-US')}** บาท`;
}
function lockerSummaryText(g) {
  const summary = store.lockerSummary(g);
  const rows = summary.rows;
  const lines = rows.length ? rows.map((x, idx) => `${idx + 1}. ${itemLabel(x.name)} — ${Number(x.quantity || 0).toLocaleString('en-US')} ${sanitize(x.unit || 'ชิ้น')}`) : ['ยังไม่มีของในตู้'];
  return `📦 **[IMT] IMMORTAL — ตู้แก๊ง**\n\n` +
    `📋 จำนวนรายการทั้งหมด: **${summary.totalItems.toLocaleString('en-US')} รายการ**\n` +
    `${lockerMoneyText(g)}\n\n` + lines.join('\n');
}
function lockerEmbed(g) {
  const summary = store.lockerSummary(g);
  const list = summary.rows.length ? summary.rows.map((x, idx) => `${idx + 1}. ${itemLabel(x.name)} — **${Number(x.quantity || 0).toLocaleString('en-US')}** ${sanitize(x.unit || 'ชิ้น')}`).join('\n') : 'ยังไม่มีของในตู้';
  return new EmbedBuilder()
    .setTitle('📦 [IMT] IMMORTAL • Dashboard ตู้แก๊ง')
    .setDescription(`📋 จำนวนรายการทั้งหมด: **${summary.totalItems.toLocaleString('en-US')} รายการ**\n${lockerMoneyText(g)}`)
    .addFields({ name: 'ของในตู้', value: list.slice(0, 1000), inline: false })
    .setColor(0x2F3136)
    .setFooter({ text: 'ตู้แก๊งแยกจากระบบส่งของ • สมาชิกดูได้ ผู้จัดการตู้เท่านั้นที่แก้ไขได้' })
    .setTimestamp(new Date());
}
function lockerButtons() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('locker:check').setLabel('📋 เช็คของ').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('locker:add').setLabel('➕ เพิ่มของ').setStyle(ButtonStyle.Success)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('locker:remove').setLabel('➖ ลบของ').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('locker:edit').setLabel('✏️ แก้ไขของ').setStyle(ButtonStyle.Primary)
    )
  ];
}
function lockerAddModal() {
  return new ModalBuilder().setTitle('➕ เพิ่มของเข้าตู้แก๊ง').setCustomId('locker:add:modal')
    .addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('name').setLabel('ชื่อของ').setStyle(TextInputStyle.Short).setPlaceholder('red money = เงินแดง, money = เงินเขียว').setMaxLength(80).setRequired(true)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('quantity').setLabel('จำนวนที่เพิ่ม').setStyle(TextInputStyle.Short).setPlaceholder('เช่น 5').setRequired(true)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('unit').setLabel('หน่วย').setStyle(TextInputStyle.Short).setPlaceholder('ชิ้น / บาท').setValue('ชิ้น').setMaxLength(20).setRequired(true))
    );
}
function lockerRemoveModal() {
  return new ModalBuilder().setTitle('➖ ลบของจากตู้แก๊ง').setCustomId('locker:remove:modal')
    .addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('name').setLabel('ชื่อของ').setStyle(TextInputStyle.Short).setMaxLength(80).setRequired(true)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('quantity').setLabel('จำนวนที่ลบออก').setStyle(TextInputStyle.Short).setPlaceholder('เช่น 2').setRequired(true))
    );
}
function lockerEditModal() {
  return new ModalBuilder().setTitle('✏️ แก้ไขของในตู้แก๊ง').setCustomId('locker:edit:modal')
    .addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('name').setLabel('ชื่อของเดิม').setStyle(TextInputStyle.Short).setMaxLength(80).setRequired(true)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('newname').setLabel('ชื่อใหม่ (เว้นว่าง = ใช้ชื่อเดิม)').setStyle(TextInputStyle.Short).setMaxLength(80).setRequired(false)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('quantity').setLabel('จำนวนใหม่').setStyle(TextInputStyle.Short).setPlaceholder('เช่น 10').setRequired(true)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('unit').setLabel('หน่วยใหม่ (เว้นว่าง = ใช้หน่วยเดิม)').setStyle(TextInputStyle.Short).setMaxLength(20).setRequired(false))
    );
}
function parsePositiveInt(raw, max = 1000000000000) {
  const value = String(raw || '').trim();
  if (!/^\d{1,13}$/.test(value)) throw new Error('กรุณาใส่จำนวนเป็นเลขจำนวนเต็ม');
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new Error(`จำนวนต้องอยู่ระหว่าง 1 ถึง ${max.toLocaleString('en-US')}`);
  return n;
}
function parseNonNegativeInt(raw, max = 1000000000000) {
  const value = String(raw || '').trim();
  if (!/^\d{1,13}$/.test(value)) throw new Error('กรุณาใส่จำนวนเป็นเลขจำนวนเต็ม');
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0 || n > max) throw new Error(`จำนวนต้องอยู่ระหว่าง 0 ถึง ${max.toLocaleString('en-US')}`);
  return n;
}
function unitOf(x) { return sanitize(x.unit || 'ชิ้น'); }
function receiptText(x) {
  const symbol = { pending: '⏳ รอตรวจ', approved: '✅ รับแล้ว', rejected: '❌ ไม่รับ' }[x.status] || 'รอตรวจ';
  const action = x.status === 'approved'
    ? x.lockerAction === 'imported' ? '\nหลังรับของ: 📥 นำเข้าตู้แล้ว'
      : x.lockerAction === 'skipped' ? '\nหลังรับของ: ไม่ดำเนินการใดๆ'
      : '\nหลังรับของ: รอผู้ดูแลเลือก **นำเข้าตู้** หรือ **ไม่ดำเนินการใดๆ**'
    : '';
  return `**${x.seq}.** <@${x.userId}> — [ ${itemLabel(x.name)} ] — [ ${x.quantity.toLocaleString('en-US')} ${unitOf(x)} ]\n` +
    `สถานะ: **${symbol}**` + (x.reviewedBy ? ` • ผู้ยืนยัน: <@${x.reviewedBy}>` : '') + action;
}
function deliveryReviewComponents(entry) {
  if (entry.status === 'pending') {
    return [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`delivery:approve:${entry.id}`).setLabel('✅ ยืนยันรับของ').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`delivery:reject:${entry.id}`).setLabel('❌ ไม่รับของ').setStyle(ButtonStyle.Danger)
    )];
  }
  if (entry.status === 'rejected') {
    return [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`delivery:approve:${entry.id}`).setLabel('✅ แก้เป็นรับแล้ว').setStyle(ButtonStyle.Success)
    )];
  }
  if (entry.status === 'approved' && !entry.lockerAction) {
    return [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`delivery:locker-import:${entry.id}`).setLabel('📥 นำเข้าตู้').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`delivery:locker-skip:${entry.id}`).setLabel('ไม่ดำเนินการใดๆ').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`delivery:reject:${entry.id}`).setLabel('❌ แก้เป็นไม่รับ').setStyle(ButtonStyle.Danger)
    )];
  }
  return [];
}
function deliveryRequiredText(g) {
  const rows = g.deliveryItems || [];
  if (!rows.length) return '📋 **ของที่ต้องส่ง**\nยังไม่มีการกำหนดรายการ ให้ผู้มียศใช้ปุ่ม **สร้าง/แก้ไขของที่ต้องส่ง** หรือ `/delivery item add`';
  return '📋 **ของที่ต้องส่ง**\n' + rows.map((x, idx) =>
    `${idx + 1}. ${itemLabel(x.name)} — ${Number(x.requiredQty || 0).toLocaleString('en-US')} ${sanitize(x.unit || 'ชิ้น')}`).join('\n').slice(0, 1900);
}
function deliveryStatusQuickComponents() {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('delivery:fix:rejected-approved').setLabel('✅ ไม่รับ → รับแล้ว').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('delivery:fix:approved-rejected').setLabel('❌ รับแล้ว → ไม่รับ').setStyle(ButtonStyle.Danger)
  )];
}

function deliveryRequiredComponents(g) {
  // Discord แสดงปุ่มได้สูงสุด 5 แถว/ข้อความ และ 5 ปุ่ม/แถว
  // จัดแบบ 1 รายการ = ปุ่มส่ง + ปุ่มยกเลิกของผู้ดูแล เพื่อให้ปุ่มอยู่ข้างกัน
  // เว้นแถวสุดท้ายให้ปุ่ม Reset สำหรับผู้มียศ
  const rows = (g.deliveryItems || []).slice(0, 4);
  const components = [];
  for (const item of rows) {
    const qty = Number(item.requiredQty || 0).toLocaleString('en-US');
    const unit = sanitize(item.unit || 'ชิ้น');
    const name = itemLabel(item.name);
    components.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`delivery:reqsend:${item.id}`)
        .setLabel((`📦 ส่ง ${name} ${qty} ${unit}`).slice(0, 80))
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`delivery:reqcancel:${item.id}`)
        .setLabel('🗑 ยกเลิก')
        .setStyle(ButtonStyle.Danger)
    ));
  }
  // แถวด้านล่างของรายงานสด: เอาปุ่มที่ซ้ำกับ Panel หลักออก
  // เหลือเฉพาะปุ่ม Reset ที่เกี่ยวกับรายงานนี้โดยตรง
  components.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('delivery:reset-rows').setLabel('🔄 Reset รายชื่อ').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('delivery:reset-items').setLabel('🧹 Reset ของ').setStyle(ButtonStyle.Danger)
  ));
  return components;
}
function deliveryLogMeta(type) {
  return {
    submitted: ['📦 DELIVERY LOG — ส่งของใหม่', 0xADB5BD],
    approved: ['✅ DELIVERY LOG — รับของแล้ว', 0x2ECC71],
    rejected: ['❌ DELIVERY LOG — ไม่รับของ', 0xE74C3C],
    locker_imported: ['📥 VAULT LOG — นำเข้าตู้แก๊ง', 0x3498DB],
    locker_skipped: ['➖ VAULT LOG — ไม่ดำเนินการใดๆ', 0x95A5A6],
    item_upsert: ['🛠 DELIVERY LOG — สร้าง/แก้ไขของที่ต้องส่ง', 0x5865F2],
    item_remove: ['🗑 DELIVERY LOG — ลบของที่ต้องส่ง', 0xE67E22],
    role_add: ['👑 DELIVERY LOG — เพิ่มยศผู้จัดการส่งของ', 0x9B59B6],
    role_remove: ['👑 DELIVERY LOG — ลบยศผู้จัดการส่งของ', 0xF39C12],
    reset_rows: ['🔄 DELIVERY LOG — Reset รายชื่อส่งของ', 0x95A5A6],
    reset_items: ['🧹 DELIVERY LOG — Reset ของที่ต้องส่ง', 0xE67E22],
    locker_add: ['📦 LOCKER LOG — เพิ่มของเข้าตู้', 0x2ECC71],
    locker_edit: ['📦 LOCKER LOG — แก้ไขตู้แก๊ง', 0x5865F2],
    locker_remove: ['📦 LOCKER LOG — ลบของจากตู้', 0xE74C3C],
    locker_role_add: ['👑 LOCKER LOG — เพิ่มยศผู้จัดการตู้', 0x9B59B6],
    locker_role_remove: ['👑 LOCKER LOG — ลบยศผู้จัดการตู้', 0xF39C12]
  }[type] || ['📜 DELIVERY LOG', 0xADB5BD];
}
function deliveryLogActionText(type) {
  return {
    submitted: 'ส่งของใหม่', approved: 'รับของแล้ว', rejected: 'ไม่รับของ',
    locker_imported: 'นำเข้าตู้', locker_skipped: 'ไม่ดำเนินการใดๆ',
    item_upsert: 'สร้าง/แก้ไขของที่ต้องส่ง', item_remove: 'ลบของที่ต้องส่ง',
    role_add: 'เพิ่มยศผู้จัดการส่งของ', role_remove: 'ลบยศผู้จัดการส่งของ',
    reset_rows: 'Reset รายชื่อส่งของ', reset_items: 'Reset ของที่ต้องส่ง',
    locker_add: 'เพิ่มของเข้าตู้', locker_edit: 'แก้ไขตู้แก๊ง', locker_remove: 'ลบของจากตู้',
    locker_role_add: 'เพิ่มยศผู้จัดการตู้', locker_role_remove: 'ลบยศผู้จัดการตู้'
  }[type] || type;
}
function deliveryLogLine(x, idx = null) {
  const who = x.userId ? `<@${x.userId}>` : '-';
  const actor = x.actorId ? `<@${x.actorId}>` : (x.reviewerId ? `<@${x.reviewerId}>` : '-');
  const qty = Number.isSafeInteger(x.quantity) ? `${x.quantity.toLocaleString('en-US')} ${sanitize(x.unit || '')}`.trim() : '-';
  const item = itemLabel(x.itemName || '-');
  const locker = x.lockerAction === 'imported'
    ? ` • ตู้ ${Number(x.beforeQty ?? 0).toLocaleString('en-US')} → ${Number(x.afterQty ?? 0).toLocaleString('en-US')}`
    : x.lockerAction === 'skipped' ? ' • ไม่เปลี่ยนตู้' : '';
  return `${idx === null ? '' : idx + '. '}**${deliveryLogActionText(x.type)}** — ${item} ${qty}\nผู้ส่ง: ${who} • ผู้ดำเนินการ: ${actor}${locker}\nรหัส: ${x.id}${x.deliveryId ? ` • รายการ: ${x.deliveryId}` : ''}`;
}
function deliveryHistoryText(g, filters = {}) {
  const rows = store.deliveryHistory(guildIdFromGuild(g), filters);
  if (!rows.length) return '📜 **ประวัติส่งของ**\nยังไม่มีประวัติที่ตรงกับเงื่อนไข';
  return '📜 **ประวัติส่งของล่าสุด**\n' + rows.map((x, idx) => deliveryLogLine(x, idx + 1)).join('\n\n').slice(0, 1900);
}
function guildIdFromGuild(g) {
  const db = store.load();
  for (const [id, value] of Object.entries(db.guilds || {})) if (value === g) return id;
  // getGuild() คืน object คนละ reference จาก load() ใหม่ จึงใช้ fallback จาก config ไม่ได้; caller ควรใช้ deliveryHistoryTextForGuild
  return null;
}
function deliveryHistoryTextForGuild(guildId, filters = {}) {
  const rows = store.deliveryHistory(guildId, filters);
  if (!rows.length) return '📜 **ประวัติส่งของ**\nยังไม่มีประวัติที่ตรงกับเงื่อนไข';
  return '📜 **ประวัติส่งของล่าสุด**\n' + rows.map((x, idx) => deliveryLogLine(x, idx + 1)).join('\n\n').slice(0, 1900);
}
function isVaultLogType(type) {
  return type === 'locker_imported' || type === 'locker_skipped' || String(type || '').startsWith('locker_');
}
function deliveryLogWebhookPayload(log) {
  const [title, color] = deliveryLogMeta(log.type);
  const isVault = isVaultLogType(log.type);
  const fields = [
    log.userId ? { name: 'ผู้ส่ง', value: `<@${log.userId}>`, inline: true } : null,
    log.actorId ? { name: 'ผู้ดำเนินการ', value: `<@${log.actorId}>`, inline: true } : null,
    log.reviewerId && !log.actorId ? { name: 'ผู้ตรวจรับ', value: `<@${log.reviewerId}>`, inline: true } : null,
    log.itemName ? { name: 'รายการ', value: itemLabel(log.itemName), inline: true } : null,
    Number.isSafeInteger(log.quantity) ? { name: 'จำนวน', value: `${log.quantity.toLocaleString('en-US')} ${sanitize(log.unit || '')}`.trim(), inline: true } : null,
    log.status ? { name: 'สถานะ', value: sanitize(log.status), inline: true } : null,
    log.lockerAction ? { name: 'ผลลัพธ์ตู้แก๊ง', value: log.lockerAction === 'imported' ? `นำเข้าตู้ (${Number(log.beforeQty ?? 0).toLocaleString('en-US')} → ${Number(log.afterQty ?? 0).toLocaleString('en-US')})` : 'ไม่ดำเนินการใดๆ', inline: false } : null,
    log.note ? { name: 'หมายเหตุ', value: sanitize(log.note), inline: false } : null,
    { name: 'รหัสประวัติ', value: log.id, inline: true },
    log.deliveryId ? { name: 'รหัสรายการ', value: log.deliveryId, inline: true } : null
  ].filter(Boolean);
  return {
    username: isVault ? 'IMT Vault Log' : 'IMT Delivery Log',
    allowed_mentions: { parse: [] },
    embeds: [{ title, color, fields, footer: { text: `[IMT] IMMORTAL • ${isVault ? 'Vault System' : 'Delivery System'} • เวลาไทย` }, timestamp: log.at }]
  };
}
async function postDeliveryWebhook(log) {
  const isVault = isVaultLogType(log.type);
  const targetUrl = isVault ? vaultLogWebhookUrl : deliveryLogWebhookUrl;
  if (!targetUrl) return false;
  const response = await fetch(targetUrl, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(deliveryLogWebhookPayload(log))
  });
  if (!response.ok) throw new Error(`Webhook log ${isVault ? 'ตู้แก๊ง' : 'ส่งของ'} ล้มเหลว: ${response.status}`);
  return true;
}
async function recordDeliveryLog(guildId, type, data = {}) {
  const log = store.deliveryLogAdd(guildId, type, data);
  postDeliveryWebhook(log).catch(e => console.error(`ส่ง ${isVaultLogType(type) ? 'vault' : 'delivery'} webhook log ไม่สำเร็จ:`, e.message));
  return log;
}

async function postTimeWebhook(payload, label = 'time') {
  if (!timeLogWebhookUrl) return false;
  const response = await fetch(timeLogWebhookUrl, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!response.ok) throw new Error(`${label} webhook ล้มเหลว: ${response.status}`);
  return true;
}
async function postHomeWebhook(payload, label = 'home') {
  if (!homeLogWebhookUrl) return false;
  const response = await fetch(homeLogWebhookUrl, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!response.ok) throw new Error(`${label} webhook ล้มเหลว: ${response.status}`);
  return true;
}
function attendanceActionWebhookPayload({ guildId, userId, status, reason = '', dates = [], actorId = null, isEdit = false }) {
  const rangeText = dates.length > 1 ? `${dates[0]} → ${dates[dates.length - 1]} (${dates.length} วัน)` : (dates[0] || store.today());
  return {
    username: 'IMT Time Log',
    allowed_mentions: { parse: [] },
    embeds: [{
      title: `${isEdit ? '🔄 แก้ไขเช็กชื่อ' : '📋 บันทึกเช็กชื่อ'} — ${attendanceStatusLabel(status)}`,
      color: attendanceWebhookColor(status),
      fields: [
        { name: 'สมาชิก', value: `<@${userId}>`, inline: true },
        actorId ? { name: 'ผู้ดำเนินการ', value: `<@${actorId}>`, inline: true } : null,
        { name: 'สถานะ', value: attendanceStatusLabel(status), inline: true },
        { name: 'วันที่', value: rangeText, inline: false },
        reason ? { name: 'เหตุผล', value: sanitize(reason), inline: false } : null,
        { name: 'Guild', value: guildId, inline: true }
      ].filter(Boolean),
      footer: { text: timeFooterText('Time Log') },
      timestamp: new Date().toISOString()
    }]
  };
}

function parseDiscordUserId(value) {
  const text = String(value || '').trim();
  const match = text.match(/^(?:<@!?)?(\d{5,25})>?$/) || text.match(/(\d{5,25})/);
  if (!match) throw new Error('กรุณาใส่ mention สมาชิก หรือ Discord ID ให้ถูกต้อง');
  return match[1];
}
function attendanceAdminEditModal(status) {
  const modal = new ModalBuilder().setCustomId(`attendance:adminedit:${status}`)
    .setTitle(`ผู้ดูแลแก้ไขเป็น ${attendanceStatusLabel(status).replace(/^[^ ]+\s*/, '')}`.slice(0, 45));
  const member = new TextInputBuilder().setCustomId('member')
    .setLabel('สมาชิก (mention หรือ Discord ID)')
    .setPlaceholder('@สมาชิก หรือ 123456789012345678')
    .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(80);
  const date = new TextInputBuilder().setCustomId('date')
    .setLabel('วันที่ (YYYY-MM-DD)')
    .setStyle(TextInputStyle.Short).setRequired(true).setValue(store.today()).setMaxLength(10);
  const time = new TextInputBuilder().setCustomId('time')
    .setLabel('เวลา (HH:MM เวลาไทย)')
    .setPlaceholder('เช่น 18:30 หรือ 20:15')
    .setStyle(TextInputStyle.Short).setRequired(true).setValue(store.timeBangkok()).setMaxLength(5);
  const reason = new TextInputBuilder().setCustomId('reason')
    .setLabel(status === 'present' ? 'เหตุผลการแก้ไข (ใส่หรือไม่ใส่ก็ได้)' : 'เหตุผลการแก้ไข')
    .setPlaceholder(status === 'present' ? 'เช่น มาจริงแล้ว ยกเลิกลาวันนี้' : 'เช่น เปลี่ยนเป็นลา เพราะมีเหตุจำเป็น')
    .setStyle(TextInputStyle.Paragraph).setRequired(status !== 'present').setMaxLength(250);
  modal.addComponents(new ActionRowBuilder().addComponents(member),
    new ActionRowBuilder().addComponents(date), new ActionRowBuilder().addComponents(time),
    new ActionRowBuilder().addComponents(reason));
  return modal;
}

function attendanceEditHistoryText(g, limit = 10) {
  const rows = (g.attendanceEditHistory || []).slice(-limit).reverse();
  if (!rows.length) return '📜 **ประวัติแก้ไขเช็กชื่อ**\nยังไม่มีประวัติการแก้ไขโดยผู้ดูแล';
  const status = v => v ? attendanceStatusLabel(v) : 'ลบสถานะ';
  return '📜 **ประวัติแก้ไขเช็กชื่อล่าสุด**\n' + rows.map((x, idx) =>
    `${idx + 1}. ${x.date} • <@${x.userId}>\n` +
    `จาก: **${status(x.from)}** → เป็น: **${status(x.to)}**\n` +
    `ผู้แก้ไข: <@${x.actorId || '0'}>${x.reason ? `\nเหตุผล: ${sanitize(x.reason)}` : ''}`
  ).join('\n\n').slice(0, 1900);
}
function attendanceAdminEditWebhookPayload({ guildId, targetId, actorId, date, time, previous, status, reason, log }) {
  return {
    username: 'IMT Time Log',
    allowed_mentions: { parse: [] },
    embeds: [{
      title: '🛠 TIME LOG — ผู้ดูแลแก้ไขเช็กชื่อ',
      color: attendanceWebhookColor(status),
      fields: [
        { name: 'ผู้ดูแล', value: `<@${actorId}>`, inline: true },
        { name: 'สมาชิก', value: `<@${targetId}>`, inline: true },
        { name: 'วันที่', value: date, inline: true },
        { name: 'เวลาเช็กชื่อ', value: time || log?.time || '-', inline: true },
        { name: 'สถานะเดิม', value: previous ? attendanceStatusLabel(previous.status) : 'ไม่มีข้อมูลเดิม', inline: true },
        { name: 'สถานะใหม่', value: attendanceStatusLabel(status), inline: true },
        previous?.reason ? { name: 'เหตุผลเดิม', value: sanitize(previous.reason), inline: false } : null,
        reason ? { name: 'เหตุผลแก้ไข', value: sanitize(reason), inline: false } : null,
        { name: 'รหัสแก้ไข', value: log?.id || '-', inline: true },
        { name: 'Guild', value: guildId, inline: true }
      ].filter(Boolean),
      footer: { text: timeFooterText('Admin Edit') },
      timestamp: new Date().toISOString()
    }]
  };
}


function houseStatusLabel(status) {
  return ({ present: '✅ มา', late: '🕒 มาสาย', leave: '📝 ลา' })[status] || '⬜ ยังไม่เช็ก';
}
function houseRecordLine(record) {
  if (!record) return '⬜ ยังไม่เช็ก';
  const time = record.time || (record.at ? String(record.at).slice(11, 16) : '');
  const reason = record.reason ? ` • ${sanitize(record.reason).slice(0, 80)}` : '';
  const actor = record.actorId ? ` • โดย <@${record.actorId}>` : '';
  return `${houseStatusLabel(record.status)}${time ? ` • เวลา ${time}` : ''}${reason}${actor}`;
}
function canManageHouse(i, house) {
  return manager(i) || house?.leaderId === i.user.id;
}
function housesForUser(guildId, userId, isManager = false) {
  const houses = store.houseList(guildId);
  return isManager ? houses : houses.filter(h => h.leaderId === userId);
}
async function houseMemberLabel(guild, userId) {
  const m = await guild.members.fetch(userId).catch(() => null);
  return (m?.displayName || m?.user?.username || userId).slice(0, 90);
}
const HOUSE_SELECT_PAGE_SIZE = 25;
const HOUSE_DIRECTORY_PAGE_SIZE = 20;

async function houseMemberSelectPayload(i, house, page = 0) {
  if (!house?.memberIds?.length) return { ...ep(`บ้าน **${sanitize(house?.name)}** ยังไม่มีลูกบ้าน`), components: [] };
  const members = house.memberIds || [];
  const totalPages = Math.max(1, Math.ceil(members.length / HOUSE_SELECT_PAGE_SIZE));
  page = Math.max(0, Math.min(Number(page) || 0, totalPages - 1));
  const start = page * HOUSE_SELECT_PAGE_SIZE;
  const pageMembers = members.slice(start, start + HOUSE_SELECT_PAGE_SIZE);
  const options = [];
  for (const userId of pageMembers) {
    options.push({ label: await houseMemberLabel(i.guild, userId), value: userId, description: `Discord ID: ${userId}`.slice(0, 100) });
  }
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`house:member:${house.id}:${page}`)
    .setPlaceholder(`เลือกสมาชิกใน ${house.name} • หน้า ${page + 1}/${totalPages}`)
    .addOptions(options);
  const components = [new ActionRowBuilder().addComponents(menu)];
  if (totalPages > 1) {
    components.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`house:members:${house.id}:${Math.max(0, page - 1)}`).setLabel('◀️ ก่อนหน้า').setStyle(ButtonStyle.Secondary).setDisabled(page <= 0),
      new ButtonBuilder().setCustomId(`house:members:${house.id}:${Math.min(totalPages - 1, page + 1)}`).setLabel('ถัดไป ▶️').setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages - 1)
    ));
  }
  return { ...ep(`🏠 **${sanitize(house.name)}**\nเลือกสมาชิกที่ต้องการเช็กชื่อแทน\nหน้า ${page + 1}/${totalPages} • แสดง ${start + 1}-${start + pageMembers.length} จาก ${members.length} คน`), components };
}
function housePanelComponents(houseId = null) {
  const suffix = houseId ? `:${houseId}` : '';
  const rows = [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`house:open${suffix}`).setLabel('🏠 เช็กชื่อลูกบ้าน').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(houseId ? `house:list-open:${houseId}:0` : 'house:list-open:all:0').setLabel('📋 ดูรายชื่อ').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`house:summary${suffix}`).setLabel('📊 สรุปบ้านวันนี้').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`house:history${suffix}`).setLabel('📜 ประวัติเช็กชื่อบ้าน').setStyle(ButtonStyle.Secondary)
  )];
  if (houseId) {
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`house:member-add-open:${houseId}`).setLabel('➕ เพิ่มสมาชิก').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`house:member-remove-open:${houseId}`).setLabel('➖ ลบสมาชิก').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`house:reset:${houseId}`).setLabel('🔄 Reset วันนี้').setStyle(ButtonStyle.Secondary)
    ));
  }
  return rows;
}
function houseMemberIdModal(action, houseId, houseName = '') {
  const isAdd = action === 'add';
  const title = `${isAdd ? 'เพิ่ม' : 'ลบ'}สมาชิกบ้าน${houseName ? ' ' + houseName : ''}`.slice(0, 45);
  const modal = new ModalBuilder().setCustomId(`house:member-${action}-modal:${houseId}`).setTitle(title);
  const member = new TextInputBuilder()
    .setCustomId('member')
    .setLabel('Discord ID หรือ Mention สมาชิก')
    .setPlaceholder('เช่น 123456789012345678 หรือ <@123456789012345678>')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(80);
  modal.addComponents(new ActionRowBuilder().addComponents(member));
  return modal;
}
function houseDirectoryRows(g, houseId = null) {
  const rows = [];
  const houses = (g?.houses || []).filter(h => !houseId || h.id === houseId);
  const day = g?.houseAttendance?.[store.today()] || {};
  for (const h of houses) {
    const memberIds = h.memberIds || [];
    if (!memberIds.length) {
      rows.push({ house: h, userId: null, record: null });
    } else {
      for (const userId of memberIds) rows.push({ house: h, userId, record: day?.[h.id]?.[userId] || null });
    }
  }
  return rows;
}
function houseDirectoryPayload(g, page = 0, houseId = null) {
  const selectedHouse = houseId ? (g?.houses || []).find(h => h.id === houseId) : null;
  if (houseId && !selectedHouse) return { ...ep('ไม่พบบ้านนี้'), components: [] };
  const houses = (g?.houses || []).filter(h => !houseId || h.id === houseId);
  if (!houses.length) return { ...ep('📋 ยังไม่มีรายชื่อบ้าน ใช้ `/house add` และ `/house member add` ก่อน'), components: [] };
  const day = g?.houseAttendance?.[store.today()] || {};
  const lines = [selectedHouse ? `📋 **รายชื่อเช็กชื่อบ้าน ${sanitize(selectedHouse.name)}**` : '📋 **รายชื่อเช็กชื่อตามบ้านทั้งหมด**', `วันที่: ${store.today()}`];
  for (const h of houses) {
    const records = day[h.id] || {};
    const memberIds = h.memberIds || [];
    const groups = { present: [], late: [], leave: [], missing: [] };
    for (const id of memberIds) {
      const st = records[id]?.status;
      if (st === 'present') groups.present.push(id);
      else if (st === 'late') groups.late.push(id);
      else if (st === 'leave') groups.leave.push(id);
      else groups.missing.push(id);
    }
    const show = (title, arr, statusKey) => {
      lines.push(`\n${title} (${arr.length} คน)`);
      if (!arr.length) { lines.push('ไม่มี'); return; }
      arr.forEach((id, idx) => {
        const r = records[id];
        const time = r?.time || (r?.at ? String(r.at).slice(11, 16) : '');
        const reason = r?.reason ? ` (${sanitize(r.reason).slice(0, 80)})` : '';
        lines.push(`${idx + 1}. <@${id}>${time ? ` เวลา ${time}` : ''}${reason}`);
      });
    };
    lines.push(`\n🏠 **${sanitize(h.name)}**${h.leaderId ? ` — หัวหน้า <@${h.leaderId}>` : ''}`);
    if (!memberIds.length) { lines.push('ยังไม่มีลูกบ้าน'); continue; }
    show('✅ มา', groups.present, 'present');
    show('🕒 มาสาย', groups.late, 'late');
    show('📝 ลา', groups.leave, 'leave');
    show('⬜ ยังไม่เช็ก', groups.missing, 'missing');
  }
  const embed = new EmbedBuilder()
    .setTitle(selectedHouse ? `📋 รายชื่อบ้าน ${sanitize(selectedHouse.name)}` : '📋 รายชื่อเช็กชื่อตามบ้าน')
    .setDescription(lines.join('\n').slice(0, 3900))
    .setFooter({ text: 'เช็กชื่อบ้านแยกจากเช็กชื่อปกติ • แยกตามสถานะ มา / มาสาย / ลา / ยังไม่เช็ก' });
  const target = houseId || 'all';
  const components = [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`house:list:refresh:${target}:0`).setLabel('🔄 รีเฟรช').setStyle(ButtonStyle.Primary)
  )];
  return { embeds: [embed], components, flags: MessageFlags.Ephemeral, allowedMentions: silent };
}

const ATTENDANCE_DIRECTORY_PAGE_SIZE = 10;
function attendanceRecordLabel(record) {
  if (!record) return '⬜ ยังไม่เช็ก';
  return attendanceStatusLabel(record.status);
}
function attendanceRecordLine(record) {
  if (!record) return '⬜ ยังไม่เช็ก';
  const time = record.time || (record.at ? String(record.at).slice(11, 16) : '');
  const reason = record.reason ? ` • ${sanitize(record.reason).slice(0, 80)}` : '';
  return `${attendanceRecordLabel(record)}${time ? ` • เวลา ${time}` : ''}${reason}`;
}
async function attendanceDirectoryPayload(i, page = 0) {
  const g = store.getGuild(i.guildId);
  if (!g?.config?.roleId) return { ...ep('ยังไม่ได้ตั้งค่า Role สมาชิก ใช้ `/setup` ก่อน'), components: [] };
  const roster = await optionalRoster(i.guild, g.config);
  if (!Array.isArray(roster)) {
    const msg = roster?.message || 'ไม่ทราบสาเหตุ';
    return { ...ep(`ยังอ่านรายชื่อสมาชิกไม่ได้\nสาเหตุจริง: ${sanitize(msg).slice(0, 180)}\n\nถ้าเป็น rate limited ให้รอ 20–30 วินาทีแล้วกดใหม่`), components: [] };
  }

  const today = store.today();
  const records = g.attendance?.[today] || {};
  const rows = roster
    .map(m => ({ id: m.id, name: m.displayName || m.user?.username || m.id, record: records[m.id] || null }))
    .sort((a, b) => a.name.localeCompare(b.name, 'th'));
  if (!rows.length) return { ...ep('📋 ยังไม่มีสมาชิกใน Role ที่ใช้เช็กชื่อ'), components: [] };

  const groups = { present: [], late: [], leave: [], missing: [] };
  for (const row of rows) {
    const st = row.record?.status;
    if (st === 'present') groups.present.push(row);
    else if (st === 'late') groups.late.push(row);
    else if (st === 'leave') groups.leave.push(row);
    else groups.missing.push(row);
  }
  const lines = [`📋 **รายชื่อเช็กชื่อปกติ**`, `วันที่: ${today}`, `สมาชิกทั้งหมด: ${rows.length} คน`];
  const show = (title, arr) => {
    lines.push(`\n${title} (${arr.length} คน)`);
    if (!arr.length) { lines.push('ไม่มี'); return; }
    arr.forEach((row, idx) => {
      const r = row.record;
      const time = r?.time || (r?.at ? String(r.at).slice(11, 16) : '');
      const reason = r?.reason ? ` (${sanitize(r.reason).slice(0, 80)})` : '';
      lines.push(`${idx + 1}. <@${row.id}>${time ? ` เวลา ${time}` : ''}${reason}`);
    });
  };
  show('✅ มา', groups.present);
  show('🕒 มาสาย', groups.late);
  show('📝 ลา', groups.leave);
  show('⬜ ยังไม่เช็ก', groups.missing);

  const embed = new EmbedBuilder()
    .setTitle('📋 รายชื่อเช็กชื่อปกติ')
    .setDescription(lines.join('\n').slice(0, 3900))
    .setFooter({ text: 'แยกตามสถานะ มา / มาสาย / ลา / ยังไม่เช็ก' });
  const components = [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('attendance:list:refresh:0').setLabel('🔄 รีเฟรช').setStyle(ButtonStyle.Primary)
  )];
  return { embeds: [embed], components, flags: MessageFlags.Ephemeral, allowedMentions: silent };
}

function houseListText(g) {
  const houses = g?.houses || [];
  if (!houses.length) return 'ยังไม่มีบ้าน ใช้ `/house add` เพื่อสร้างบ้านก่อน';
  return houses.map((h, idx) => `${idx + 1}. 🏠 **${sanitize(h.name)}**\nหัวหน้า: ${h.leaderId ? `<@${h.leaderId}>` : 'ยังไม่ตั้ง'}\nลูกบ้าน: ${(h.memberIds || []).length ? h.memberIds.map(id => `<@${id}>`).join(', ') : 'ยังไม่มี'}`).join('\n\n').slice(0, 1900);
}
function houseSummaryText(g, date = store.today(), houseFilter = null) {
  const houses = (g?.houses || []).filter(h => !houseFilter || h.id === houseFilter);
  if (!houses.length) return 'ยังไม่มีบ้านสำหรับสรุป';
  const day = g?.houseAttendance?.[date] || {};
  const lines = [`📊 **สรุปเช็กชื่อบ้านประจำวันที่ ${date}**`, 'เช็กชื่อบ้านนี้แยกจากเช็กชื่อปกติ ไม่ไปแก้สถานะเช็กชื่อหลัก'];
  for (const h of houses) {
    const rows = day[h.id] || {};
    const members = h.memberIds || [];
    const present = [], late = [], leave = [], missing = [];
    for (const id of members) {
      const st = rows[id]?.status;
      if (st === 'present') present.push(id); else if (st === 'late') late.push(id); else if (st === 'leave') leave.push(id); else missing.push(id);
    }
    const mention = arr => arr.length ? arr.map(id => `<@${id}>`).join(', ') : '-';
    lines.push(`\n🏠 **${sanitize(h.name)}**${h.leaderId ? ` — หัวหน้า <@${h.leaderId}>` : ''}`);
    lines.push(`✅ มา (${present.length}): ${mention(present)}`);
    lines.push(`🕒 มาสาย (${late.length}): ${mention(late)}`);
    lines.push(`📝 ลา (${leave.length}): ${mention(leave)}`);
    lines.push(`⬜ ยังไม่เช็ก (${missing.length}): ${mention(missing)}`);
  }
  return lines.join('\n').slice(0, 3900);
}
function houseHistoryText(g, houseId = null, limit = 10) {
  const rows = store.houseAttendanceHistoryFromData ? [] : (g?.houseAttendanceHistory || []);
  const filtered = rows.filter(x => !houseId || x.houseId === houseId).slice(-limit).reverse();
  if (!filtered.length) return '📜 ยังไม่มีประวัติเช็กชื่อบ้าน';
  return '📜 **ประวัติเช็กชื่อบ้านล่าสุด**\n' + filtered.map((x, idx) => `${idx + 1}. ${x.date} • 🏠 ${sanitize(x.houseName)}\nสมาชิก: <@${x.userId}> | โดย: <@${x.actorId}>\nจาก: ${x.from ? houseStatusLabel(x.from) : 'ไม่มี'} → ${houseStatusLabel(x.to)}`).join('\n\n').slice(0, 1900);
}
function houseResetWebhookPayload({ guildId, house, actorId, date, count }) {
  return {
    username: 'IMT Home Log',
    allowed_mentions: { parse: [] },
    embeds: [{
      title: '🔄 HOME LOG — Reset เช็กชื่อบ้านวันนี้',
      color: 0xADB5BD,
      fields: [
        { name: 'บ้าน', value: sanitize(house.name), inline: true },
        { name: 'ผู้ดำเนินการ', value: `<@${actorId}>`, inline: true },
        { name: 'วันที่', value: date, inline: true },
        { name: 'จำนวนสถานะที่ล้าง', value: `${count} รายการ`, inline: true },
        { name: 'หมายเหตุ', value: 'ล้างเฉพาะสถานะเช็กชื่อบ้านวันนี้ ไม่ลบรายชื่อสมาชิก/หัวหน้าบ้าน และไม่กระทบเช็กชื่อปกติ', inline: false },
        { name: 'Guild', value: guildId, inline: true }
      ],
      footer: { text: '[IMT] IMMORTAL • Home Log • เวลาไทย' },
      timestamp: new Date().toISOString()
    }]
  };
}
function houseTimeWebhookPayload({ guildId, house, targetId, actorId, status, previous, log }) {
  return {
    username: 'IMT Home Log',
    allowed_mentions: { parse: [] },
    embeds: [{
      title: '🏠 HOME LOG — หัวหน้าบ้านเช็กชื่อ',
      color: attendanceWebhookColor(status),
      fields: [
        { name: 'บ้าน', value: sanitize(house.name), inline: true },
        { name: 'หัวหน้าบ้าน/ผู้เช็ก', value: `<@${actorId}>`, inline: true },
        { name: 'สมาชิก', value: `<@${targetId}>`, inline: true },
        { name: 'สถานะเดิม', value: previous ? houseStatusLabel(previous.status) : 'ไม่มีข้อมูลเดิม', inline: true },
        { name: 'สถานะใหม่', value: houseStatusLabel(status), inline: true },
        { name: 'หมายเหตุ', value: 'เช็กชื่อบ้านแยกจากเช็กชื่อปกติ', inline: false },
        { name: 'รหัส', value: log?.id || '-', inline: true },
        { name: 'Guild', value: guildId, inline: true }
      ],
      footer: { text: '[IMT] IMMORTAL • Home Log • เวลาไทย' },
      timestamp: new Date().toISOString()
    }]
  };
}
function houseDailySummaryPayload(guildId, g, date) {
  return {
    username: 'IMT Home Log',
    allowed_mentions: { parse: [] },
    embeds: [{
      title: `🏠 HOME LOG — สรุปเช็กชื่อบ้านประจำวัน • ${date}`,
      description: houseSummaryText(g, date),
      color: 0x57F287,
      fields: [{ name: 'หมายเหตุ', value: 'รายงานนี้แยกจากเช็กชื่อปกติ ไม่รวม/ไม่แก้ข้อมูลเช็กชื่อหลัก', inline: false }, { name: 'Guild', value: guildId, inline: true }],
      footer: { text: '[IMT] IMMORTAL • Home Summary • เวลาไทย' },
      timestamp: new Date().toISOString()
    }]
  };
}

function attendanceDailyGroups(g, date, roster = null) {
  const entries = Object.entries(g.attendance?.[date] || {});
  const groups = { present: [], late: [], leave: [] };
  for (const [id, record] of entries) if (groups[record.status]) groups[record.status].push({ id, ...record });
  const missing = Array.isArray(roster) ? roster.filter(m => !(g.attendance?.[date] || {})[m.id]).map(m => ({ id: m.id })) : [];
  return { ...groups, missing };
}
function cumulativeAttendanceText(g, roster = null, date = store.today()) {
  const ids = new Set();
  if (Array.isArray(roster)) for (const m of roster) ids.add(m.id);
  for (const users of Object.values(g.attendance || {})) for (const id of Object.keys(users || {})) ids.add(id);
  for (const list of Object.values(g.rostersAtClose || {})) if (Array.isArray(list)) for (const id of list) ids.add(id);
  const next = nextDateISO(date);
  const rows = [...ids].map(id => {
    const e = history.entries(g, id, next);
    return { id, late: e.late.length, leave: e.leave.length, missing: e.missing.length };
  }).filter(x => x.late || x.leave || x.missing)
    .sort((a, b) => (b.missing - a.missing) || (b.late - a.late) || (b.leave - a.leave) || a.id.localeCompare(b.id));
  if (!rows.length) return 'ยังไม่มีแต้มสะสม ขาด/ลา/มาสาย';
  return rows.slice(0, 20).map((x, idx) => `${idx + 1}. <@${x.id}> — ขาด ${x.missing} | ลา ${x.leave} | มาสาย ${x.late}`).join('\n') +
    (rows.length > 20 ? `\n…และอีก ${rows.length - 20} คน` : '');
}
function attendanceDailySummaryPayload(g, date, roster = null) {
  const groups = attendanceDailyGroups(g, date, roster);
  const total = groups.present.length + groups.late.length + groups.leave.length;
  const line = (rows, empty = 'ไม่มี') => rows.length ? rows.slice(0, 20).map((x, idx) => `${idx + 1}. <@${x.id}>`).join('\n') + (rows.length > 20 ? `\n…และอีก ${rows.length - 20} คน` : '') : empty;
  return {
    username: 'IMT Time Log',
    allowed_mentions: { parse: [] },
    embeds: [{
      title: `📋 สรุปเช็กชื่อประจำวัน • ${date}`,
      description: `สรุปอัตโนมัติเวลา **23:59 ประเทศไทย**\nหลังส่งสรุปแล้วระบบวันใหม่จะเริ่มนับใหม่ แต่แต้มสะสม ขาด/ลา/มาสาย จะทบต่อไปเรื่อย ๆ`,
      color: 0x5865F2,
      fields: [
        { name: `✅ มา (${groups.present.length} คน)`, value: line(groups.present), inline: false },
        { name: `🕒 มาสาย (${groups.late.length} คน)`, value: line(groups.late), inline: false },
        { name: `📝 ลา (${groups.leave.length} คน)`, value: line(groups.leave), inline: false },
        Array.isArray(roster) ? { name: `❌ ขาด/ยังไม่เช็ก (${groups.missing.length} คน)`, value: line(groups.missing), inline: false } : { name: '❌ ขาด/ยังไม่เช็ก', value: 'ยังไม่สามารถแสดงรายชื่อทั้งหมดได้ ต้องเปิด SERVER MEMBERS INTENT และกำหนด Role สมาชิก', inline: false },
        { name: '📊 รวมเช็กวันนี้', value: `${total}${Array.isArray(roster) ? `/${roster.length}` : ''} คน`, inline: true },
        { name: '🏅 แต้มสะสม ขาด / ลา / มาสาย', value: cumulativeAttendanceText(g, roster, date).slice(0, 1024), inline: false }
      ],
      footer: { text: timeFooterText('Daily Summary') },
      timestamp: new Date().toISOString()
    }]
  };
}
async function postSummaryWebhook(url, payload, label) {
  if (!url) return false;
  const response = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!response.ok) throw new Error(`${label} summary webhook ล้มเหลว: ${response.status}`);
  return true;
}
function summaryWebhookPayload(title, description, color, footerKind) {
  return {
    username: footerKind === 'vault' ? 'IMT Vault Log' : 'IMT Delivery Log',
    allowed_mentions: { parse: [] },
    embeds: [{
      title, color, description: String(description || '-').slice(0, 3900),
      footer: { text: `[IMT] IMMORTAL • ${footerKind === 'vault' ? 'Vault Summary' : 'Delivery Summary'} • เวลาไทย` },
      timestamp: new Date().toISOString()
    }]
  };
}
async function dailyWebhookSummaries() {
  if (store.timeBangkok() !== '23:59') return;
  const date = store.today();
  for (const id of store.getGuildIds()) {
    const g = store.getGuild(id);
    if (!g) continue;
    const guild = client.guilds.cache.get(id);
    let roster = null;
    if (guild && g.config) {
      try { roster = await optionalRoster(guild, g.config); }
      catch { roster = null; }
    }
    if (timeLogWebhookUrl && !g.sent?.[date]?.timeWebhookSummary) {
      try {
        await postTimeWebhook(attendanceDailySummaryPayload(g, date, roster), 'time summary');
        store.markSent(id, date, 'timeWebhookSummary');
      } catch (e) { console.error('ส่งสรุป webhook เช็กชื่อ 23:59 ไม่สำเร็จ:', e.message); }
    }
    if (homeLogWebhookUrl && !g.sent?.[date]?.homeWebhookSummary && (g.houses || []).length) {
      try {
        await postHomeWebhook(houseDailySummaryPayload(id, g, date), 'home summary');
        store.markSent(id, date, 'homeWebhookSummary');
      } catch (e) { console.error('ส่งสรุป webhook เช็กชื่อบ้านเข้า home_log 23:59 ไม่สำเร็จ:', e.message); }
    }
    if (deliveryLogWebhookUrl && !g.sent?.[date]?.deliveryWebhookSummary) {
      const text = delivery.summary(g, date, roster, g.config?.time || '20:00', '23:59') +
        `\n\n${deliveryRequiredText(g)}`;
      try {
        await postSummaryWebhook(deliveryLogWebhookUrl,
          summaryWebhookPayload(`📦 สรุปส่งของประจำวัน • ${date}`, text, 0xADB5BD, 'delivery'), 'delivery');
        store.markSent(id, date, 'deliveryWebhookSummary');
      } catch (e) { console.error('ส่งสรุป webhook ส่งของ 23:59 ไม่สำเร็จ:', e.message); }
    }
    if (vaultLogWebhookUrl && !g.sent?.[date]?.vaultWebhookSummary) {
      try {
        await postSummaryWebhook(vaultLogWebhookUrl,
          summaryWebhookPayload(`📦 สรุปตู้แก๊งประจำวัน • ${date}`, lockerSummaryText(g), 0x3498DB, 'vault'), 'vault');
        store.markSent(id, date, 'vaultWebhookSummary');
      } catch (e) { console.error('ส่งสรุป webhook ตู้แก๊ง 23:59 ไม่สำเร็จ:', e.message); }
    }
  }
}

function simpleWebhookPayload(username, title, description, color = 0x5865F2, fields = []) {
  return {
    username,
    allowed_mentions: { parse: [] },
    embeds: [{
      title: String(title || 'IMT Log').slice(0, 256),
      description: String(description || '-').slice(0, 3900),
      color,
      fields: fields.filter(Boolean).slice(0, 25),
      footer: { text: '[IMT] IMMORTAL • เวลาไทย' },
      timestamp: new Date().toISOString()
    }]
  };
}
async function postGenericWebhook(url, payload, label) {
  if (!url) return false;
  const response = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!response.ok) throw new Error(`${label} webhook ล้มเหลว: ${response.status}`);
  return true;
}
function dayStatusGroups(g, date, roster = null) {
  const records = g?.attendance?.[date] || {};
  const present = [], late = [], leave = [], missing = [];
  const rosterRows = Array.isArray(roster) ? roster : [];
  const ids = rosterRows.length ? rosterRows.map(m => m.id) : Object.keys(records);
  for (const id of ids) {
    const rec = records[id] || null;
    const row = { id, record: rec };
    if (rec?.status === 'present') present.push(row);
    else if (rec?.status === 'late') late.push(row);
    else if (rec?.status === 'leave') leave.push(row);
    else missing.push(row);
  }
  return { present, late, leave, missing, total: ids.length };
}
function statusList(rows, empty = 'ไม่มี') {
  if (!rows.length) return empty;
  return rows.slice(0, 25).map((x, idx) => {
    const t = x.record?.at ? String(x.record.at).slice(11, 16) : '';
    const r = x.record?.reason ? ` — ${sanitize(x.record.reason)}` : '';
    return `${idx + 1}. <@${x.id}>${t ? ` เวลา ${t}` : ''}${r}`;
  }).join('\n') + (rows.length > 25 ? `\n…และอีก ${rows.length - 25} คน` : '');
}
function reminderPayload(g, date, roster, minuteLabel = '') {
  const groups = dayStatusGroups(g, date, roster);
  return simpleWebhookPayload('IMT Reminder Log', `🔔 เตือนเช็กชื่อ • ${date}`, `ยังไม่เช็กชื่อ **${groups.missing.length} คน** จากสมาชิก **${groups.total} คน**${minuteLabel ? `\nรอบแจ้งเตือน: **${minuteLabel}**` : ''}\n\n${statusList(groups.missing)}`, 0xFEE75C);
}
function houseReminderPayload(g, date) {
  const houses = g?.houses || [];
  const day = g?.houseAttendance?.[date] || {};
  const lines = [];
  for (const h of houses) {
    const records = day[h.id] || {};
    const members = h.memberIds || [];
    const missing = members.filter(id => !records[id]);
    if (missing.length) lines.push(`🏠 **${sanitize(h.name)}** ${h.leaderId ? `หัวหน้า <@${h.leaderId}>` : 'ยังไม่ตั้งหัวหน้า'}\nยังไม่เช็ก ${missing.length}/${members.length} คน\n${missing.slice(0, 15).map((id, idx) => `${idx + 1}. <@${id}>`).join('\n')}${missing.length > 15 ? `\n…และอีก ${missing.length - 15} คน` : ''}`);
  }
  return simpleWebhookPayload('IMT Home Reminder Log', `🏠 เตือนหัวหน้าบ้าน • ${date}`, lines.length ? lines.join('\n\n').slice(0, 3900) : 'ทุกบ้านเช็กชื่อครบแล้ว', 0x57F287);
}
function attendanceScoreFor(g, userId, endDate = store.today()) {
  let present = 0, late = 0, leave = 0, missing = 0, deliveryApproved = 0, deliveryRejected = 0, deliveryPending = 0;
  const scoreMap = { present: 1, late: -1, leave: 0, missing: -3, deliveryApproved: 1, deliveryRejected: -2, deliveryPending: 0 };
  for (const [date, records] of Object.entries(g?.attendance || {})) {
    if (date > endDate) continue;
    const rec = records?.[userId];
    if (rec?.status === 'present') present++;
    else if (rec?.status === 'late') late++;
    else if (rec?.status === 'leave') leave++;
  }
  for (const [date, roster] of Object.entries(g?.rostersAtClose || {})) {
    if (date > endDate) continue;
    if (Array.isArray(roster) && roster.includes(userId) && !g?.attendance?.[date]?.[userId]) missing++;
  }
  for (const rows of Object.values(g?.delivery || {})) {
    if (!Array.isArray(rows)) continue;
    for (const r of rows) if (r.userId === userId) {
      if (r.status === 'approved') deliveryApproved++;
      else if (r.status === 'rejected') deliveryRejected++;
      else if (r.status === 'pending') deliveryPending++;
    }
  }
  const score = present*scoreMap.present + late*scoreMap.late + missing*scoreMap.missing + deliveryApproved*scoreMap.deliveryApproved + deliveryRejected*scoreMap.deliveryRejected;
  return { score, present, late, leave, missing, deliveryApproved, deliveryRejected, deliveryPending };
}
function allKnownMemberIds(g, roster = null) {
  const ids = new Set();
  if (Array.isArray(roster)) for (const m of roster) ids.add(m.id);
  for (const records of Object.values(g?.attendance || {})) for (const id of Object.keys(records || {})) ids.add(id);
  for (const arr of Object.values(g?.rostersAtClose || {})) if (Array.isArray(arr)) for (const id of arr) ids.add(id);
  for (const h of g?.houses || []) for (const id of h.memberIds || []) ids.add(id);
  return [...ids];
}
function disciplineReportText(g, roster = null, date = store.today(), limit = 20) {
  const rows = allKnownMemberIds(g, roster).map(id => ({ id, ...attendanceScoreFor(g, id, date) }))
    .sort((a,b) => b.score - a.score || a.id.localeCompare(b.id));
  if (!rows.length) return 'ยังไม่มีข้อมูลคะแนนวินัย';
  const top = rows.slice(0, limit).map((x, idx) => `${idx + 1}. <@${x.id}> — คะแนน **${x.score}** | มา ${x.present} | สาย ${x.late} | ลา ${x.leave} | ขาด ${x.missing} | ส่งผ่าน ${x.deliveryApproved} | ไม่รับ ${x.deliveryRejected}`).join('\n');
  const bad = rows.filter(x => x.score < 0).slice(0, 10).map((x, idx) => `${idx + 1}. <@${x.id}> — ${x.score}`).join('\n') || 'ไม่มี';
  return `🏆 **อันดับคะแนนวินัย**\n${top}\n\n⚠️ **คะแนนติดลบ**\n${bad}`.slice(0, 3900);
}
function profileText(g, userId, roster = null) {
  const date = store.today();
  const att = g?.attendance?.[date]?.[userId] || null;
  const house = (g?.houses || []).find(h => (h.memberIds || []).includes(userId));
  const hrec = house ? g?.houseAttendance?.[date]?.[house.id]?.[userId] : null;
  const sc = attendanceScoreFor(g, userId, date);
  const deliveryRows = Object.values(g?.delivery || {}).flat().filter(x => x.userId === userId).slice(-5).reverse();
  return `👤 **โปรไฟล์สมาชิก**\nสมาชิก: <@${userId}>\nบ้าน: ${house ? `🏠 ${sanitize(house.name)}` : 'ยังไม่อยู่บ้าน'}\nเช็กชื่อวันนี้: ${att ? attendanceNames[att.status] : '⬜ ยังไม่เช็ก'}${att?.reason ? ` — ${sanitize(att.reason)}` : ''}\nเช็กชื่อบ้านวันนี้: ${hrec ? houseStatusLabel(hrec.status) : '⬜ ยังไม่เช็ก'}\nคะแนนวินัย: **${sc.score}**\nมา ${sc.present} | มาสาย ${sc.late} | ลา ${sc.leave} | ขาด ${sc.missing}\nส่งผ่าน ${sc.deliveryApproved} | ไม่รับ ${sc.deliveryRejected} | รอตรวจ ${sc.deliveryPending}\n\n📦 **ส่งของล่าสุด**\n${deliveryRows.length ? deliveryRows.map((x, idx) => `${idx + 1}. ${itemLabel(x.name)} ${x.quantity} ${sanitize(x.unit || 'ชิ้น')} — ${x.status}`).join('\n') : 'ยังไม่มีข้อมูลส่งของ'}`.slice(0, 1900);
}
function weeklyReportPayload(guildId, g, roster = null, date = store.today()) {
  const discipline = disciplineReportText(g, roster, date, 15);
  return simpleWebhookPayload('IMT Weekly Log', `📊 สรุปรายสัปดาห์ • ${date}`, `${discipline}\n\n🏠 **สรุปบ้านวันนี้**\n${houseSummaryText(g, date).slice(0, 1200)}`, 0x9B59B6);
}
function backupPayload(guildId, g) {
  const safe = JSON.stringify({ guildId, generatedAt: new Date().toISOString(), date: store.today(), data: g }, null, 2);
  return simpleWebhookPayload('IMT Backup Log', `💾 Backup ข้อมูล • ${store.today()}`, `ข้อมูลสำรอง JSON อยู่ใน code block ด้านล่าง\n\n\`\`\`json\n${safe.slice(0, 3300)}\n\`\`\``, 0x95A5A6);
}
function adminDashboardComponents() {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('admin:profile').setLabel('👤 โปรไฟล์ฉัน').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('admin:discipline').setLabel('🏆 คะแนนวินัย').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('admin:weekly').setLabel('📊 สรุปรายสัปดาห์').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('admin:backup').setLabel('💾 Backup').setStyle(ButtonStyle.Secondary)
  )];
}
function adminDashboardText() {
  return `🧭 **Admin Dashboard**\nรวมระบบใหม่ v2.2\n\n- 🔔 เตือนคนยังไม่เช็กชื่อ\n- 🏠 เตือนหัวหน้าบ้าน\n- 🏆 คะแนนวินัย\n- 👤 โปรไฟล์สมาชิก\n- 📊 สรุปรายสัปดาห์\n- 💾 Backup ข้อมูล\n\nปุ่มนี้ใช้สำหรับดูข้อมูลหลักแบบเร็ว`; 
}
async function reminderSchedules() {
  const t = store.timeBangkok();
  if (!['19:30', '19:50'].includes(t)) return;
  const date = store.today();
  for (const id of store.getGuildIds()) {
    const g = store.getGuild(id); if (!g?.config) continue;
    if (g.sent?.[date]?.[`reminder_${t}`]) continue;
    const guild = client.guilds.cache.get(id); if (!guild) continue;
    let roster = null; try { roster = await optionalRoster(guild, g.config); } catch {}
    if (Array.isArray(roster) && reminderLogWebhookUrl) await postGenericWebhook(reminderLogWebhookUrl, reminderPayload(g, date, roster, t), 'reminder').catch(e => console.error('ส่ง reminder ไม่สำเร็จ:', e.message));
    if (homeReminderWebhookUrl && (g.houses || []).length) await postGenericWebhook(homeReminderWebhookUrl, houseReminderPayload(g, date), 'home reminder').catch(e => console.error('ส่ง home reminder ไม่สำเร็จ:', e.message));
    store.markSent(id, date, `reminder_${t}`);
  }
}
async function weeklyAndBackupSchedules() {
  const date = store.today(), t = store.timeBangkok();
  const day = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Bangkok', weekday: 'short' }).format(new Date());
  for (const id of store.getGuildIds()) {
    const g = store.getGuild(id); if (!g) continue;
    const guild = client.guilds.cache.get(id);
    let roster = null;
    if (guild && g.config) { try { roster = await optionalRoster(guild, g.config); } catch {} }
    if (t === '23:55' && backupLogWebhookUrl && !g.sent?.[date]?.backupWebhook) {
      await postGenericWebhook(backupLogWebhookUrl, backupPayload(id, g), 'backup').catch(e => console.error('ส่ง backup webhook ไม่สำเร็จ:', e.message));
      store.markSent(id, date, 'backupWebhook');
    }
    if (t === '23:58' && day === 'Sun' && weeklyLogWebhookUrl && !g.sent?.[date]?.weeklyWebhook) {
      await postGenericWebhook(weeklyLogWebhookUrl, weeklyReportPayload(id, g, roster, date), 'weekly').catch(e => console.error('ส่ง weekly webhook ไม่สำเร็จ:', e.message));
      store.markSent(id, date, 'weeklyWebhook');
    }
    if (t === '23:57' && disciplineLogWebhookUrl && !g.sent?.[date]?.disciplineWebhook) {
      await postGenericWebhook(disciplineLogWebhookUrl, simpleWebhookPayload('IMT Discipline Log', `🏆 คะแนนวินัยประจำวัน • ${date}`, disciplineReportText(g, roster, date, 20), 0xE67E22), 'discipline').catch(e => console.error('ส่ง discipline webhook ไม่สำเร็จ:', e.message));
      store.markSent(id, date, 'disciplineWebhook');
    }
  }
}

function deliveryItemModal() {
  return new ModalBuilder().setTitle('สร้าง/แก้ไขของที่ต้องส่ง').setCustomId('delivery:item-modal')
    .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('name')
      .setLabel('ชื่อของ').setPlaceholder('เช่น red money หรือ weapon box').setStyle(TextInputStyle.Short)
      .setMaxLength(80).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('quantity')
      .setLabel('จำนวนที่ต้องส่ง').setPlaceholder('เช่น 100').setStyle(TextInputStyle.Short).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('unit')
      .setLabel('หน่วย').setPlaceholder('เช่น ชิ้น หรือ บาท').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(20)));
}

function deliveryStatusEditModal(fromStatus, toStatus) {
  const title = fromStatus === 'rejected'
    ? 'เปลี่ยน ไม่รับ → รับแล้ว'
    : 'เปลี่ยน รับแล้ว → ไม่รับ';
  const modal = new ModalBuilder()
    .setCustomId(`delivery:statusedit:${fromStatus}:${toStatus}`)
    .setTitle(title.slice(0, 45));
  const member = new TextInputBuilder()
    .setCustomId('member')
    .setLabel('สมาชิก (Mention หรือ Discord ID)')
    .setPlaceholder('@สมาชิก หรือ 123456789012345678')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(80);
  const note = new TextInputBuilder()
    .setCustomId('note')
    .setLabel('หมายเหตุ (ไม่บังคับ)')
    .setPlaceholder('เช่น ตรวจใหม่แล้ว / กดผิด')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setMaxLength(250);
  modal.addComponents(new ActionRowBuilder().addComponents(member), new ActionRowBuilder().addComponents(note));
  return modal;
}

async function refreshDeliveryDashboard(guild, date = store.today()) {
  const key = `${guild.id}:${date}:delivery`;
  const previous = deliveryQueue.get(key) || Promise.resolve();
  const task = previous.catch(() => {}).then(async () => {
    const g = store.getGuild(guild.id);
    if (!g?.config?.deliveryChannelId) return false;
    const ch = await guild.channels.fetch(g.config.deliveryChannelId);
    if (!ch?.isTextBased()) throw new Error('ห้องส่งของไม่รองรับการส่งข้อความ');
    const roster = await optionalRoster(guild, g.config);
    const description = delivery.summary(g, date, roster, g.config.time || '20:00');
    const req = (g.deliveryItems || []).length ? `\n\n${deliveryRequiredText(g)}` : '';
    const embed = new EmbedBuilder().setTitle(`[IMT] IMMORTAL • รายงานส่งของ • ${date}`)
      .setDescription((description + req).slice(0, 3990)).setColor(0xADB5BD)
      .setFooter({ text: 'ส่งของแยกจากตู้แก๊ง • หลังรับของต้องเลือกนำเข้าตู้เอง' });
    const saved = g.deliveryDashboard?.[date];
    if (saved?.messageId && saved.channelId === ch.id) {
      try {
        if (saved.logo && hasLogo) embed.setThumbnail('attachment://IMMORTAL-2.png');
        await ch.messages.edit(saved.messageId, { embeds: [embed], components: deliveryRequiredComponents(g), allowedMentions: silent });
        return true;
      } catch (e) { if (e.code !== 10008) console.error('แก้ไขรายงานส่งของ:', e.message); }
    }
    if (hasLogo) embed.setThumbnail('attachment://IMMORTAL-2.png');
    const m = await ch.send({ embeds: [embed], components: deliveryRequiredComponents(g), ...(hasLogo ? { files: [logoFile] } : {}), allowedMentions: silent });
    store.update(guild.id, gg => {
      gg.deliveryDashboard ||= {};
      gg.deliveryDashboard[date] = { messageId: m.id, channelId: ch.id, logo: hasLogo };
    });
    return true;
  });
  deliveryQueue.set(key, task);
  try { return await task; } finally { if (deliveryQueue.get(key) === task) deliveryQueue.delete(key); }
}

function deliveryModal() {
  return new ModalBuilder().setTitle('[IMT] IMMORTAL — ส่งของ').setCustomId('delivery:modal')
    .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('name')
      .setLabel('ชื่อของ').setPlaceholder('เช่น red money หรือ weapon box').setStyle(TextInputStyle.Short)
      .setMaxLength(80).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('quantity')
      .setLabel('จำนวน').setPlaceholder('เช่น 100').setStyle(TextInputStyle.Short).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('unit')
      .setLabel('หน่วย').setPlaceholder('เช่น ชิ้น หรือ บาท').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(20)));
}
async function beginDelivery(i, name, quantity, unit = 'ชิ้น') {
  const g = configOf(i);
  if (!canUseDelivery(i, g)) throw new Error('คุณต้องเป็นสมาชิกทีม หรือถูกเพิ่มอยู่ในบ้านก่อน ถึงจะส่งของได้');
  if (!g.config.deliveryChannelId) throw new Error('ยังไม่ได้กำหนดห้องส่งของ ให้ผู้ดูแลใช้ /delivery setchannel ก่อน');
  const item = delivery.prepare(i.guildId, i.user.id, name, quantity, store.today(), unit || 'ชิ้น');
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`delivery:confirm:${item.id}`).setStyle(ButtonStyle.Success).setLabel('ยืนยันส่งของ'),
    new ButtonBuilder().setCustomId(`delivery:cancel:${item.id}`).setStyle(ButtonStyle.Danger).setLabel('ยกเลิก'));
  return await i.reply({ ...ep(`🧾 **ตรวจสอบก่อนส่ง (ยังไม่บันทึก)**\nผู้ส่ง: <@${i.user.id}>\nชื่อของ: **${itemLabel(item.name)}**\nจำนวน: **${item.quantity.toLocaleString('en-US')} ${sanitize(item.unit)}**\n\nเมื่อยืนยันแล้วผู้มียศต้องกดปุ่ม **✅ ยืนยันรับของ** หรือ **❌ ไม่รับของ**`), components: [row] });
}
async function confirmDelivery(i, id) {
  const g = configOf(i);
  if (!canUseDelivery(i, g)) throw new Error('คุณต้องเป็นสมาชิกทีม หรือถูกเพิ่มอยู่ในบ้านก่อน ถึงจะยืนยันส่งของได้');
  const p = delivery.take(id, i.guildId, i.user.id);
  await i.deferUpdate();
  if (p.date !== store.today()) throw new Error('ข้ามวันแล้ว กรุณาส่งของใหม่');
  const channel = await i.guild.channels.fetch(g.config.deliveryChannelId);
  if (!channel?.isTextBased()) throw new Error('ห้องส่งของเข้าไม่ได้');
  const row = delivery.submit(i.guildId, p);
  let message;
  try {
    message = await channel.send({ content: receiptText(row), components: deliveryReviewComponents(row), allowedMentions: silent });
    delivery.attachMessage(i.guildId, p.date, row.id, channel.id, message.id);
    await recordDeliveryLog(i.guildId, 'submitted', { date: p.date, userId: i.user.id, deliveryId: row.id, itemName: row.name, quantity: row.quantity, unit: row.unit, status: 'pending' });
  } catch (e) {
    delivery.removeUnposted(i.guildId, p.date, row.id);
    throw e;
  }
  try { await refreshDeliveryDashboard(i.guild, p.date); }
  catch (e) { console.error('สร้างรายงานส่งของไม่สำเร็จ:', e.message); }
  return await i.editReply({ content: `✅ บันทึกรายการส่งของแล้ว ขณะนี้ **รอตรวจ** ในห้อง <#${channel.id}>\n` +
    `ชื่อของ: ${itemLabel(p.name)} จำนวน: ${p.quantity.toLocaleString('en-US')} ${sanitize(p.unit)}\nผู้มียศต้องกดปุ่ม ✅ หรือ ❌ เพื่อสรุปผล`,
    components: [], allowedMentions: silent });
}
async function reviewDeliveryFromButton(i, id, outcome) {
  const g = configOf(i);
  requireDeliveryManager(i, g);
  await i.deferUpdate();
  const match = delivery.findById(i.guildId, id);
  if (!match) throw new Error('ไม่พบรายการส่งของ');
  const result = delivery.review(i.guildId, match.date, match.entry.id, outcome, i.user.id);
  if (!result.unchanged) await recordDeliveryLog(i.guildId, outcome === 'approved' ? 'approved' : 'rejected', {
    date: match.date, userId: result.entry.userId, actorId: i.user.id, reviewerId: i.user.id, deliveryId: result.entry.id,
    itemName: result.entry.name, quantity: result.entry.quantity, unit: result.entry.unit, status: result.entry.status,
    note: result.previousStatus ? `แก้สถานะจาก ${result.previousStatus} เป็น ${result.entry.status}` : null
  });
  await i.message.edit({ content: receiptText(result.entry), components: deliveryReviewComponents(result.entry), allowedMentions: silent });
  await refreshDeliveryDashboard(i.guild, match.date);
}

async function updateDeliveryReceiptMessage(guild, entry) {
  if (!entry?.channelId || !entry?.messageId) return false;
  try {
    const ch = await guild.channels.fetch(entry.channelId);
    if (!ch?.isTextBased()) return false;
    const msg = await ch.messages.fetch(entry.messageId);
    await msg.edit({ content: receiptText(entry), components: deliveryReviewComponents(entry), allowedMentions: silent });
    return true;
  } catch (e) {
    console.error('อัปเดตข้อความรายการส่งของไม่สำเร็จ:', e.message);
    return false;
  }
}

async function applyDeliveryStatusEditFromModal(i, fromStatus, toStatus) {
  const g = configOf(i);
  requireDeliveryManager(i, g);
  const targetId = parseDiscordUserId(i.fields.getTextInputValue('member'));
  const note = i.fields.getTextInputValue('note').trim();
  const date = store.today();
  await i.deferReply({ flags: MessageFlags.Ephemeral });

  const latestGuild = store.getGuild(i.guildId);
  const rows = delivery.list(latestGuild, date)
    .filter(x => x.userId === targetId && x.status === fromStatus && !x.supersededBy)
    .sort((a, b) => Number(a.seq || 0) - Number(b.seq || 0));
  if (!rows.length) {
    const fromText = fromStatus === 'rejected' ? 'ไม่รับ' : 'รับแล้ว';
    return await i.editReply(`ไม่พบรายการสถานะ **${fromText}** ของ <@${targetId}> ในวันนี้`);
  }

  let changed = 0;
  for (const row of rows) {
    const result = delivery.review(i.guildId, date, row.id, toStatus, i.user.id);
    if (!result.unchanged) {
      changed++;
      await recordDeliveryLog(i.guildId, toStatus === 'approved' ? 'approved' : 'rejected', {
        date,
        userId: result.entry.userId,
        actorId: i.user.id,
        reviewerId: i.user.id,
        deliveryId: result.entry.id,
        itemName: result.entry.name,
        quantity: result.entry.quantity,
        unit: result.entry.unit,
        status: result.entry.status,
        note: note || `แก้จาก ${fromStatus} เป็น ${toStatus} ผ่าน UI รายงานส่งของ`
      });
      await updateDeliveryReceiptMessage(i.guild, result.entry);
    }
  }
  await refreshDeliveryDashboard(i.guild, date).catch(e => console.error('รีเฟรชรายงานส่งของหลังแก้สถานะจาก UI:', e.message));
  const toText = toStatus === 'approved' ? 'รับแล้ว' : 'ไม่รับ';
  return await i.editReply(`แก้สถานะของ <@${targetId}> เป็น **${toText}** แล้ว ${changed} รายการ`);
}

async function deliveryLockerAction(i, id, action) {
  const g = configOf(i);
  requireDeliveryManager(i, g);
  await i.deferUpdate();
  const match = delivery.findById(i.guildId, id);
  if (!match) throw new Error('ไม่พบรายการส่งของ');
  const marked = delivery.markLockerAction(i.guildId, match.date, match.entry.id, action, i.user.id);
  let lockerChange = null;
  if (!marked.unchanged && action === 'imported') lockerChange = store.lockerIncrease(i.guildId, marked.entry.name, marked.entry.quantity, marked.entry.unit || 'ชิ้น');
  const entry = marked.entry;
  if (!marked.unchanged) await recordDeliveryLog(i.guildId, action === 'imported' ? 'locker_imported' : 'locker_skipped', {
    date: match.date, userId: entry.userId, actorId: i.user.id, deliveryId: entry.id, itemName: entry.name,
    quantity: entry.quantity, unit: entry.unit, status: entry.status, lockerAction: action,
    beforeQty: lockerChange?.beforeQty ?? null, afterQty: lockerChange?.afterQty ?? null
  });
  await i.message.edit({ content: receiptText(entry), components: deliveryReviewComponents(entry), allowedMentions: silent });
  await refreshDeliveryDashboard(i.guild, match.date);
}

client.on(Events.MessageReactionAdd, async (reaction, user) => {
  try {
    if (user.bot || !['✅','❌'].includes(reaction.emoji.name)) return;
    if (reaction.partial) reaction = await reaction.fetch();
    if (reaction.message.partial) await reaction.message.fetch();
    const msg = reaction.message, guild = msg.guild;
    if (!guild || msg.author.id !== client.user.id) return;
    const match = delivery.findByMessage(guild.id, msg.id);
    if (!match) return;
    const g = store.getGuild(guild.id);
    if (g?.config?.deliveryChannelId !== msg.channelId) return;
    const member = await guild.members.fetch(user.id);
    const isManager = guild.ownerId === user.id || member.permissions.has(PermissionFlagsBits.ManageGuild) || memberHasRole(member, g.deliveryManagerRoleIds || []);
    if (!isManager) {
      console.log(`สมาชิก ${user.id} พยายามติ๊กผลส่งของ แต่ไม่มีสิทธิ์ตรวจรับ`);
      await reaction.users.remove(user.id).catch(() => {});
      return;
    }
    const outcome = reaction.emoji.name === '✅' ? 'approved' : 'rejected';
    const result = delivery.review(guild.id, match.date, match.entry.id, outcome, user.id);
    if (!result.unchanged) {
      await msg.edit({ content: receiptText(result.entry), components: deliveryReviewComponents(result.entry), allowedMentions: silent });
      await refreshDeliveryDashboard(guild, match.date);
    }
    await reaction.users.remove(user.id).catch(() => {});
  } catch (e) { console.error('ตรวจรับส่งของด้วยอีโมจิไม่สำเร็จ:', e.message); }
});
async function checkItem(i, itemId, foundQty, condition, note) {
  const g = configOf(i);
  if (!onlyTeam(i, g)) throw new Error('คุณยังไม่มีบทบาทสมาชิกทีมที่กำหนด');
  if (!Number.isSafeInteger(foundQty) || foundQty < 0 || foundQty > 1000000) {
    throw new Error('จำนวนที่ตรวจพบต้องเป็นจำนวนเต็มตั้งแต่ 0 ถึง 1,000,000');
  }
  if (!conditionNames[condition]) throw new Error('สภาพของไม่ถูกต้อง');
  const date = store.today();
  const { item, previous } = store.inventory(i.guildId, date, i.user.id, itemId, foundQty, condition, note);
  const status = condition === 'normal' && foundQty < item.requiredQty ? 'จำนวนไม่ครบ' : conditionNames[condition];
  const message = `📦 เช็กของ ${date}\nสมาชิก: <@${i.user.id}>\nรายการ: ${itemLabel(item.name)}\nจำนวนที่ควรมี: ${item.requiredQty} | ตรวจพบ: ${foundQty}\nสภาพ: ${status}\nหมายเหตุ: ${sanitize(note)}`;
  const sent = await announce(i.guild, g.config.inventoryChannelId, message);
  await i.reply(ep(`${previous ? 'อัปเดต' : 'บันทึก'}การตรวจ **${itemLabel(item.name)}** แล้ว (${foundQty}/${item.requiredQty}, ${status})${sent ? '' : '\n⚠️ บันทึกแล้ว แต่ส่งข้อความเข้าห้องไม่ได้'}`));
}
// รายงานใช้ Discord ID ของผู้ยืนยันโดยตรง จึงแสดงชื่อผู้มาได้โดยไม่ต้องอ่านสมาชิกทั้งเซิร์ฟเวอร์
// ถ้าเปิด ENABLE_MEMBERS_INTENT=true จะแสดงรายชื่อคนที่ยังไม่เช็กด้วย
async function reportsFor(guild, g, date) {
  const roster = await optionalRoster(guild, g.config);
  return {
    attendance: new EmbedBuilder(report.attendanceEmbed(g, date, roster, 'final')),
    privateAttendance: new EmbedBuilder(report.attendanceEmbed(g, date, roster, 'private')),
    inventory: report.inventoryText(g, date, roster)
  };
}

let summarizing = false;
async function dailySummaries() {
  if (summarizing) return;
  summarizing = true;
  try {
    const date = store.today(), now = store.timeBangkok();
    for (const id of store.getGuildIds()) {
      const g = store.getGuild(id);
      if (!g?.config || now < (g.config.time || '20:00')) continue;
      if (g.sent[date]?.attendance && g.sent[date]?.inventory && (!g.config.deliveryChannelId || g.sent[date]?.delivery)) continue;
      const discordGuild = client.guilds.cache.get(id);
      if (!discordGuild) continue;
      const texts = await reportsFor(discordGuild, g, date);
      if (hasLogo) texts.attendance.setThumbnail('attachment://IMMORTAL-2.png');
      if (!g.sent[date]?.attendance && await announce(discordGuild, g.config.attendanceChannelId,
        { embeds: [texts.attendance], ...(hasLogo ? { files: [logoFile] } : {}) })) {
        store.markSent(id, date, 'attendance');
      }
      if (!g.sent[date]?.inventory && await announce(discordGuild, g.config.inventoryChannelId, texts.inventory)) {
        store.markSent(id, date, 'inventory');
      }
      if (g.config.deliveryChannelId && !g.sent[date]?.delivery) {
        const roster = await optionalRoster(discordGuild, g.config);
        const daily = delivery.summary(store.getGuild(id), date, roster, g.config.time || '20:00');
        if (await announce(discordGuild, g.config.deliveryChannelId, daily.slice(0, 1900))) store.markSent(id, date, 'delivery');
        try { await refreshDeliveryDashboard(discordGuild, date); } catch (e) { console.error('สรุปส่งของ:', e.message); }
      }
    }
  } finally { summarizing = false; }
}

client.on(Events.InteractionCreate, async i => {
  try {
    if (!i.inGuild()) return;
    if (i.isAutocomplete()) {
      const g = store.getGuild(i.guildId);
      const query = String(i.options.getFocused() || '').toLocaleLowerCase();
      const choices = (g?.items || []).filter(it => it.name.toLocaleLowerCase().includes(query))
        .slice(0, 25).map(it => ({ name: it.name, value: it.id }));
      return await i.respond(choices);
    }
    if (i.isStringSelectMenu()) {
      if (i.customId === 'house:select-house') {
        const houseId = i.values[0];
        const house = store.houseList(i.guildId).find(h => h.id === houseId);
        if (!house || !canManageHouse(i, house)) throw new Error('คุณไม่มีสิทธิ์เช็กชื่อบ้านนี้');
        return await i.reply(await houseMemberSelectPayload(i, house));
      }
      if (i.customId.startsWith('house:member:')) {
        const [, , houseId] = i.customId.split(':');
        const targetId = i.values[0];
        const house = store.houseList(i.guildId).find(h => h.id === houseId);
        if (!house || !canManageHouse(i, house)) throw new Error('คุณไม่มีสิทธิ์เช็กชื่อบ้านนี้');
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`house:mark:${houseId}:${targetId}:present`).setLabel('✅ มา').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`house:mark:${houseId}:${targetId}:late`).setLabel('🕒 มาสาย').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId(`house:mark:${houseId}:${targetId}:leave`).setLabel('📝 ลา').setStyle(ButtonStyle.Secondary)
        );
        return await i.reply({ ...ep(`เลือกสถานะให้ <@${targetId}>\nบ้าน: **${sanitize(house.name)}**`), components: [row] });
      }
    }

    if (i.isButton()) {
      if (i.customId === 'history:prev' || i.customId === 'history:next') {
        const view = store.getGuild(i.guildId)?.historyViews?.[i.message.id];
        if (!view || Date.now() >= view.expiresAt) return await i.reply(ep('ข้อความประวัตินี้หมดอายุแล้ว ใช้ /history เพื่อเปิดใหม่'));
        if (i.user.id !== view.userId) return await i.reply(ep('ปุ่มเปลี่ยนหน้านี้ใช้ได้เฉพาะคนที่เรียกประวัติ'));
        const g = configOf(i);
        const pages = history.buildHistory(g, view.targetId, store.today()).pages;
        const page = Math.max(0, Math.min(pages.length - 1, view.page + (i.customId.endsWith('next') ? 1 : -1)));
        await i.update({ embeds: [new EmbedBuilder(pages[page])], components: historyButtons(page, pages.length), allowedMentions: silent });
        store.update(i.guildId, db => { if (db.historyViews?.[i.message.id]) db.historyViews[i.message.id].page = page; });
        return;
      }

      if (i.customId.startsWith('house:member-add-open:') || i.customId.startsWith('house:member-remove-open:')) {
        const parts = i.customId.split(':');
        const action = parts[1] === 'member-add-open' ? 'add' : 'remove';
        const houseId = parts[2];
        const house = store.houseList(i.guildId).find(h => h.id === houseId);
        if (!house || !canManageHouse(i, house)) throw new Error('คุณไม่มีสิทธิ์จัดการสมาชิกบ้านนี้');
        return await i.showModal(houseMemberIdModal(action, house.id, house.name));
      }

      if (i.customId === 'house:open' || i.customId.startsWith('house:open:')) {
        const parts = i.customId.split(':');
        const fixedHouseId = parts[2] || null;
        const houses = housesForUser(i.guildId, i.user.id, manager(i));
        if (!houses.length) throw new Error('คุณยังไม่ได้เป็นหัวหน้าบ้าน หรือยังไม่มีบ้านในระบบ');
        if (fixedHouseId) {
          const house = store.houseList(i.guildId).find(h => h.id === fixedHouseId);
          if (!house || !canManageHouse(i, house)) throw new Error('คุณไม่มีสิทธิ์เช็กชื่อบ้านนี้');
          return await i.reply(await houseMemberSelectPayload(i, house));
        }
        if (houses.length === 1) return await i.reply(await houseMemberSelectPayload(i, houses[0]));
        const menu = new StringSelectMenuBuilder().setCustomId('house:select-house').setPlaceholder('เลือกบ้านที่ต้องการเช็กชื่อ')
          .addOptions(houses.slice(0, 25).map(h => ({ label: h.name.slice(0, 100), value: h.id, description: `${(h.memberIds || []).length} ลูกบ้าน`.slice(0, 100) })));
        return await i.reply({ ...ep('เลือกบ้านที่ต้องการเช็กชื่อ'), components: [new ActionRowBuilder().addComponents(menu)] });
      }
      if (i.customId.startsWith('house:members:')) {
        const [, , houseId, page] = i.customId.split(':');
        const house = store.houseList(i.guildId).find(h => h.id === houseId);
        if (!house || !canManageHouse(i, house)) throw new Error('คุณไม่มีสิทธิ์เช็กชื่อบ้านนี้');
        return await i.update(await houseMemberSelectPayload(i, house, Number(page) || 0));
      }
      if (i.customId.startsWith('house:list-open:')) {
        const parts = i.customId.split(':');
        const houseId = parts[2] && parts[2] !== 'all' ? parts[2] : null;
        const page = Number(parts[3] || 0) || 0;
        return await i.reply(houseDirectoryPayload(store.getGuild(i.guildId), page, houseId));
      }
      if (i.customId.startsWith('house:list:')) {
        const parts = i.customId.split(':');
        // รูปแบบใหม่: house:list:<action>:<houseId|all>:<page>
        // รองรับรูปแบบเก่าชั่วคราว: house:list:<houseId|all>:<page>
        const hasAction = ['prev', 'refresh', 'next'].includes(parts[2]);
        const houseKey = hasAction ? parts[3] : parts[2];
        const pageKey = hasAction ? parts[4] : parts[3];
        const houseId = houseKey && houseKey !== 'all' ? houseKey : null;
        const page = Number(pageKey || 0) || 0;
        const payload = houseDirectoryPayload(store.getGuild(i.guildId), page, houseId);
        delete payload.flags;
        return await i.update(payload);
      }
      if (i.customId === 'house:summary' || i.customId.startsWith('house:summary:')) {
        const parts = i.customId.split(':');
        const fixedHouseId = parts[2] || null;
        const g = store.getGuild(i.guildId);
        const houses = housesForUser(i.guildId, i.user.id, manager(i));
        if (!houses.length) throw new Error('คุณยังไม่ได้เป็นหัวหน้าบ้าน หรือยังไม่มีบ้านในระบบ');
        if (fixedHouseId) {
          const house = store.houseList(i.guildId).find(h => h.id === fixedHouseId);
          if (!house || !canManageHouse(i, house)) throw new Error('คุณไม่มีสิทธิ์ดูสรุปบ้านนี้');
          return await i.reply(ep(houseSummaryText(g, store.today(), fixedHouseId)));
        }
        const text = manager(i) ? houseSummaryText(g, store.today()) : houses.map(h => houseSummaryText(g, store.today(), h.id)).join('\n\n');
        return await i.reply(ep(text));
      }
      if (i.customId === 'house:history' || i.customId.startsWith('house:history:')) {
        const parts = i.customId.split(':');
        const fixedHouseId = parts[2] || null;
        const g = store.getGuild(i.guildId);
        const houses = housesForUser(i.guildId, i.user.id, manager(i));
        if (!houses.length) throw new Error('คุณยังไม่ได้เป็นหัวหน้าบ้าน หรือยังไม่มีบ้านในระบบ');
        const allowedIds = new Set(houses.map(h => h.id));
        if (fixedHouseId && !manager(i) && !allowedIds.has(fixedHouseId)) throw new Error('คุณไม่มีสิทธิ์ดูประวัติบ้านนี้');
        const rows = (g.houseAttendanceHistory || []).filter(x => fixedHouseId ? x.houseId === fixedHouseId : (manager(i) || allowedIds.has(x.houseId))).slice(-10).reverse();
        if (!rows.length) return await i.reply(ep('📜 ยังไม่มีประวัติเช็กชื่อบ้าน'));
        const text = '📜 **ประวัติเช็กชื่อบ้านล่าสุด**\n' + rows.map((x, idx) => `${idx + 1}. ${x.date} • 🏠 ${sanitize(x.houseName)}\nสมาชิก: <@${x.userId}> | โดย: <@${x.actorId}>\nจาก: ${x.from ? houseStatusLabel(x.from) : 'ไม่มี'} → ${houseStatusLabel(x.to)}`).join('\n\n').slice(0, 1900);
        return await i.reply(ep(text));
      }
      if (i.customId.startsWith('house:reset:')) {
        const houseId = i.customId.substring('house:reset:'.length);
        const house = store.houseList(i.guildId).find(h => h.id === houseId);
        if (!house || !canManageHouse(i, house)) throw new Error('คุณไม่มีสิทธิ์ Reset เช็กชื่อบ้านนี้');
        const result = store.houseResetDay(i.guildId, store.today(), houseId, i.user.id);
        postHomeWebhook(houseResetWebhookPayload({ guildId: i.guildId, house: result.house, actorId: i.user.id, date: result.date, count: result.count }), 'house reset').catch(e => console.error('ส่ง home_log reset เช็กชื่อบ้านไม่สำเร็จ:', e.message));
        return await i.reply(ep(`🔄 Reset เช็กชื่อบ้านวันนี้แล้ว\nบ้าน: **${sanitize(result.house.name)}**\nวันที่: ${result.date}\nล้างสถานะ: ${result.count} รายการ\nรายชื่อสมาชิกบ้านยังอยู่เหมือนเดิม และไม่กระทบเช็กชื่อปกติ`));
      }
      if (i.customId.startsWith('house:mark:')) {
        const [, , houseId, targetId, status] = i.customId.split(':');
        const house = store.houseList(i.guildId).find(h => h.id === houseId);
        if (!house || !canManageHouse(i, house)) throw new Error('คุณไม่มีสิทธิ์เช็กชื่อบ้านนี้');
        const result = store.houseMark(i.guildId, store.today(), houseId, targetId, status, i.user.id, 'เช็กโดยหัวหน้าบ้าน');
        postHomeWebhook(houseTimeWebhookPayload({ guildId: i.guildId, house: result.house, targetId, actorId: i.user.id, status, previous: result.previous, log: result.log }), 'house attendance').catch(e => console.error('ส่ง home_log เช็กชื่อบ้านไม่สำเร็จ:', e.message));
        return await i.reply(ep(`🏠 เช็กชื่อบ้านแล้ว\nบ้าน: **${sanitize(result.house.name)}**\nสมาชิก: <@${targetId}>\nสถานะ: ${houseStatusLabel(status)}\nหมายเหตุ: ระบบนี้แยกจากเช็กชื่อปกติ`));
      }

      if (i.customId.startsWith('attendance:list-open:')) {
        const page = Number(i.customId.split(':')[2]) || 0;
        return await i.reply(await attendanceDirectoryPayload(i, page));
      }
      if (i.customId.startsWith('attendance:list:')) {
        const page = Number(i.customId.split(':')[2]) || 0;
        const payload = await attendanceDirectoryPayload(i, page);
        delete payload.flags;
        return await i.update(payload);
      }

      if (i.customId === 'attendance:admin:edit') {
        if (!manager(i)) throw new Error('เฉพาะผู้ดูแลเซิร์ฟเวอร์');
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('attendance:adminchoice:present').setLabel('แก้เป็น ✅ มา').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId('attendance:adminchoice:late').setLabel('แก้เป็น 🕒 มาสาย').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId('attendance:adminchoice:leave').setLabel('แก้เป็น 📝 ลา').setStyle(ButtonStyle.Secondary)
        );
        return await i.reply({ ...ep('🛠 เลือกสถานะใหม่ที่ต้องการแก้ให้สมาชิก แล้วกรอกสมาชิก/วันที่/เหตุผล'), components: [row] });
      }
      if (i.customId === 'attendance:admin:history') {
        if (!manager(i)) throw new Error('เฉพาะผู้ดูแลเซิร์ฟเวอร์');
        return await i.reply(ep(attendanceEditHistoryText(store.getGuild(i.guildId), 10)));
      }
      if (i.customId.startsWith('attendance:adminchoice:')) {
        if (!manager(i)) throw new Error('เฉพาะผู้ดูแลเซิร์ฟเวอร์');
        const status = i.customId.substring('attendance:adminchoice:'.length);
        if (!['present','late','leave'].includes(status)) throw new Error('สถานะใหม่ไม่ถูกต้อง');
        return await i.showModal(attendanceAdminEditModal(status));
      }
      if (i.customId.startsWith('attendance:confirm:')) {
        return await confirmAttendance(i, i.customId.substring('attendance:confirm:'.length));
      }
      if (i.customId.startsWith('attendance:cancel:')) {
        attendanceFlow.cancel(i.customId.substring('attendance:cancel:'.length), i.guildId, i.user.id);
        return await i.update({ content: 'ยกเลิกแล้ว ยังไม่มีการบันทึกเช็กชื่อจากรายการนี้', components: [] });
      }
      if (['attendance:present', 'attendance:late', 'attendance:leave'].includes(i.customId)) {
        return await beginAttendance(i, i.customId.split(':')[1]);
      }
      if (i.customId === 'delivery:checklist') {
        const g = configOf(i);
        if (!canUseDelivery(i, g)) throw new Error('คุณต้องเป็นสมาชิกทีม หรือถูกเพิ่มอยู่ในบ้านก่อน');
        await i.deferReply({ flags: MessageFlags.Ephemeral });
        const roster = await optionalRoster(i.guild, g.config);
        const text = delivery.summary(g, store.today(), roster, g.config.time || '20:00') + `\n\nผู้มียศตรวจของสามารถใช้ปุ่มด้านล่างเพื่อเปลี่ยนสถานะได้ทันที`;
        const components = deliveryManager(i, g) ? deliveryStatusQuickComponents() : [];
        return await i.editReply({ content: text.slice(0, 1900), components, allowedMentions: silent });
      }
      if (i.customId === 'delivery:items-manage') {
        const g = configOf(i);
        requireDeliveryManager(i, g);
        return await i.showModal(deliveryItemModal());
      }
      if (i.customId === 'delivery:items-list') {
        const g = configOf(i);
        if (!canUseDelivery(i, g)) throw new Error('คุณต้องเป็นสมาชิกทีม หรือถูกเพิ่มอยู่ในบ้านก่อน');
        return await i.reply({ ...ep(deliveryRequiredText(g) + ((g.deliveryItems || []).length ? '\n\nกดปุ่มรายการด้านล่างเพื่อส่งของตามจำนวนที่กำหนดได้ทันที โดยไม่ต้องกรอกชื่อ/จำนวนเอง' : '')), components: deliveryRequiredComponents(g) });
      }
      if (i.customId === 'delivery:history') {
        const g = configOf(i);
        if (!canUseDelivery(i, g)) throw new Error('คุณต้องเป็นสมาชิกทีม หรือถูกเพิ่มอยู่ในบ้านก่อน');
        return await i.reply(ep(deliveryHistoryTextForGuild(i.guildId, { limit: 10 })));
      }
      if (i.customId === 'delivery:pending') {
        const g = configOf(i);
        requireDeliveryManager(i, g);
        const rows = delivery.list(g, store.today()).filter(x => x.status === 'pending');
        const text = rows.length ? rows.slice(0, 20).map(x => `${x.seq}. <@${x.userId}> — ${itemLabel(x.name)} ${x.quantity.toLocaleString('en-US')} ${sanitize(x.unit || 'ชิ้น')}`).join('\n') : 'ไม่มีรายการรอตรวจ';
        return await i.reply(ep('✅ **รายการรอยืนยันวันนี้**\n' + text + '\n\nให้กดปุ่ม ✅ หรือ ❌ ใต้ข้อความรายการนั้นโดยตรง'));
      }
      if (i.customId === 'delivery:fix:rejected-approved') {
        const g = configOf(i);
        requireDeliveryManager(i, g);
        return await i.showModal(deliveryStatusEditModal('rejected', 'approved'));
      }
      if (i.customId === 'delivery:fix:approved-rejected') {
        const g = configOf(i);
        requireDeliveryManager(i, g);
        return await i.showModal(deliveryStatusEditModal('approved', 'rejected'));
      }
      if (i.customId === 'delivery:open') {
        const g = configOf(i);
        if (!canUseDelivery(i, g)) throw new Error('คุณต้องเป็นสมาชิกทีม หรือถูกเพิ่มอยู่ในบ้านก่อน');
        if (!g.config.deliveryChannelId) throw new Error('ยังไม่ได้ตั้งห้องส่งของ');
        return await i.showModal(deliveryModal());
      }
      if (i.customId.startsWith('delivery:reqsend:')) {
        const g = configOf(i);
        if (!canUseDelivery(i, g)) throw new Error('คุณต้องเป็นสมาชิกทีม หรือถูกเพิ่มอยู่ในบ้านก่อน');
        if (!g.config.deliveryChannelId) throw new Error('ยังไม่ได้ตั้งห้องส่งของ');
        const itemId = i.customId.substring('delivery:reqsend:'.length);
        const item = (g.deliveryItems || []).find(x => x.id === itemId);
        if (!item) throw new Error('รายการของที่ต้องส่งนี้ถูกลบหรือแก้ไขแล้ว');
        const qty = Number(item.requiredQty || 0);
        if (!Number.isSafeInteger(qty) || qty < 1) throw new Error('รายการนี้ตั้งจำนวนไว้เป็น 0 จึงส่งผ่านปุ่มไม่ได้');
        return await beginDelivery(i, item.name, qty, item.unit || 'ชิ้น');
      }
      if (i.customId.startsWith('delivery:reqcancel:')) {
        const g = configOf(i);
        requireDeliveryManager(i, g);
        const itemId = i.customId.substring('delivery:reqcancel:'.length);
        const removed = store.deliveryItemRemoveById(i.guildId, itemId);
        await recordDeliveryLog(i.guildId, 'item_remove', {
          actorId: i.user.id, itemName: removed.name, quantity: removed.requiredQty, unit: removed.unit,
          note: 'ยกเลิกจากปุ่มข้างรายการของที่ต้องส่ง'
        });
        await refreshDeliveryDashboard(i.guild).catch(e => console.error('รีเฟรชรายงานส่งของหลังยกเลิกของที่ต้องส่ง:', e.message));
        return await i.reply(ep(`ยกเลิกรายการของที่ต้องส่งแล้ว: ${itemLabel(removed.name)} ${Number(removed.requiredQty || 0).toLocaleString('en-US')} ${sanitize(removed.unit || 'ชิ้น')}`));
      }
      if (i.customId === 'delivery:reset-rows') {
        const g = configOf(i);
        requireDeliveryManager(i, g);
        const result = store.deliveryResetRows(i.guildId, store.today());
        await recordDeliveryLog(i.guildId, 'reset_rows', { actorId: i.user.id, quantity: result.count, note: `ล้างรายชื่อ/สถานะส่งของของวันที่ ${result.date}` });
        await refreshDeliveryDashboard(i.guild, result.date).catch(e => console.error('รีเฟรชรายงานส่งของหลัง reset รายชื่อ:', e.message));
        return await i.reply(ep(`Reset รายชื่อส่งของของวันนี้แล้ว (${result.count} รายการ)`));
      }
      if (i.customId === 'delivery:reset-items') {
        const g = configOf(i);
        requireDeliveryManager(i, g);
        const result = store.deliveryResetItems(i.guildId);
        await recordDeliveryLog(i.guildId, 'reset_items', { actorId: i.user.id, quantity: result.count, note: `ล้างของที่ต้องส่ง ${result.count} รายการ` });
        await refreshDeliveryDashboard(i.guild).catch(e => console.error('รีเฟรชรายงานส่งของหลัง reset ของ:', e.message));
        return await i.reply(ep(`Reset ของที่ต้องส่งแล้ว (${result.count} รายการ)`));
      }
      if (i.customId.startsWith('delivery:approve:')) {
        return await reviewDeliveryFromButton(i, i.customId.substring('delivery:approve:'.length), 'approved');
      }
      if (i.customId.startsWith('delivery:reject:')) {
        return await reviewDeliveryFromButton(i, i.customId.substring('delivery:reject:'.length), 'rejected');
      }
      if (i.customId.startsWith('delivery:locker-import:')) {
        return await deliveryLockerAction(i, i.customId.substring('delivery:locker-import:'.length), 'imported');
      }
      if (i.customId.startsWith('delivery:locker-skip:')) {
        return await deliveryLockerAction(i, i.customId.substring('delivery:locker-skip:'.length), 'skipped');
      }
      if (i.customId.startsWith('delivery:confirm:')) {
        return await confirmDelivery(i, i.customId.substring('delivery:confirm:'.length));
      }
      if (i.customId.startsWith('delivery:cancel:')) {
        delivery.cancel(i.customId.substring('delivery:cancel:'.length), i.guildId, i.user.id);
        return await i.update({ content: 'ยกเลิกการส่งของแล้ว ยังไม่ได้บันทึก', components: [] });
      }
      if (i.customId === 'locker:check') {
        const g = configOf(i);
        if (!onlyTeam(i, g) && !lockerManager(i, g)) throw new Error('เฉพาะสมาชิกแก๊งที่กำหนดเท่านั้น');
        const embed = lockerEmbed(store.getGuild(i.guildId));
        if (hasLogo) embed.setThumbnail('attachment://IMMORTAL-2.png');
        return await i.update({ embeds: [embed], components: lockerButtons(), allowedMentions: silent });
      }
      if (i.customId === 'locker:add') {
        const g = configOf(i); requireLockerManager(i, g);
        return await i.showModal(lockerAddModal());
      }
      if (i.customId === 'locker:remove') {
        const g = configOf(i); requireLockerManager(i, g);
        return await i.showModal(lockerRemoveModal());
      }
      if (i.customId === 'locker:edit') {
        const g = configOf(i); requireLockerManager(i, g);
        return await i.showModal(lockerEditModal());
      }
      if (i.customId === 'inventory:open') {
        const g = configOf(i);
        if (!onlyTeam(i, g)) throw new Error('คุณยังไม่มีบทบาทสมาชิกทีมที่กำหนด');
        if (!g.items.length) return await i.reply(ep('ผู้ดูแลยังไม่ได้เพิ่มรายการของ'));
        const select = new StringSelectMenuBuilder().setCustomId('inventory:select')
          .setPlaceholder('เลือกของที่ต้องตรวจ').addOptions(g.items.slice(0, 25).map(item => ({
            label: item.name, value: item.id, description: `ควรมี ${item.requiredQty} ชิ้น`
          })));
        return await i.reply({ ...ep(g.items.length > 25 ? 'แสดง 25 รายการแรก รายการอื่นใช้ /checkitem' : 'เลือกของที่ต้องตรวจ'),
          components: [new ActionRowBuilder().addComponents(select)] });
      }
    }
    if (i.isStringSelectMenu() && i.customId === 'inventory:select') {
      const g = configOf(i);
      if (!onlyTeam(i, g)) throw new Error('คุณยังไม่มีบทบาทสมาชิกทีมที่กำหนด');
      const item = g.items.find(x => x.id === i.values[0]);
      if (!item) throw new Error('รายการของนี้ถูกลบไปแล้ว');
      const modal = new ModalBuilder().setCustomId('inventory:modal:' + item.id)
        .setTitle(('ตรวจของ: ' + item.name).slice(0, 45));
      const qty = new TextInputBuilder().setCustomId('found').setLabel('จำนวนที่ตรวจพบ')
        .setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('ตัวเลข เช่น 2');
      const condition = new TextInputBuilder().setCustomId('condition').setLabel('สภาพ (ปกติ / ชำรุด / สูญหาย)')
        .setStyle(TextInputStyle.Short).setRequired(true).setValue('ปกติ');
      const note = new TextInputBuilder().setCustomId('note').setLabel('หมายเหตุ (ถ้ามี)')
        .setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(250);
      modal.addComponents(new ActionRowBuilder().addComponents(qty),
        new ActionRowBuilder().addComponents(condition), new ActionRowBuilder().addComponents(note));
      return await i.showModal(modal);
    }
    if (i.isModalSubmit() && i.customId === 'delivery:item-modal') {
      const g = configOf(i);
      requireDeliveryManager(i, g);
      const raw = i.fields.getTextInputValue('quantity').trim();
      if (!/^\d{1,13}$/.test(raw)) throw new Error('กรุณาใส่จำนวนเป็นเลขจำนวนเต็ม 0–1,000,000,000,000');
      const result = store.deliveryItemUpsert(i.guildId, i.fields.getTextInputValue('name'), Number(raw), i.fields.getTextInputValue('unit') || 'ชิ้น');
      await recordDeliveryLog(i.guildId, 'item_upsert', { actorId: i.user.id, itemName: result.entry.name, quantity: result.entry.requiredQty, unit: result.entry.unit, note: result.created ? 'created' : 'updated' });
      await refreshDeliveryDashboard(i.guild).catch(e => console.error('รีเฟรชรายงานส่งของหลังแก้ของที่ต้องส่ง:', e.message));
      return await i.reply(ep(`${result.created ? 'เพิ่ม' : 'แก้ไข'}ของที่ต้องส่งแล้ว: ${itemLabel(result.entry.name)} ${Number(result.entry.requiredQty).toLocaleString('en-US')} ${sanitize(result.entry.unit)}`));
    }
    if (i.isModalSubmit() && i.customId === 'locker:add:modal') {
      const g = configOf(i); requireLockerManager(i, g);
      const qty = parsePositiveInt(i.fields.getTextInputValue('quantity'));
      const x = store.lockerAdd(i.guildId, i.fields.getTextInputValue('name'), qty, i.fields.getTextInputValue('unit') || 'ชิ้น');
      await recordDeliveryLog(i.guildId, 'locker_add', { actorId: i.user.id, itemName: x.name, quantity: qty, unit: x.unit, note: 'locker panel' });
      return await i.reply({ ...ep(`➕ เพิ่มของแล้ว: ${itemLabel(x.name)} +${qty.toLocaleString('en-US')} ${sanitize(x.unit)}
ยอดปัจจุบัน: ${Number(x.quantity || 0).toLocaleString('en-US')} ${sanitize(x.unit)}

${lockerSummaryText(store.getGuild(i.guildId)).slice(0, 1500)}`) });
    }
    if (i.isModalSubmit() && i.customId === 'locker:remove:modal') {
      const g = configOf(i); requireLockerManager(i, g);
      const qty = parsePositiveInt(i.fields.getTextInputValue('quantity'));
      const x = store.lockerRemove(i.guildId, i.fields.getTextInputValue('name'), qty);
      await recordDeliveryLog(i.guildId, 'locker_remove', { actorId: i.user.id, itemName: x.name, quantity: qty, unit: x.unit, note: x.deleted ? 'deleted' : 'decreased' });
      const left = x.deleted ? 'ลบรายการออกแล้ว' : `คงเหลือ ${Number(x.quantity || 0).toLocaleString('en-US')} ${sanitize(x.unit)}`;
      return await i.reply({ ...ep(`➖ ลบของแล้ว: ${itemLabel(x.name)} -${qty.toLocaleString('en-US')} ${sanitize(x.unit)}
${left}

${lockerSummaryText(store.getGuild(i.guildId)).slice(0, 1500)}`) });
    }
    if (i.isModalSubmit() && i.customId === 'locker:edit:modal') {
      const g = configOf(i); requireLockerManager(i, g);
      const qty = parseNonNegativeInt(i.fields.getTextInputValue('quantity'));
      const unit = i.fields.getTextInputValue('unit').trim() || null;
      const newName = i.fields.getTextInputValue('newname').trim() || null;
      const x = store.lockerEdit(i.guildId, i.fields.getTextInputValue('name'), qty, unit, newName);
      await recordDeliveryLog(i.guildId, 'locker_edit', { actorId: i.user.id, itemName: x.name, quantity: x.quantity, unit: x.unit, note: 'locker panel' });
      return await i.reply({ ...ep(`✏️ แก้ไขของแล้ว: ${itemLabel(x.name)} — ${Number(x.quantity || 0).toLocaleString('en-US')} ${sanitize(x.unit)}

${lockerSummaryText(store.getGuild(i.guildId)).slice(0, 1500)}`) });
    }
    if (i.isModalSubmit() && i.customId === 'delivery:modal') {
      const raw = i.fields.getTextInputValue('quantity').trim();
      if (!/^\d{1,13}$/.test(raw)) throw new Error('กรุณาใส่จำนวนเป็นเลขจำนวนเต็ม 1–1,000,000,000,000');
      return await beginDelivery(i, i.fields.getTextInputValue('name'), Number(raw), i.fields.getTextInputValue('unit') || 'ชิ้น');
    }

    if (i.isModalSubmit() && i.customId.startsWith('delivery:statusedit:')) {
      const parts = i.customId.split(':');
      return await applyDeliveryStatusEditFromModal(i, parts[2], parts[3]);
    }

    if (i.isModalSubmit() && (i.customId.startsWith('house:member-add-modal:') || i.customId.startsWith('house:member-remove-modal:'))) {
      const isAdd = i.customId.startsWith('house:member-add-modal:');
      const houseId = i.customId.split(':')[2];
      const house = store.houseList(i.guildId).find(h => h.id === houseId);
      if (!house || !canManageHouse(i, house)) throw new Error('คุณไม่มีสิทธิ์จัดการสมาชิกบ้านนี้');
      const targetId = parseDiscordUserId(i.fields.getTextInputValue('member'));
      const result = isAdd
        ? store.houseMemberAdd(i.guildId, house.id, targetId)
        : store.houseMemberRemove(i.guildId, house.id, targetId);
      const actionText = isAdd ? 'เพิ่ม/ย้ายสมาชิกเข้าบ้านแล้ว' : 'ลบสมาชิกออกจากบ้านแล้ว';
      return await i.reply(ep(`${isAdd ? '➕' : '➖'} ${actionText}
บ้าน: **${sanitize(result.name)}**
สมาชิก: <@${targetId}>
จำนวนลูกบ้านปัจจุบัน: ${(result.memberIds || []).length} คน`));
    }

    if (i.isModalSubmit() && i.customId.startsWith('attendance:adminedit:')) {
      if (!manager(i)) throw new Error('เฉพาะผู้ดูแลเซิร์ฟเวอร์');
      const status = i.customId.substring('attendance:adminedit:'.length);
      if (!['present','late','leave'].includes(status)) throw new Error('สถานะใหม่ไม่ถูกต้อง');
      const targetId = parseDiscordUserId(i.fields.getTextInputValue('member'));
      const date = i.fields.getTextInputValue('date').trim() || store.today();
      const time = i.fields.getTextInputValue('time').trim() || store.timeBangkok();
      if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('เวลาไม่ถูกต้อง กรุณาใช้รูปแบบ HH:MM เช่น 18:30');
      const reason = i.fields.getTextInputValue('reason').trim();
      const result = store.attendanceAdminEdit(i.guildId, date, targetId, status, reason, i.user.id, time);
      if (date === store.today()) {
        try { await refreshDashboard(i.guild, date); } catch (e) { console.error('รีเฟรชรายงานหลังผู้ดูแลแก้เช็กชื่อ:', e.message); }
      }
      postTimeWebhook(attendanceAdminEditWebhookPayload({ guildId: i.guildId, targetId, actorId: i.user.id, date, time, previous: result.previous, status, reason, log: result.log }), 'time admin edit')
        .catch(e => console.error('ส่ง Time_log การแก้ไขเช็กชื่อไม่สำเร็จ:', e.message));
      return await i.reply(ep(`🛠 แก้ไขเช็กชื่อแล้ว
สมาชิก: <@${targetId}>
วันที่: ${date}
เวลา: ${time}
จาก: ${result.previous ? attendanceStatusLabel(result.previous.status) : 'ไม่มีข้อมูลเดิม'}
เป็น: ${attendanceStatusLabel(status)}${reason ? `
เหตุผล: ${sanitize(reason)}` : ''}`));
    }
    if (i.isModalSubmit() && i.customId.startsWith('attendance:reason:')) {
      const status = i.customId.substring('attendance:reason:'.length);
      if (status !== 'late' && status !== 'leave') throw new Error('ประเภทการลาหรือมาสายไม่ถูกต้อง');
      return await beginAttendance(i, status, i.fields.getTextInputValue('reason'),
        status === 'leave' ? i.fields.getTextInputValue('leaveStart') : null,
        status === 'leave' ? i.fields.getTextInputValue('leaveEnd') : null);
    }
    if (i.isModalSubmit() && i.customId.startsWith('inventory:modal:')) {
      const id = i.customId.substring('inventory:modal:'.length);
      const rawQty = i.fields.getTextInputValue('found').trim();
      if (!/^\d{1,7}$/.test(rawQty)) throw new Error('กรุณากรอกจำนวนเต็มตั้งแต่ 0 ถึง 1,000,000');
      const rawCondition = i.fields.getTextInputValue('condition').trim();
      const condition = { 'ปกติ': 'normal', 'ชำรุด': 'damaged', 'สูญหาย': 'lost' }[rawCondition];
      if (!condition) throw new Error('สภาพต้องเป็น ปกติ, ชำรุด หรือ สูญหาย');
      return await checkItem(i, id, Number(rawQty), condition, i.fields.getTextInputValue('note'));
    }

    if (i.isButton() && i.customId.startsWith('admin:')) {
      const g = configOf(i);
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      let roster = null; try { roster = await optionalRoster(i.guild, g.config); } catch {}
      if (i.customId === 'admin:profile') return await i.editReply(profileText(g, i.user.id, roster));
      if (!manager(i)) throw new Error('เฉพาะผู้ดูแลเซิร์ฟเวอร์');
      if (i.customId === 'admin:discipline') {
        const text = disciplineReportText(g, roster, store.today(), 25);
        if (disciplineLogWebhookUrl) postGenericWebhook(disciplineLogWebhookUrl, simpleWebhookPayload('IMT Discipline Log', `🏆 คะแนนวินัย • ${store.today()}`, text, 0xE67E22), 'discipline').catch(console.error);
        return await i.editReply(text);
      }
      if (i.customId === 'admin:weekly') {
        const payload = weeklyReportPayload(i.guildId, g, roster, store.today());
        if (weeklyLogWebhookUrl) postGenericWebhook(weeklyLogWebhookUrl, payload, 'weekly').catch(console.error);
        return await i.editReply(payload.embeds[0].description);
      }
      if (i.customId === 'admin:backup') {
        if (backupLogWebhookUrl) postGenericWebhook(backupLogWebhookUrl, backupPayload(i.guildId, g), 'backup').catch(console.error);
        return await i.editReply('ส่ง Backup ไปยัง webhook แล้ว ถ้าตั้ง BACKUP_LOG_WEBHOOK_URL ไว้');
      }
    }

    if (!i.isChatInputCommand()) return;
    if (i.commandName === 'setup') {
      if (!manager(i)) throw new Error('เฉพาะผู้ดูแลเซิร์ฟเวอร์');
      const attendance = i.options.getChannel('attendance', true);
      const inventory = i.options.getChannel('inventory', true);
      const role = i.options.getRole('role', true);
      const oldConfig = store.getGuild(i.guildId)?.config;
      const deliveryChannel = i.options.getChannel('delivery');
      const time = i.options.getString('time') || oldConfig?.time || '20:00';
      if (role.id === i.guildId) throw new Error('กรุณาเลือกบทบาทสมาชิก ไม่ใช่ @everyone');
      if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('เวลาไม่ถูกต้อง กรุณาใช้ HH:MM เช่น 20:00');
      store.setConfig(i.guildId, { attendanceChannelId: attendance.id, inventoryChannelId: inventory.id,
        deliveryChannelId: deliveryChannel?.id || oldConfig?.deliveryChannelId || null, roleId: role.id, time });
      return await i.reply(ep(`ตั้งค่าสำเร็จ\nห้องเช็กชื่อ: ${attendance} (มา 18:00–23:59 น.; มาสาย/ลา 00:00–23:59 น.)\nห้องเช็กของ: ${inventory}\nห้องส่งของ: ${deliveryChannel || (oldConfig?.deliveryChannelId ? '<#' + oldConfig.deliveryChannelId + '>' : 'ยังไม่ตั้ง')}\nบทบาทสมาชิก: ${role.name}\nเริ่มนับสาย/สรุปทุกวัน: ${time} น. (เวลาไทย)\nใช้ /panel, /leave และ /history เพื่อใช้งาน`));
    }
    if (i.commandName === 'panel') {
      if (!manager(i)) throw new Error('เฉพาะผู้ดูแลเซิร์ฟเวอร์');
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      const g = configOf(i), kind = i.options.getString('type', true);
      const targetId = kind === 'attendance' ? g.config.attendanceChannelId : g.config.inventoryChannelId;
      const channel = await i.guild.channels.fetch(targetId);
      if (!channel?.isTextBased()) throw new Error('ไม่พบห้องหรือบอตไม่มีสิทธิ์เข้าถึง');
      let components, embed;
      if (kind === 'attendance') {
        components = [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('attendance:present').setLabel('✅ มา').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('attendance:late').setLabel('🕒 มาสาย').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('attendance:leave').setLabel('📝 ลา').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('attendance:list-open:0').setLabel('📋 ดูรายชื่อ').setStyle(ButtonStyle.Secondary)
          ),
          new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('attendance:admin:edit').setLabel('🛠 แก้ไขเช็กชื่อ').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('attendance:admin:history').setLabel('📜 ประวัติแก้ไข').setStyle(ButtonStyle.Secondary)
          )
        ];
        embed = new EmbedBuilder().setTitle('📋 [IMT] IMMORTAL • เช็กชื่อรายวัน').setDescription('✅ มา: **18:00–23:59 น.**\n🕒 มาสาย / 📝 ลา: **00:00–23:59 น.** (แจ้งก่อน 18:00 ได้)\nลา 1 วันหรือหลายวันได้สูงสุด 31 วัน พร้อมเหตุผล\nเริ่มนับสายจากเวลาที่ผู้ดูแลตั้ง (เริ่มต้น 20:00 น.)\nต้องยืนยันก่อนบันทึก • ใช้ /history ดูประวัติย้อนหลัง');
      } else {
        components = [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('inventory:open').setLabel('📦 ตรวจของวันนี้').setStyle(ButtonStyle.Success)
        )];
        embed = new EmbedBuilder().setTitle('📦 เช็กของรายวัน').setDescription('กดปุ่ม เลือกรายการ ระบุจำนวนและสภาพ\nรายการมากกว่า 25 ชนิดใช้ /checkitem ได้');
      }
      if (hasLogo) embed.setThumbnail('attachment://IMMORTAL-2.png');
      await channel.send({ embeds: [embed], components, ...(hasLogo ? { files: [logoFile] } : {}), allowedMentions: silent });
      let dashboardNote = '';
      if (kind === 'attendance') {
        try { await refreshDashboard(i.guild); dashboardNote = '\n📋 สร้างรายงานชื่อสมาชิกแบบอัปเดตอัตโนมัติแล้ว'; }
        catch (error) { console.error('สร้างรายงานสดไม่ได้:', error.message); dashboardNote = '\n⚠️ สร้างแผงปุ่มแล้ว แต่สร้างรายงานสดไม่ได้ ให้ตรวจสอบสิทธิ์ห้อง'; }
      }
      return await i.editReply({ content: 'ส่งแผงปุ่มไปยังห้อง ' + channel.toString() + ' แล้ว (สามารถปักหมุดข้อความได้)' + dashboardNote, allowedMentions: silent });
    }
    if (i.commandName === 'delivery') {
      const group = i.options.getSubcommandGroup(false);
      const sub = i.options.getSubcommand();
      if (sub === 'setchannel') {
        if (!manager(i)) throw new Error('เฉพาะผู้ดูแลเซิร์ฟเวอร์');
        configOf(i);
        const channel = i.options.getChannel('channel', true);
        store.setConfig(i.guildId, { deliveryChannelId: channel.id });
        return await i.reply(ep(`กำหนดห้องส่งของเป็น ${channel} แล้ว ใช้ /delivery panel เพื่อส่ง UI ปุ่ม`));
      }
      const g = configOf(i);
      if (group === 'role') {
        if (!manager(i)) throw new Error('เฉพาะผู้ดูแลเซิร์ฟเวอร์');
        if (sub === 'add') {
          const role = i.options.getRole('role', true);
          const roles = store.deliveryRoleAdd(i.guildId, role.id);
          await recordDeliveryLog(i.guildId, 'role_add', { actorId: i.user.id, note: role.name });
          return await i.reply(ep(`เพิ่มยศผู้จัดการส่งของแล้ว: ${role.name}\nตอนนี้มี ${roles.length} ยศ`));
        }
        if (sub === 'remove') {
          const role = i.options.getRole('role', true);
          const roles = store.deliveryRoleRemove(i.guildId, role.id);
          await recordDeliveryLog(i.guildId, 'role_remove', { actorId: i.user.id, note: role.name });
          return await i.reply(ep(`ลบยศผู้จัดการส่งของแล้ว: ${role.name}\nตอนนี้เหลือ ${roles.length} ยศ`));
        }
        const roles = g.deliveryManagerRoleIds || [];
        return await i.reply(ep('👑 **ยศที่สามารถแก้ไข/ยืนยันส่งของ**\n' + (roles.length ? roles.map((id, idx) => `${idx + 1}. <@&${id}>`).join('\n') : 'ยังไม่ได้ตั้ง ยศ Manage Server ยังใช้ได้อยู่')));
      }
      if (group === 'item') {
        requireDeliveryManager(i, g);
        if (sub === 'add') {
          const result = store.deliveryItemUpsert(i.guildId, i.options.getString('name', true), i.options.getInteger('quantity', true), i.options.getString('unit') || 'ชิ้น');
          await recordDeliveryLog(i.guildId, 'item_upsert', { actorId: i.user.id, itemName: result.entry.name, quantity: result.entry.requiredQty, unit: result.entry.unit, note: result.created ? 'created' : 'updated' });
          await refreshDeliveryDashboard(i.guild).catch(e => console.error('รีเฟรชรายงานส่งของหลังแก้ของที่ต้องส่ง:', e.message));
          return await i.reply(ep(`${result.created ? 'เพิ่ม' : 'แก้ไข'}ของที่ต้องส่งแล้ว: ${itemLabel(result.entry.name)} ${Number(result.entry.requiredQty).toLocaleString('en-US')} ${sanitize(result.entry.unit)}`));
        }
        if (sub === 'remove') {
          const removed = store.deliveryItemRemove(i.guildId, i.options.getString('name', true));
          await recordDeliveryLog(i.guildId, 'item_remove', { actorId: i.user.id, itemName: removed.name, quantity: removed.requiredQty, unit: removed.unit });
          await refreshDeliveryDashboard(i.guild).catch(e => console.error('รีเฟรชรายงานส่งของหลังลบของที่ต้องส่ง:', e.message));
          return await i.reply(ep(`ลบของที่ต้องส่งแล้ว: ${itemLabel(removed.name)}`));
        }
        return await i.reply(ep(deliveryRequiredText(g)));
      }
      if (sub === 'panel') {
        if (!manager(i)) throw new Error('เฉพาะผู้ดูแลเซิร์ฟเวอร์');
        await i.deferReply({ flags: MessageFlags.Ephemeral });
        if (!g.config.deliveryChannelId) throw new Error('ตั้งห้องด้วย /delivery setchannel ก่อน');
        const channel = await i.guild.channels.fetch(g.config.deliveryChannelId);
        if (!channel?.isTextBased()) throw new Error('บอตไม่สามารถเข้าห้องส่งของได้');
        const embed = new EmbedBuilder().setTitle('📦 [IMT] IMMORTAL • ห้องส่งของ')
          .setDescription('สมาชิกกดปุ่มรายการที่ต้องส่งเพื่อส่งทันทีโดยไม่ต้องกรอกเอง\nทุกคนตรวจสอบรายการของที่ต้องส่งได้\nผู้มียศสามารถสร้าง/แก้ไขของที่ต้องส่งได้\nเมื่อมีสมาชิกส่งของแล้ว จะมีปุ่ม **✅ ยืนยันรับของ** และ **❌ ไม่รับของ** ใต้รายการนั้นโดยตรง\nหลังรับของแล้วจะมีปุ่มให้เลือก **นำเข้าตู้** หรือ **ไม่ดำเนินการใดๆ**')
          .setColor(0xADB5BD);
        if (hasLogo) embed.setThumbnail('attachment://IMMORTAL-2.png');
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('delivery:items-manage').setLabel('🛠 สร้าง/แก้ไขของที่ต้องส่ง').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId('delivery:items-list').setLabel('📋 ตรวจสอบของที่ต้องส่ง').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId('delivery:checklist').setLabel('📋 เช็คชื่อส่งของ').setStyle(ButtonStyle.Primary)
        );
        const managerRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('delivery:fix:rejected-approved').setLabel('✅ ไม่รับ → รับแล้ว').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId('delivery:fix:approved-rejected').setLabel('❌ รับแล้ว → ไม่รับ').setStyle(ButtonStyle.Danger)
        );
        await channel.send({ embeds: [embed], components: [row, managerRow], ...(hasLogo ? { files: [logoFile] } : {}), allowedMentions: silent });
        await refreshDeliveryDashboard(i.guild);
        return await i.editReply({ content: `ส่ง UI ปุ่มและรายงานสดไปที่ ${channel} แล้ว`, allowedMentions: silent });
      }
      if (sub === 'send') return await beginDelivery(i,
        i.options.getString('name', true), i.options.getInteger('quantity', true), i.options.getString('unit') || 'ชิ้น');
      if (sub === 'report') {
        await i.deferReply({ flags: MessageFlags.Ephemeral });
        const roster = await optionalRoster(i.guild, g.config);
        return await i.editReply({ content: delivery.summary(g, store.today(), roster, g.config.time || '20:00').slice(0, 1900), allowedMentions: silent });
      }
      if (sub === 'history') {
        if (!onlyTeam(i, g)) throw new Error('คุณไม่มีบทบาทสมาชิกทีม');
        const member = i.options.getUser('member');
        return await i.reply(ep(deliveryHistoryTextForGuild(i.guildId, {
          userId: member?.id || null,
          itemName: i.options.getString('item') || null,
          date: i.options.getString('date') || null,
          limit: i.options.getInteger('limit') || 10
        })));
      }
    }
    if (i.commandName === 'locker') {
      const g = configOf(i);
      const group = i.options.getSubcommandGroup(false);
      const sub = i.options.getSubcommand();
      if (group === 'role') {
        if (!manager(i)) throw new Error('เฉพาะผู้ดูแลเซิร์ฟเวอร์');
        if (sub === 'add') {
          const role = i.options.getRole('role', true);
          const roles = store.lockerRoleAdd(i.guildId, role.id);
          await recordDeliveryLog(i.guildId, 'locker_role_add', { actorId: i.user.id, note: role.name });
          return await i.reply(ep(`เพิ่มยศผู้จัดการตู้แก๊งแล้ว: ${role.name}\nตอนนี้มี ${roles.length} ยศ`));
        }
        if (sub === 'remove') {
          const role = i.options.getRole('role', true);
          const roles = store.lockerRoleRemove(i.guildId, role.id);
          await recordDeliveryLog(i.guildId, 'locker_role_remove', { actorId: i.user.id, note: role.name });
          return await i.reply(ep(`ลบยศผู้จัดการตู้แก๊งแล้ว: ${role.name}\nตอนนี้เหลือ ${roles.length} ยศ`));
        }
        const roles = g.lockerManagerRoleIds || [];
        return await i.reply(ep('👑 **ยศที่สามารถแก้ไขตู้แก๊ง**\n' + (roles.length ? roles.map((id, idx) => `${idx + 1}. <@&${id}>`).join('\n') : 'ยังไม่ได้ตั้ง ยศ Manage Server ยังใช้ได้อยู่')));
      }
      if (sub === 'panel') {
        if (!manager(i)) throw new Error('เฉพาะผู้ดูแลเซิร์ฟเวอร์');
        const embed = lockerEmbed(g);
        if (hasLogo) embed.setThumbnail('attachment://IMMORTAL-2.png');
        await i.channel.send({ embeds: [embed], components: lockerButtons(), ...(hasLogo ? { files: [logoFile] } : {}), allowedMentions: silent });
        return await i.reply(ep('สร้าง Dashboard ตู้แก๊งแล้ว'));
      }
      if (sub === 'add') {
        requireLockerManager(i, g);
        const x = store.lockerAdd(i.guildId, i.options.getString('name', true),
          i.options.getInteger('quantity', true), i.options.getString('unit') || 'ชิ้น');
        await recordDeliveryLog(i.guildId, 'locker_add', { actorId: i.user.id, itemName: x.name, quantity: i.options.getInteger('quantity', true), unit: x.unit, note: 'slash command' });
        return await i.reply(ep(`เพิ่มตู้แก๊ง: ${itemLabel(x.name)} ${x.quantity.toLocaleString('en-US')} ${sanitize(x.unit)}`));
      }
      if (sub === 'edit') {
        requireLockerManager(i, g);
        const x = store.lockerEdit(i.guildId, i.options.getString('name', true),
          i.options.getInteger('quantity', true), i.options.getString('unit'), i.options.getString('newname'));
        await recordDeliveryLog(i.guildId, 'locker_edit', { actorId: i.user.id, itemName: x.name, quantity: x.quantity, unit: x.unit, note: 'slash command' });
        return await i.reply(ep(`แก้ไขตู้แก๊ง: ${itemLabel(x.name)} ${x.quantity.toLocaleString('en-US')} ${sanitize(x.unit)}`));
      }
      if (sub === 'remove') {
        requireLockerManager(i, g);
        const qty = i.options.getInteger('quantity');
        const x = store.lockerRemove(i.guildId, i.options.getString('name', true), qty);
        await recordDeliveryLog(i.guildId, 'locker_remove', { actorId: i.user.id, itemName: x.name, quantity: qty || null, unit: x.unit, note: qty ? 'decreased' : 'deleted' });
        return await i.reply(ep(`ลบรายการ ${itemLabel(x.name)} จากตู้แก๊งแล้ว${x.deleted === false ? ` คงเหลือ ${x.quantity.toLocaleString('en-US')} ${sanitize(x.unit)}` : ''}`));
      }
      return await i.reply(ep(lockerSummaryText(store.getGuild(i.guildId))));
    }
    if (i.commandName === 'checkin') return await beginAttendance(i,
      i.options.getString('status', true), i.options.getString('reason') || '',
      i.options.getString('start'), i.options.getString('end'));
    if (i.commandName === 'leave') return await beginAttendance(i, 'leave',
      i.options.getString('reason', true), i.options.getString('start', true), i.options.getString('end'));
    if (i.commandName === 'history') {
      const g = configOf(i);
      if (!onlyTeam(i, g)) throw new Error('เฉพาะสมาชิกแก๊งที่กำหนดเท่านั้น');
      const target = i.options.getUser('member') || i.user;
      if (target.bot) throw new Error('ไม่แสดงประวัติของบอต');
      // เปิดให้สมาชิกดูรายงานในห้องเดียวกันได้ แต่ไม่แทนชื่อหรือแก้ข้อมูลคนอื่น
      await i.deferReply();
      const pages = history.buildHistory(g, target.id, store.today()).pages;
      const embeds = [new EmbedBuilder(pages[0])];
      if (hasLogo) embeds[0].setThumbnail('attachment://IMMORTAL-2.png');
      const message = await i.editReply({ embeds, components: historyButtons(0, pages.length),
        ...(hasLogo ? { files: [logoFile] } : {}), allowedMentions: silent });
      const expiresAt = Date.now() + history.VIEW_MS;
      store.saveHistoryView(i.guildId, { messageId: message.id, channelId: i.channelId,
        userId: i.user.id, targetId: target.id, page: 0, expiresAt });
      scheduleHistoryDelete(i.guildId, message.id, expiresAt, () => i.deleteReply());
      return;
    }
    if (i.commandName === 'item') {
      if (!manager(i)) throw new Error('เฉพาะผู้ดูแลเซิร์ฟเวอร์');
      configOf(i);
      const sub = i.options.getSubcommand();
      if (sub === 'add') {
        const item = store.addItem(i.guildId, i.options.getString('name', true).trim(), i.options.getInteger('quantity', true));
        if (!item.name) { store.removeItem(i.guildId, item.id); throw new Error('ชื่อของต้องไม่ว่าง'); }
        return await i.reply(ep(`เพิ่ม ${itemLabel(item.name)} (ควรมี ${item.requiredQty} ชิ้นต่อคน) แล้ว`));
      }
      if (sub === 'remove') {
        const item = store.removeItem(i.guildId, i.options.getString('name', true));
        return await i.reply(ep('ลบรายการ ' + itemLabel(item.name) + ' แล้ว (ข้อมูลที่เคยตรวจยังเก็บไว้)'));
      }
      const items = store.getGuild(i.guildId).items;
      return await i.reply(ep(items.length ? items.map((x, idx) => `${idx + 1}. ${itemLabel(x.name)} — ${x.requiredQty} ชิ้น`).join('\n').slice(0, 1900) : 'ยังไม่มีรายการของ'));
    }
    if (i.commandName === 'checkitem') return await checkItem(i,
      i.options.getString('name', true), i.options.getInteger('found', true),
      i.options.getString('condition', true), i.options.getString('note') || '');
    if (i.commandName === 'house') {
      const group = i.options.getSubcommandGroup(false);
      const sub = i.options.getSubcommand();
      if (!manager(i) && !(sub === 'list')) throw new Error('เฉพาะผู้ดูแลเซิร์ฟเวอร์');
      if (sub === 'panel') {
        const g = configOf(i);
        const target = i.options.getChannel('channel') || await i.guild.channels.fetch(g.config.attendanceChannelId);
        if (!target?.isTextBased()) throw new Error('ห้องนี้ส่งข้อความไม่ได้');
        const houses = store.houseList(i.guildId);
        if (!houses.length) {
          const embed = new EmbedBuilder().setTitle('🏠 [IMT] IMMORTAL • เช็กชื่อตามบ้าน')
            .setDescription('ยังไม่มีบ้านในระบบ\nให้ใช้ `/house add` แล้วเพิ่มหัวหน้าบ้าน/ลูกบ้านก่อน');
          if (hasLogo) embed.setThumbnail('attachment://IMMORTAL-2.png');
          await target.send({ embeds: [embed], components: housePanelComponents(), ...(hasLogo ? { files: [logoFile] } : {}), allowedMentions: silent });
          return await i.reply(ep(`ส่งแผงเช็กชื่อตามบ้านไปที่ ${target} แล้ว`));
        }
        let sent = 0;
        for (const house of houses) {
          const embed = new EmbedBuilder().setTitle(`🏠 [IMT] IMMORTAL • เช็กชื่อบ้าน ${sanitize(house.name)}`)
            .setDescription(`ระบบนี้ **แยกจากเช็กชื่อปกติ**\nหัวหน้าบ้าน: ${house.leaderId ? `<@${house.leaderId}>` : 'ยังไม่ตั้ง'}\nลูกบ้าน: ${(house.memberIds || []).length} คน\nสถานะในปุ่ม 📋 ดูรายชื่อ จะเชื่อมกับเช็กชื่อบ้านวันนี้: ✅ มา / 🕒 มาสาย / 📝 ลา / ⬜ ยังไม่เช็ก`);
          if (hasLogo) embed.setThumbnail('attachment://IMMORTAL-2.png');
          await target.send({ embeds: [embed], components: housePanelComponents(house.id), ...(hasLogo ? { files: [logoFile] } : {}), allowedMentions: silent });
          sent++;
        }
        return await i.reply(ep(`ส่งแผงเช็กชื่อตามบ้านแบบแยกบ้านไปที่ ${target} แล้ว (${sent} บ้าน)`));
      }
      if (group === 'leader' && sub === 'set') {
        const house = store.houseLeaderSet(i.guildId, i.options.getString('house', true), i.options.getUser('user', true).id);
        return await i.reply(ep(`ตั้งหัวหน้าบ้านแล้ว\nบ้าน: **${sanitize(house.name)}**\nหัวหน้า: <@${house.leaderId}>`));
      }
      if (group === 'member' && sub === 'add') {
        const house = store.houseMemberAdd(i.guildId, i.options.getString('house', true), i.options.getUser('user', true).id);
        return await i.reply(ep(`เพิ่ม/ย้ายลูกบ้านแล้ว\nบ้าน: **${sanitize(house.name)}**\nสมาชิก: ${house.memberIds.map(id => `<@${id}>`).join(', ') || '-'}`));
      }
      if (group === 'member' && sub === 'remove') {
        const house = store.houseMemberRemove(i.guildId, i.options.getString('house', true), i.options.getUser('user', true).id);
        return await i.reply(ep(`เอาลูกบ้านออกแล้ว\nบ้าน: **${sanitize(house.name)}**`));
      }
      if (sub === 'add') {
        const house = store.houseAdd(i.guildId, i.options.getString('name', true));
        return await i.reply(ep(`เพิ่มบ้านแล้ว: 🏠 **${sanitize(house.name)}**`));
      }
      if (sub === 'remove') {
        const house = store.houseRemove(i.guildId, i.options.getString('name', true));
        return await i.reply(ep(`ลบบ้านแล้ว: 🏠 **${sanitize(house.name)}**`));
      }
      if (sub === 'list') {
        const g = store.getGuild(i.guildId);
        return await i.reply(ep('🏠 **รายชื่อบ้าน**\n' + houseListText(g)));
      }
    }


    if (i.commandName === 'profile') {
      const g = configOf(i);
      if (!onlyTeam(i, g) && !manager(i)) throw new Error('เฉพาะสมาชิกแก๊งที่กำหนดเท่านั้น');
      const target = i.options.getUser('member') || i.user;
      let roster = null; try { roster = await optionalRoster(i.guild, g.config); } catch {}
      const text = profileText(g, target.id, roster);
      if (profileLogWebhookUrl) postGenericWebhook(profileLogWebhookUrl, simpleWebhookPayload('IMT Profile Log', `👤 เปิดดูโปรไฟล์ • ${target.username}`, `ผู้เปิดดู: <@${i.user.id}>\nเป้าหมาย: <@${target.id}>`, 0x5865F2), 'profile').catch(console.error);
      return await i.reply(ep(text));
    }
    if (i.commandName === 'discipline') {
      const g = configOf(i);
      if (!manager(i)) throw new Error('เฉพาะผู้ดูแลเซิร์ฟเวอร์');
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      let roster = null; try { roster = await optionalRoster(i.guild, g.config); } catch {}
      const text = disciplineReportText(g, roster, store.today(), 25);
      if (disciplineLogWebhookUrl) postGenericWebhook(disciplineLogWebhookUrl, simpleWebhookPayload('IMT Discipline Log', `🏆 คะแนนวินัย • ${store.today()}`, text, 0xE67E22), 'discipline').catch(console.error);
      return await i.editReply(text);
    }
    if (i.commandName === 'admin') {
      if (!manager(i)) throw new Error('เฉพาะผู้ดูแลเซิร์ฟเวอร์');
      const sub = i.options.getSubcommand();
      const g = configOf(i);
      if (sub === 'panel') {
        if (adminLogWebhookUrl) postGenericWebhook(adminLogWebhookUrl, simpleWebhookPayload('IMT Admin Log', '🧭 เปิด Admin Dashboard', `ผู้สร้าง: <@${i.user.id}>`, 0x34495E), 'admin').catch(console.error);
        return await i.reply({ content: adminDashboardText(), components: adminDashboardComponents(), flags: MessageFlags.Ephemeral, allowedMentions: silent });
      }
      if (sub === 'backup') {
        if (!backupLogWebhookUrl) return await i.reply(ep('ยังไม่ได้ตั้ง BACKUP_LOG_WEBHOOK_URL'));
        await postGenericWebhook(backupLogWebhookUrl, backupPayload(i.guildId, g), 'backup');
        return await i.reply(ep('ส่ง Backup ไปยัง backup_log แล้ว'));
      }
      if (sub === 'weekly') {
        let roster = null; try { roster = await optionalRoster(i.guild, g.config); } catch {}
        const payload = weeklyReportPayload(i.guildId, g, roster, store.today());
        if (weeklyLogWebhookUrl) await postGenericWebhook(weeklyLogWebhookUrl, payload, 'weekly');
        return await i.reply(ep(payload.embeds[0].description));
      }
    }

    if (i.commandName === 'status') {
      const g = configOf(i);
      if (!onlyTeam(i, g)) throw new Error('คุณยังไม่มีบทบาทสมาชิกทีมที่กำหนด');
      const date = store.today(), att = g.attendance[date]?.[i.user.id];
      const checked = g.inventory[date]?.[i.user.id] || {};
      const list = g.items.map(it => `${checked[it.id] ? '✅' : '⬜'} ${sanitize(it.name)}${checked[it.id] ? ` (${checked[it.id].foundQty}/${it.requiredQty})` : ''}`).join('\n');
      return await i.reply(ep(`📆 ${date}\nเช็กชื่อ: ${att ? attendanceNames[att.status] : 'ยังไม่ส่ง'}${att?.reason ? `\nเหตุผล: ${sanitize(att.reason)}` : ''}\nเช็กของ:\n${list || 'ยังไม่มีรายการของ'}`.slice(0, 1900)));
    }
    if (i.commandName === 'report') {
      if (!manager(i)) throw new Error('เฉพาะผู้ดูแลเซิร์ฟเวอร์');
      const g = configOf(i);
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      const texts = await reportsFor(i.guild, g, store.today());
      await i.editReply({ embeds: [texts.privateAttendance], allowedMentions: silent });
      return await i.followUp(ep(texts.inventory));
    }
  } catch (error) {
    console.error('Interaction error:', error);
    const message = '❌ ' + sanitize(error.message || 'เกิดข้อผิดพลาด');
    if (i.isAutocomplete()) { try { await i.respond([]); } catch {} return; }
    if (i.isButton() && (i.customId.startsWith('attendance:confirm:') || i.customId.startsWith('delivery:confirm:')) && i.deferred) {
      await i.editReply({ content: message, components: [], allowedMentions: silent }).catch(console.error);
    } else if (i.deferred && !i.replied) await i.editReply({ content: message, allowedMentions: silent }).catch(console.error);
    else if (i.replied) await i.followUp(ep(message)).catch(console.error);
    else await i.reply(ep(message)).catch(console.error);
  }
});

client.once(Events.ClientReady, c => {
  console.log(`ออนไลน์แล้ว: ${c.user.tag} | วันนี้ ${store.today()} เวลาไทย`);
  cron.schedule('* * * * *', () => {
    dailySummaries().catch(console.error);
    ensureDailyDashboard().catch(console.error);
    snapshotRosterNearMidnight().catch(console.error);
    dailyWebhookSummaries().catch(console.error);
    cleanupHistoryViews().catch(console.error);
    reminderSchedules().catch(console.error);
    weeklyAndBackupSchedules().catch(console.error);
  }, { timezone: 'Asia/Bangkok' });
  dailySummaries().catch(console.error);
  dailyWebhookSummaries().catch(console.error);
  ensureDailyDashboard().catch(console.error);
  cleanupHistoryViews().catch(console.error);
  reminderSchedules().catch(console.error);
  weeklyAndBackupSchedules().catch(console.error);
});
client.login(token).catch(e => { console.error('ล็อกอินบอตไม่สำเร็จ:', e.message); process.exitCode = 1; });
