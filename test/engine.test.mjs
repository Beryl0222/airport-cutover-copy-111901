import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { RerouteService } from '../src/app.mjs';
import { codePointLength } from '../src/render.mjs';

const data = JSON.parse(await readFile(new URL('../data/inputs.json', import.meta.url), 'utf8'));
const make = () => new RerouteService(data);

test('图模型：封闭边不可通行，重开后恢复', async () => {
  const service = make();
  assert.ok(service.model.edgeAllowed('R3') === false, 'C1 使 R3 初始封闭');
  await service.reopenCorridor('C1');
  assert.ok(service.model.edgeAllowed('R3') === true);
  await service.submitClosure({ id: 'C9', corridor: 'R5', notice: '临时封闭' });
  assert.ok(service.model.isClosed('R5'));
  await assert.rejects(
    () => service.submitClosure({ id: 'C10', corridor: 'RX', notice: 'x' }),
    /未知通道/,
  );
});

test('同名地标在楼层未决时不得猜，旅客报楼层后才能确认', async () => {
  const service = make();
  service.createSession('S1');
  let r = await service.ask('S1', '看到了东换乘，要去地面巴士。', { persist: false });
  assert.equal(r.response.kind, 'question');
  assert.equal(r.response.questionCode, 'same-name-sign');
  assert.deepEqual(r.response.candidates, ['D14', 'D24']);
  assert.equal(service.getSession('S1').position.kind, 'ambiguous');

  r = await service.ask('S1', '我在二层。', { persist: false });
  assert.equal(r.response.kind, 'instruction');
  assert.equal(service.getSession('S1').position.signId, 'D24');
  assert.equal(service.getSession('S1').position.kind, 'confirmed');
});

test('目的地标牌不会被当成当前位置', async () => {
  const service = make();
  service.createSession('S2');
  const r = await service.ask('S2', 'I need the coaches. No steps please.', { persist: false });
  assert.equal(service.getSession('S2').position, null);
  assert.equal(r.response.kind, 'question');
  assert.equal(r.response.questionCode, 'need-position');
});

test('硬性无阶差无路时不引导有阶差路线，转为现场等候/求助', async () => {
  const service = make();
  service.createSession('S3');
  await service.ask('S3', '我在看见巴士图案的东换乘，要去地面巴士。', { persist: false });
  assert.equal(service.getSession('S3').position.signId, 'D14');
  const r = await service.ask('S3', '还是不能走楼梯。', { persist: false });
  assert.equal(r.response.kind, 'help');
  // 一层 D14 到服务台无路径时应原地等候，而不是给含阶差的 R7。
  assert.ok(['askHelp', 'stay'].includes(r.response.action.type));
});

test('带行李是软偏好：可走但如实标注，与硬性无阶差区分', async () => {
  const service = make();
  service.createSession('S4');
  const r = await service.ask('S4', '我在看见巴士图案的东换乘，找地面巴士，带行李。', { persist: false });
  assert.equal(r.response.kind, 'instruction');
  assert.equal(r.response.action.corridorId, 'R7');
  assert.ok(r.response.warnings.includes('softAvoidUnavoidable'));
  assert.equal(service.getSession('S4').accessibility, 'softAvoidEscalator');
});

test('第一步不一致时只问现场标识，不替旅客选路', async () => {
  const service = make();
  service.createSession('S5');
  // 二层 D24 到 T18 有 R4/R1 两条第一步不同的路（R3 初始封闭，仅 R4 通；先重开 R3 制造分叉）。
  await service.reopenCorridor('C1');
  const r = await service.ask('S5', '我在二层，东换乘，要去地面巴士，带行李。', { persist: false });
  assert.equal(r.response.kind, 'question');
  assert.equal(r.response.questionCode, 'first-step-diverges');
  assert.ok(r.response.candidates.length >= 2);
});

test('第一步一致时只给这一步，且位置不提前跳到下一节点', async () => {
  const service = make();
  service.createSession('S6');
  await service.ask('S6', '我在二层，东换乘，全程无阶差，去地面巴士。', { persist: false });
  const session = service.getSession('S6');
  assert.equal(session.position.signId, 'D24');
  assert.equal(session.activeInstruction.expectedSign, 'L23');
  // 旅客亲眼读到下一块牌后才推进，并把后续位置保持为推断。
  const r = await service.ask('S6', '我看到 L23 了。', { persist: false });
  assert.equal(r.response.action.corridorId, 'R5');
  assert.equal(session.position.kind, 'confirmed');
  assert.equal(session.position.signId, 'L23');
});

test('相反线索可纠正推断；标牌编号是最高证据', async () => {
  const service = make();
  service.createSession('S7');
  await service.ask('S7', '我在二层，东换乘，要去地面巴士。', { persist: false });
  await service.ask('S7', '我看到的是没开门的那个。', { persist: false });
  const before = service.getSession('S7').position.signId;
  const r = await service.ask('S7', '不对，我现在读到的标牌是 D14。', { persist: false });
  assert.notEqual(before, 'D14');
  assert.equal(service.getSession('S7').position.signId, 'D14');
  assert.equal(service.getSession('S7').position.kind, 'confirmed');
  assert.equal(r.response.action.corridorId, 'R7');
});

