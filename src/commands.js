'use strict';
const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const admin = PermissionFlagsBits.ManageGuild;
module.exports = [
  new SlashCommandBuilder().setName('setup').setDescription('ผู้ดูแล: ตั้งค่าห้องรายงาน บทบาทสมาชิก และเวลาสรุป')
    .setDefaultMemberPermissions(admin)
    .addChannelOption(o => o.setName('attendance').setDescription('ห้องเช็กชื่อ').addChannelTypes(ChannelType.GuildText).setRequired(true))
    .addChannelOption(o => o.setName('inventory').setDescription('ห้องเช็กของ').addChannelTypes(ChannelType.GuildText).setRequired(true))
    .addRoleOption(o => o.setName('role').setDescription('บทบาทสมาชิกที่ต้องเช็กชื่อ').setRequired(true))
    .addStringOption(o => o.setName('time').setDescription('เวลาสรุปและเริ่มนับสาย เช่น 20:00').setRequired(false))
    .addChannelOption(o => o.setName('delivery').setDescription('ห้องส่งของใหม่ (ไม่บังคับ ถ้าตั้งไว้แล้ว)').addChannelTypes(ChannelType.GuildText)),
  new SlashCommandBuilder().setName('panel').setDescription('ผู้ดูแล: ส่งแผงปุ่มกดเช็กชื่อหรือเช็กของ')
    .setDefaultMemberPermissions(admin)
    .addStringOption(o => o.setName('type').setDescription('ประเภทแผงปุ่ม').setRequired(true)
      .addChoices({ name: 'เช็กชื่อ', value: 'attendance' }, { name: 'เช็กของ', value: 'inventory' })),
  new SlashCommandBuilder().setName('checkin').setDescription('เช็กชื่อวันนี้ด้วยบัญชี Discord ของตนเอง')
    .addStringOption(o => o.setName('status').setDescription('สถานะ').setRequired(true)
      .addChoices({ name: 'มา', value: 'present' }, { name: 'มาสาย', value: 'late' }, { name: 'ลา', value: 'leave' }))
    .addStringOption(o => o.setName('reason').setDescription('เหตุผลกรณีมาสายหรือลา (ถ้าไม่ใส่ จะมีช่องให้กรอก)').setMaxLength(250))
    .addStringOption(o => o.setName('start').setDescription('เฉพาะลา: วันแรก เช่น 22/09/2569 หรือ 2026-09-22'))
    .addStringOption(o => o.setName('end').setDescription('เฉพาะลา: วันสุดท้าย เว้นว่างคือวันแรก')),
  new SlashCommandBuilder()  .setName('leave').setDescription('แจ้งลาวันเดียวหรือหลายวัน พร้อมเหตุผล').addStringOption(o => o
    .addStringOption(o => o.setName('start').setDescription('วันเริ่มลา เช่น 26/09/2569 หรือ 2026-09-26').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('วันสุดท้าย เว้นว่างคือวันแรก'))
    .addStringOption(o => o.setName('end').setDescription('เหตุผลการลา (3–250 ตัวอักษร)').setRequired(true).setMinLength(3).setMaxLength(250)),
  new SlashCommandBuilder().setName('history').setDescription('ดูประวัติเช็กชื่อ ส่งในห้อง 5 นาทีแล้วลบอัตโนมัติ')
    .addUserOption(o => o.setName('member').setDescription('สมาชิกที่ต้องการดู ไม่เลือกคือดูตนเอง')),
  new SlashCommandBuilder().setName('item').setDescription('ผู้ดูแล: จัดการรายการของที่ต้องตรวจ')
    .setDefaultMemberPermissions(admin)
    .addSubcommand(s => s.setName('add').setDescription('เพิ่มของที่ต้องตรวจ')
      .addStringOption(o => o.setName('name').setDescription('ชื่อของ').setRequired(true).setMaxLength(80))
      .addIntegerOption(o => o.setName('quantity').setDescription('จำนวนที่ควรมีต่อสมาชิก').setRequired(true).setMinValue(0).setMaxValue(1000000)))
    .addSubcommand(s => s.setName('remove').setDescription('ลบรายการของ (ประวัติเดิมยังอยู่)')
      .addStringOption(o => o.setName('name').setDescription('เลือกรายการ').setRequired(true).setAutocomplete(true)))
    .addSubcommand(s => s.setName('list').setDescription('แสดงรายการของทั้งหมด')),
  new SlashCommandBuilder().setName('checkitem').setDescription('ตรวจของรายวัน โดยอ้างอิงบัญชี Discord ของคุณ')
    .addStringOption(o => o.setName('name').setDescription('รายการของ').setRequired(true).setAutocomplete(true))
    .addIntegerOption(o => o.setName('found').setDescription('จำนวนที่ตรวจพบ').setRequired(true).setMinValue(0).setMaxValue(1000000))
    .addStringOption(o => o.setName('condition').setDescription('สภาพของ').setRequired(true)
      .addChoices({ name: 'ปกติ', value: 'normal' }, { name: 'ชำรุด', value: 'damaged' }, { name: 'สูญหาย', value: 'lost' }))
    .addStringOption(o => o.setName('note').setDescription('หมายเหตุ (ถ้ามี)').setMaxLength(250)),
  new SlashCommandBuilder().setName('delivery').setDescription('ระบบห้องส่งของ [IMT] IMMORTAL')
    .addSubcommand(s => s.setName('setchannel').setDescription('ผู้ดูแล: กำหนดห้องส่งของ')
      .addChannelOption(o => o.setName('channel').setDescription('ห้อง #ส่งของ').addChannelTypes(ChannelType.GuildText).setRequired(true)))
    .addSubcommand(s => s.setName('panel').setDescription('ผู้ดูแล: สร้างปุ่มส่งของและรายงานสด'))
    .addSubcommand(s => s.setName('send').setDescription('สมาชิก: แจ้งส่งของ ต้องยืนยันก่อนบันทึก')
      .addStringOption(o => o.setName('name').setDescription('ชื่อของ เช่น เงิน หรือ หิน').setRequired(true).setMaxLength(80))
      .addIntegerOption(o => o.setName('quantity').setDescription('จำนวนที่ส่ง เช่น 1000000').setRequired(true).setMinValue(1).setMaxValue(1000000000000)))
    .addSubcommand(s => s.setName('report').setDescription('ดูรายงานส่งของวันนี้')),
  new SlashCommandBuilder().setName('locker').setDescription('ผู้ดูแล: จัดการตู้แก๊งส่วนกลาง')
    .setDefaultMemberPermissions(admin)
    .addSubcommand(s => s.setName('add').setDescription('เพิ่มของและจำนวนเข้าตู้แก๊ง')
      .addStringOption(o => o.setName('name').setDescription('ชื่อของ').setRequired(true).setMaxLength(80))
      .addIntegerOption(o => o.setName('quantity').setDescription('จำนวน').setRequired(true).setMinValue(0))
      .addStringOption(o => o.setName('unit').setDescription('หน่วย เช่น ชิ้น หรือ หน่วย')))
    .addSubcommand(s => s.setName('edit').setDescription('ตั้งจำนวนใหม่และหน่วยของตู้แก๊ง')
      .addStringOption(o => o.setName('name').setDescription('ชื่อของเดิม').setRequired(true))
      .addIntegerOption(o => o.setName('quantity').setDescription('จำนวนใหม่').setRequired(true).setMinValue(0))
      .addStringOption(o => o.setName('unit').setDescription('หน่วยใหม่ (ไม่บังคับ)')))
    .addSubcommand(s => s.setName('remove').setDescription('ลบรายการจากตู้แก๊ง')
      .addStringOption(o => o.setName('name').setDescription('ชื่อของ').setRequired(true)))
    .addSubcommand(s => s.setName('list').setDescription('ดูตู้แก๊งส่วนกลาง')),
  new SlashCommandBuilder().setName('status').setDescription('ดูสถานะเช็กชื่อและเช็กของวันนี้ของตนเอง'),
  new SlashCommandBuilder().setName('report').setDescription('ผู้ดูแล: ดูสรุปของวันนี้')
    .setDefaultMemberPermissions(admin)
].map(c => c.toJSON());
