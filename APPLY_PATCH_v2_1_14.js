'use strict';
const fs = require('node:fs');
const path = require('node:path');

const indexPath = path.join(process.cwd(), 'src', 'index.js');
if (!fs.existsSync(indexPath)) {
  console.error('ไม่พบ src/index.js กรุณารันไฟล์นี้จากโฟลเดอร์หลักของโปรเจกต์');
  process.exit(1);
}

let text = fs.readFileSync(indexPath, 'utf8');
let changed = false;

function replaceOnce(label, search, replacement) {
  if (text.includes(search)) {
    text = text.replace(search, replacement);
    console.log('✅', label);
    changed = true;
  } else {
    console.log('ℹ️ ข้าม:', label, '(ไม่พบ pattern หรือเคยแก้แล้ว)');
  }
}

// 1) dailySummaries เดิมเริ่มสรุปหลังเวลา config.time เช่น 20:00
//    เปลี่ยนเป็นสรุปเฉพาะ 23:59 เวลาไทยตามนโยบายใหม่
replaceOnce(
  'เปลี่ยน dailySummaries ให้ทำงานเฉพาะเวลา 23:59',
  "if (!g?.config || now < (g.config.time || '20:00')) continue;",
  "if (!g?.config || now !== '23:59') continue;"
);

// 2) กัน delivery summary ถูกส่งเร็วกว่า 23:59 ในข้อความ/คอมเมนต์เดิม ถ้ามี
replaceOnce(
  'เพิ่มคอมเมนต์นโยบาย reset รายวัน',
  "let summarizing = false;\nasync function dailySummaries() {",
  "// v2.1.14 Daily Policy\n// - สรุปเช็กชื่อปกติ / ส่งของ / บ้าน ตอน 23:59 เท่านั้น\n// - สถานะรายวันเริ่มใหม่ตามวันที่ใหม่เอง เพราะเก็บข้อมูลแยกตาม date\n// - ห้ามลบรายชื่อสมาชิก, ลูกบ้าน, หัวหน้าบ้าน, รายการของที่ต้องส่ง, ของในตู้, แต้มสะสม และประวัติ\nlet summarizing = false;\nasync function dailySummaries() {"
);

// 3) เพิ่ม helper log ชัดเจนตอนบอตออนไลน์ ว่าระบบใช้ 23:59
replaceOnce(
  'เพิ่ม console policy ตอนออนไลน์',
  "console.log(`ออนไลน์แล้ว: ${c.user.tag} | วันนี้ ${store.today()} เวลาไทย`);",
  "console.log(`ออนไลน์แล้ว: ${c.user.tag} | วันนี้ ${store.today()} เวลาไทย`);\n  console.log('Daily policy: summaries at 23:59 Asia/Bangkok; daily statuses reset by date; master lists/items are kept.');"
);

if (!changed) {
  console.log('ไม่มีการแก้ไข อาจเป็นเวอร์ชันที่แก้ไว้แล้ว');
} else {
  fs.writeFileSync(indexPath, text, 'utf8');
  console.log('\nเสร็จแล้ว: แก้ src/index.js แล้ว');
  console.log('ขั้นต่อไป: commit changes แล้ว Railway redeploy');
}
