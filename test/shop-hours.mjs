import assert from "node:assert/strict";
import test from "node:test";
import shopHours from "../src/lib/shopHours.js";

test("shopOpenStatus reports open during configured hours", () => {
  const seller = { businessHours: { openTime: "09:00", closeTime: "21:00" } };
  const status = shopHours.shopOpenStatus(seller, new Date("2026-06-04T07:00:00.000Z"));
  assert.equal(status.isOpen, true);
  assert.equal(status.message, "Open now · closes at 9:00 PM");
});

test("shopOpenStatus reports today before opening and tomorrow after closing", () => {
  const seller = { businessHours: { openTime: "09:00", closeTime: "21:00" } };
  const beforeOpen = shopHours.shopOpenStatus(seller, new Date("2026-06-04T02:00:00.000Z"));
  const afterClose = shopHours.shopOpenStatus(seller, new Date("2026-06-04T18:00:00.000Z"));
  assert.equal(beforeOpen.isOpen, false);
  assert.equal(beforeOpen.message, "Shop will open today at 9:00 AM");
  assert.equal(afterClose.isOpen, false);
  assert.equal(afterClose.message, "Shop will open tomorrow at 9:00 AM");
});

test("shopOpenStatus supports different weekly hours and closed days", () => {
  const seller = {
    businessHours: {
      openTime: "09:00",
      closeTime: "21:00",
      weeklySchedule: [
        { day: "thursday", isOpen: false, openTime: "09:00", closeTime: "21:00" },
        { day: "friday", isOpen: true, openTime: "11:00", closeTime: "19:00" },
      ],
    },
  };
  const status = shopHours.shopOpenStatus(seller, new Date("2026-06-04T07:00:00.000Z"));
  assert.equal(status.isOpen, false);
  assert.equal(status.message, "Shop will open tomorrow at 11:00 AM");
});
