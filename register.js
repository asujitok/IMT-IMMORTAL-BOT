'use strict';
require('dotenv').config();
const { REST, Routes } = require('discord.js');
const commands = require('./src/commands');
const { DISCORD_TOKEN, CLIENT_ID, GUILD_ID } = process.env;
if (![DISCORD_TOKEN, CLIENT_ID, GUILD_ID].every(Boolean)) {
  throw new Error('กรุณาตั้งค่า DISCORD_TOKEN, CLIENT_ID และ GUILD_ID ในไฟล์ .env');
}
new REST({ version: '10' }).setToken(DISCORD_TOKEN)
  .put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands })
  .then(() => console.log('ติดตั้งคำสั่งสำเร็จ:', commands.map(c => '/' + c.name).join(', ')))
  .catch(error => { console.error('ติดตั้งคำสั่งไม่สำเร็จ:', error); process.exitCode = 1; });