test('系统绝不替旅客确认过闸：不确定时挂起，明确未过闸才放行', async () => {
  const service = make();
  service.createSession('S8');
  await service.reopenCorridor('C1');
  await service.ask('S8', '我在二层，东换乘，全程无阶差，去地面巴士。', { persist: false });
  // 让 R4 不可用，使替代路线第一步必须过闸 R1->G21。
  await service.submitClosure({ id: 'C8', corridor: 'R4', notice: '检修' });
  await service.ask('S8', '我在二层。', { persist: false });
  const uncertain = await service.ask('S8', '我应该已经过闸了吧？', { persist: false });
  assert.equal(uncertain.response.kind, 'question');
  assert.equal(uncertain.response.questionCode, 'oneway-gate');
  assert.ok(service.getSession('S8').pendingGate, '不确定过闸必须保持挂起');

  const cleared = await service.ask('S8', '我还没过闸，就在闸口前面。', { persist: false });
  assert.equal(cleared.response.kind, 'instruction');
  assert.equal(cleared.response.action.signId, 'G21');
  assert.equal(service.getSession('S8').pendingGate, null);
});

test('通道封闭后旧指引作废，重开时给出取消与替代，且保留已确认进度', async () => {
  const service = make();
  service.createSession('S9');
  await service.ask('S9', '我在二层，东换乘，全程无阶差，去地面巴士。', { persist: false });
  const issued = service.audit.issuedInstructions('S9');
  assert.equal(issued.at(-1).edgeId, 'R4');

  await service.reopenCorridor('C1');
  const reverify = await service.submitClosure({ id: 'C9', corridor: 'R4', notice: '西侧检修' });
  const cancelled = reverify.find((item) => item.sessionId === 'S9');
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.reason.corridorId, 'R4');

  // 取消与替代随旅客再次打开时的第一条可执行指引一次性下发。
  const reopened = await service.ask('S9', '我在二层。', { persist: false });
  const next = reopened.response;
  assert.equal(next.kind, 'instruction');
  assert.equal(next.action.corridorId, 'R1');
  assert.ok(next.cancelled, '替代指引必须携带取消信息');
  assert.equal(next.cancelled.reason.corridorId, 'R4');
  // 取消信息只下发一次。
  assert.equal(service.getSession('S9').lastCancellation, null);
});

test('已确认安全走过的边在再核对中保留', async () => {
  const service = make();
  service.createSession('S10');
  await service.ask('S10', '我在二层，东换乘，全程无阶差，去地面巴士。', { persist: false });
  await service.ask('S10', '我看到 L23 了。', { persist: false });
  assert.deepEqual(service.getSession('S10').history, ['R4']);
  await service.submitClosure({ id: 'C10', corridor: 'R5', notice: '检修' });
  const record = service.audit.cancelledInstructions('S10').at(-1);
  assert.deepEqual(record.safeHistory, ['R4']);
});

test('换语言后当前建议仍是同一动作', async () => {
  const service = make();
  service.createSession('S11');
  await service.ask('S11', '我在二层，东换乘，要去地面巴士，带行李。', { persist: false });
  await service.ask('S11', '我看到 L23 了。', { persist: false });
  const result = service.switchLanguage('S11', 'en');
  assert.equal(result.consistency.consistent, true);
  assert.equal(result.rendered.lang, 'en');
  assert.match(result.rendered.text, /R5/);
});

test('渠道码点预算：手机可含原因，小屏分步且保留楼层/无障碍事实', async () => {
  const service = make();
  service.createSession('S12');
  await service.ask('S12', '我在二层，东换乘，全程无阶差，去地面巴士。', { persist: false });
  const response = service.engine.advise(service.getSession('S12'));
  for (const channel of data.channels) {
    const rendered = service.renderResponse(response, channel.id);
    if (channel.id === 'phone') {
      assert.ok(codePointLength(rendered.text) <= channel.max);
      assert.match(rendered.text, /2层/);
    } else {
      assert.ok(rendered.segments.every((s) => codePointLength(s) <= channel.max));
      assert.ok(rendered.segments.some((s) => s.includes(channel.id.endsWith('-en') ? 'Level 2' : '2层')));
    }
  }
});

test('小屏英文不混入中文，且不自造译名（地标取自资料挂牌文字）', async () => {
  const service = make();
  service.createSession('S13');
  await service.ask('S13', '我在二层，东换乘，全程无阶差，去地面巴士。', { persist: false });
  const response = service.engine.advise(service.getSession('S13'));
  const rendered = service.renderResponse(response, 'small-en');
  assert.equal(rendered.lang, 'en');
  const joined = rendered.segments.join(' ');
  assert.doesNotMatch(joined, /[㐀-鿿]/);
  assert.ok(rendered.segments.some((s) => s.includes('L23')));
});

test('审计可回查原话解析、下发步骤与被纠正的旧指引', async () => {
  const service = make();
  service.createSession('S14');
  await service.ask('S14', '我在二层，东换乘，要去地面巴士。', { persist: false });
  await service.submitClosure({ id: 'C14', corridor: 'R4', notice: 'x' });
  const explain = service.explain('S14');
  assert.ok(explain.log.some((e) => e.kind === 'utterance'));
  assert.ok(explain.log.some((e) => e.kind === 'instruction-issued'));
  assert.equal(service.staleInstructions().length, 1);
});
