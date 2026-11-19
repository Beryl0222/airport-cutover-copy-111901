import test from 'node:test';
import assert from 'node:assert/strict';
import { readInputs } from '../scripts/inspect.mjs';

const data = await readInputs();

test("回执可回查到原发送及对应订座", () => {
  for (const receipt of data.receipts) {
    const message = data.sent.find(item => item.id === receipt.messageId);
    assert.equal(message.bookingId, receipt.bookingId);
    assert.equal(message.channel, receipt.channel);
    assert.ok(data.bookings.some(item => item.id === receipt.bookingId));
    assert.ok(Date.parse(message.sentAt) < Date.parse(receipt.deliveredAt));
    assert.ok(Date.parse(receipt.deliveredAt) <= Date.parse(receipt.observedAt));
  }
  assert.notEqual(data.bookings[0].direction, data.bookings[1].direction);
});
