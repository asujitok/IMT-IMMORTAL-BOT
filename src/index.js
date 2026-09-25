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
if (!token || token === 'PUT_YOUR_BOT_TOKEN_HERE') {
  console.error('กรุณาใส่ DISCORD_TOKEN ในไฟล์ .env');
  process.exit(1);
}
// สมัครใช้ GuildMembers เฉพาะเมื่อเปิดสิทธิ์ SERVER MEMBERS INTENT ที่หน้า Discord แล้ว
const hasMemberIntent = process.env.ENABLE_MEMBERS_INTENT === 'true';
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildMessageReactions,
    ...(hasMemberIntent ? [GatewayIntentBits.GuildMembers] : [])],
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
function onlyTeam(i, g) {
  const roles = i.member?.roles;
  return i.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ||
    Boolean(g?.config && (roles?.cache?.has(g.config.roleId) || roles?.includes?.(g.config.roleId)));
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
async function optionalRoster(guild, config) {
  if (!hasMemberIntent) return null;
  try {
    const members = await guild.members.fetch();
    return [...members.values()].filter(m => !m.user.bot && m.roles.cache.has(config.roleId));
  } catch (error) {
    console.error('อ่านสมาชิกเพื่อรายงานไม่ได้ จึงแสดงเฉพาะผู้เช็กชื่อ:', error.message);
    return null;
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
function lockerSummaryText(g) {
  const summary = store.lockerSummary(g);
  const rows = summary.rows;
  const lines = rows.length ? rows.map((x, idx) => `${idx + 1}. ${itemLabel(x.name)} — ${Number(x.quantity || 0).toLocaleString('en-US')} ${sanitize(x.unit || 'ชิ้น')}`) : ['ยังไม่มีของในตู้'];
  return `📦 **[IMT] IMMORTAL — ตู้แก๊ง**\n\n` +
    `📋 จำนวนรายการทั้งหมด: **${summary.totalItems.toLocaleString('en-US')} รายการ**\n` +
    `💰 มูลค่าเงินรวม: **${summary.moneyTotal.toLocaleString('en-US')} บาท**\n\n` + lines.join('\n');
}
function lockerEmbed(g) {
  const summary = store.lockerSummary(g);
  const list = summary.rows.length ? summary.rows.map((x, idx) => `${idx + 1}. ${itemLabel(x.name)} — **${Number(x.quantity || 0).toLocaleString('en-US')}** ${sanitize(x.unit || 'ชิ้น')}`).join('\n') : 'ยังไม่มีของในตู้';
  return new EmbedBuilder()
    .setTitle('📦 [IMT] IMMORTAL • Dashboard ตู้แก๊ง')
    .setDescription(`📋 จำนวนรายการทั้งหมด: **${summary.totalItems.toLocaleString('en-US')} รายการ**\n💰 มูลค่าเงินรวม: **${summary.moneyTotal.toLocaleString('en-US')} บาท**`)
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
  if (!onlyTeam(i, g)) throw new Error('คุณไม่มีบทบาทสมาชิกทีม');
  if (!g.config.deliveryChannelId) throw new Error('ยังไม่ได้กำหนดห้องส่งของ ให้ผู้ดูแลใช้ /delivery setchannel ก่อน');
  const item = delivery.prepare(i.guildId, i.user.id, name, quantity, store.today(), unit || 'ชิ้น');
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`delivery:confirm:${item.id}`).setStyle(ButtonStyle.Success).setLabel('ยืนยันส่งของ'),
    new ButtonBuilder().setCustomId(`delivery:cancel:${item.id}`).setStyle(ButtonStyle.Danger).setLabel('ยกเลิก'));
  return await i.reply({ ...ep(`🧾 **ตรวจสอบก่อนส่ง (ยังไม่บันทึก)**\nผู้ส่ง: <@${i.user.id}>\nชื่อของ: **${itemLabel(item.name)}**\nจำนวน: **${item.quantity.toLocaleString('en-US')} ${sanitize(item.unit)}**\n\nเมื่อยืนยันแล้วผู้มียศต้องกดปุ่ม **✅ ยืนยันรับของ** หรือ **❌ ไม่รับของ**`), components: [row] });
}
async function confirmDelivery(i, id) {
  const g = configOf(i);
  if (!onlyTeam(i, g)) throw new Error('คุณไม่มีบทบาทสมาชิกทีม');
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
      if (i.customId === 'delivery:items-manage') {
        const g = configOf(i);
        requireDeliveryManager(i, g);
        return await i.showModal(deliveryItemModal());
      }
      if (i.customId === 'delivery:items-list') {
        const g = configOf(i);
        if (!onlyTeam(i, g)) throw new Error('คุณไม่มีบทบาทสมาชิกทีม');
        return await i.reply({ ...ep(deliveryRequiredText(g) + ((g.deliveryItems || []).length ? '\n\nกดปุ่มรายการด้านล่างเพื่อส่งของตามจำนวนที่กำหนดได้ทันที โดยไม่ต้องกรอกชื่อ/จำนวนเอง' : '')), components: deliveryRequiredComponents(g) });
      }
      if (i.customId === 'delivery:history') {
        const g = configOf(i);
        if (!onlyTeam(i, g)) throw new Error('คุณไม่มีบทบาทสมาชิกทีม');
        return await i.reply(ep(deliveryHistoryTextForGuild(i.guildId, { limit: 10 })));
      }
      if (i.customId === 'delivery:pending') {
        const g = configOf(i);
        requireDeliveryManager(i, g);
        const rows = delivery.list(g, store.today()).filter(x => x.status === 'pending');
        const text = rows.length ? rows.slice(0, 20).map(x => `${x.seq}. <@${x.userId}> — ${itemLabel(x.name)} ${x.quantity.toLocaleString('en-US')} ${sanitize(x.unit || 'ชิ้น')}`).join('\n') : 'ไม่มีรายการรอตรวจ';
        return await i.reply(ep('✅ **รายการรอยืนยันวันนี้**\n' + text + '\n\nให้กดปุ่ม ✅ หรือ ❌ ใต้ข้อความรายการนั้นโดยตรง'));
      }
      if (i.customId === 'delivery:open') {
        const g = configOf(i);
        if (!onlyTeam(i, g)) throw new Error('คุณไม่มีบทบาทสมาชิกทีม');
        if (!g.config.deliveryChannelId) throw new Error('ยังไม่ได้ตั้งห้องส่งของ');
        return await i.showModal(deliveryModal());
      }
      if (i.customId.startsWith('delivery:reqsend:')) {
        const g = configOf(i);
        if (!onlyTeam(i, g)) throw new Error('คุณไม่มีบทบาทสมาชิกทีม');
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
        components = [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('attendance:present').setLabel('✅ มา').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId('attendance:late').setLabel('🕒 มาสาย').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId('attendance:leave').setLabel('📝 ลา').setStyle(ButtonStyle.Secondary)
        )];
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
          new ButtonBuilder().setCustomId('delivery:items-list').setLabel('📋 ตรวจสอบของที่ต้องส่ง').setStyle(ButtonStyle.Secondary)
        );
        await channel.send({ embeds: [embed], components: [row], ...(hasLogo ? { files: [logoFile] } : {}), allowedMentions: silent });
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
    cleanupHistoryViews().catch(console.error);
  }, { timezone: 'Asia/Bangkok' });
  dailySummaries().catch(console.error);
  ensureDailyDashboard().catch(console.error);
  cleanupHistoryViews().catch(console.error);
});
client.login(token).catch(e => { console.error('ล็อกอินบอตไม่สำเร็จ:', e.message); process.exitCode = 1; });
