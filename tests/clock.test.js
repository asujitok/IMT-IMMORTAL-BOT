'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {isAttendanceOpen,OPEN_TIME} = require('../src/clock');
const {lateMinutes,bangkokClock,attendanceEmbed} = require('../src/report');
test('เปิดเช็กตั้งแต่ 18:00 ถึงก่อนเที่ยงคืนตามเวลาไทย',()=>{
 assert.equal(OPEN_TIME,'18:00');
 assert.equal(isAttendanceOpen(new Date('2026-09-25T10:59:00Z')),false);
 assert.equal(isAttendanceOpen(new Date('2026-09-25T11:00:00Z')),true);
 assert.equal(isAttendanceOpen(new Date('2026-09-25T16:59:00Z')),true);
 assert.equal(isAttendanceOpen(new Date('2026-09-25T17:01:00Z')),false);
});
test('มา 20:00 ไม่สาย / 20:01 สาย 1 นาที / 20:10 สาย 10 นาที',()=>{
 const b=iso=>'2026-09-25T'+iso+'Z';
 assert.equal(bangkokClock(b('13:01:30')),'20:01');
 assert.equal(lateMinutes(b('13:00:55')),0);
 assert.equal(lateMinutes(b('13:01:55')),1);
 assert.equal(lateMinutes(b('13:10:00')),10);
 const g={config:{time:'20:00'}, attendance:{'2026-09-25':{'a':{status:'present',at:b('13:01:30')},'b':{status:'present',at:b('13:10:00')}}}};
 const report=attendanceEmbed(g,'2026-09-25');
 assert.match(report.fields[0].value,/a> เวลา 20:01 สาย 1 นาที/);
 assert.match(report.fields[0].value,/b> เวลา 20:10 สาย 10 นาที/);
});
