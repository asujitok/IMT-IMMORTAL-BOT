'use strict';
const { timeBangkok } = require('./store');
const OPEN_TIME = '18:00';
// มา: 18:00-23:59:59; มาสาย/ลา: 00:00-23:59:59 ทุกวัน (รวมแจ้งลาล่วงหน้า)
function isAttendanceOpen(now = new Date()) { return timeBangkok(now) >= OPEN_TIME; }
function isStatusOpen(status, now = new Date()) {
  if (status === 'present') return isAttendanceOpen(now);
  return status === 'late' || status === 'leave';
}
module.exports = { OPEN_TIME, isAttendanceOpen, isStatusOpen };
