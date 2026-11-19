import test from 'node:test';
import assert from 'node:assert/strict';
import { readInputs } from '../scripts/inspect.mjs';

const data = await readInputs();

test("现场标牌、问路记录与通道封闭可回查", () => {
  const ids = new Set(data.signs.map(item => item.id));
  for (const corridor of data.corridors) assert.ok(ids.has(corridor.from) && ids.has(corridor.to));
  for (const notice of data.closures) assert.ok(data.corridors.some(item => item.id === notice.corridor));
  assert.ok(data.signs.filter(sign => sign.zh === '东换乘').length > 1);
  assert.ok(data.sessions.every(session => ids.has(session.lastConfirmedSign)));
});
