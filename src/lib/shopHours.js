const DEFAULT_OPEN_TIME = "09:00";
const DEFAULT_CLOSE_TIME = "21:00";
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const WEEK_DAYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
];

function minutesFromTime(value) {
  const match = TIME_RE.exec(String(value || ""));
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function normalizeShopTime(value, fallback) {
  const text = String(value || "").trim();
  return minutesFromTime(text) == null ? fallback : text;
}

function normalizeBusinessHours(input = {}) {
  const open = normalizeShopTime(input.openTime || input.open_time, DEFAULT_OPEN_TIME);
  const close = normalizeShopTime(input.closeTime || input.close_time, DEFAULT_CLOSE_TIME);
  const sourceWeekly = Array.isArray(input.weeklySchedule)
    ? input.weeklySchedule
    : Array.isArray(input.weekly_hours)
    ? input.weekly_hours
    : [];
  const weeklySchedule = normalizeWeeklySchedule(sourceWeekly, open, close);
  return {
    openTime: open,
    closeTime: close,
    timezone: "Asia/Kolkata",
    weeklySchedule,
  };
}

function normalizeWeeklySchedule(rows, fallbackOpen = DEFAULT_OPEN_TIME, fallbackClose = DEFAULT_CLOSE_TIME) {
  const byDay = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const day = String(row?.day || "").trim().toLowerCase();
    if (!WEEK_DAYS.includes(day)) continue;
    const isOpen = row?.isOpen !== false && String(row?.is_open).toLowerCase() !== "false";
    byDay.set(day, {
      day,
      isOpen,
      openTime: normalizeShopTime(row?.openTime || row?.open_time, fallbackOpen),
      closeTime: normalizeShopTime(row?.closeTime || row?.close_time, fallbackClose),
    });
  }
  return WEEK_DAYS.map((day) => {
    return (
      byDay.get(day) || {
        day,
        isOpen: true,
        openTime: fallbackOpen,
        closeTime: fallbackClose,
      }
    );
  });
}

function businessHoursForSeller(seller = {}) {
  return normalizeBusinessHours(seller.businessHours || {});
}

function formatDisplayTime(time) {
  const mins = minutesFromTime(time);
  if (mins == null) return "";
  const hour = Math.floor(mins / 60);
  const minute = mins % 60;
  const period = hour >= 12 ? "PM" : "AM";
  const hour12 = hour % 12 || 12;
  return `${hour12}:${String(minute).padStart(2, "0")} ${period}`;
}

function indiaNowParts(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const byType = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return {
    minutes: Number(byType.hour) * 60 + Number(byType.minute),
    day: String(byType.weekday || "").toLowerCase(),
  };
}

function shopOpenStatus(seller, now = new Date()) {
  const hours = businessHoursForSeller(seller);
  const nowParts = indiaNowParts(now);
  const todayIndex = Math.max(0, WEEK_DAYS.indexOf(nowParts.day));
  const today = (hours.weeklySchedule || [])[todayIndex] || {
    day: nowParts.day || "today",
    isOpen: true,
    openTime: hours.openTime,
    closeTime: hours.closeTime,
  };
  const openMinutes = minutesFromTime(today.openTime);
  const closeMinutes = minutesFromTime(today.closeTime);
  const currentMinutes = nowParts.minutes;
  const openLabel = formatDisplayTime(today.openTime);
  const closeLabel = formatDisplayTime(today.closeTime);
  const hoursLabel = `${openLabel} - ${closeLabel}`;

  if (today.isOpen === false) {
    const next = nextOpenDay(hours.weeklySchedule, todayIndex, currentMinutes);
    return {
      isOpen: false,
      openTime: today.openTime,
      closeTime: today.closeTime,
      timezone: hours.timezone,
      day: today.day,
      hoursLabel: "Closed today",
      weeklySchedule: publicWeeklySchedule(hours.weeklySchedule),
      message: next ? `Shop will open ${next.label} at ${formatDisplayTime(next.openTime)}` : "Shop is closed right now",
      nextOpenLabel: next ? formatDisplayTime(next.openTime) : openLabel,
    };
  }

  if (openMinutes == null || closeMinutes == null || openMinutes === closeMinutes) {
    return {
      isOpen: true,
      openTime: today.openTime,
      closeTime: today.closeTime,
      timezone: hours.timezone,
      day: today.day,
      hoursLabel,
      weeklySchedule: publicWeeklySchedule(hours.weeklySchedule),
      message: `Open now · ${hoursLabel}`,
      nextOpenLabel: openLabel,
    };
  }

  const wrapsMidnight = closeMinutes < openMinutes;
  const isOpen = wrapsMidnight
    ? currentMinutes >= openMinutes || currentMinutes < closeMinutes
    : currentMinutes >= openMinutes && currentMinutes < closeMinutes;

  let next = null;
  if (!isOpen) next = nextOpenDay(hours.weeklySchedule, todayIndex, currentMinutes);

  return {
    isOpen,
    openTime: today.openTime,
    closeTime: today.closeTime,
    timezone: hours.timezone,
    day: today.day,
    hoursLabel,
    weeklySchedule: publicWeeklySchedule(hours.weeklySchedule),
    nextOpenLabel: openLabel,
    message: isOpen
      ? `Open now · closes at ${closeLabel}`
      : `Shop will open ${next ? next.label : "soon"} at ${formatDisplayTime(next ? next.openTime : today.openTime)}`,
  };
}

function nextOpenDay(schedule, todayIndex, currentMinutes) {
  const weekly = Array.isArray(schedule) && schedule.length ? schedule : normalizeWeeklySchedule([]);
  for (let offset = 0; offset < 7; offset += 1) {
    const index = (todayIndex + offset) % 7;
    const row = weekly[index];
    if (!row || row.isOpen === false) continue;
    const openMinutes = minutesFromTime(row.openTime);
    if (openMinutes == null) continue;
    if (offset === 0 && currentMinutes >= openMinutes) continue;
    return {
      day: row.day,
      openTime: row.openTime,
      label: offset === 0 ? "today" : offset === 1 ? "tomorrow" : `on ${titleDay(row.day)}`,
    };
  }
  return null;
}

function titleDay(day) {
  const text = String(day || "");
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : "the next open day";
}

function publicWeeklySchedule(schedule) {
  return normalizeWeeklySchedule(schedule).map((row) => ({
    day: row.day,
    is_open: row.isOpen !== false,
    open_time: row.openTime,
    close_time: row.closeTime,
    label: row.isOpen === false ? "Closed" : `${formatDisplayTime(row.openTime)} - ${formatDisplayTime(row.closeTime)}`,
  }));
}

function ensureShopOpen(seller, now = new Date()) {
  const status = shopOpenStatus(seller, now);
  if (status.isOpen) return null;
  const err = new Error(status.message);
  err.status = 400;
  err.code = "SHOP_CLOSED";
  err.shop_open_status = status;
  return err;
}

function publicBusinessHours(seller, now = new Date()) {
  const status = shopOpenStatus(seller, now);
  return {
    open_time: status.openTime,
    close_time: status.closeTime,
    timezone: status.timezone,
    label: status.hoursLabel,
    is_open: status.isOpen,
    message: status.message,
    next_open_label: status.nextOpenLabel,
    day: status.day,
    weekly_hours: status.weeklySchedule,
  };
}

module.exports = {
  DEFAULT_OPEN_TIME,
  DEFAULT_CLOSE_TIME,
  WEEK_DAYS,
  normalizeBusinessHours,
  shopOpenStatus,
  ensureShopOpen,
  publicBusinessHours,
};
