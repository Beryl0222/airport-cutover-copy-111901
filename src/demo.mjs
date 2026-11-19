// 合成数据演练：完整走一遍改线咨询的关键场景。所有记录均为虚构。
// 每个场景使用独立的服务实例，封闭状态互不串扰。
import { RerouteService } from './app.mjs';
import { readFile } from 'node:fs/promises';
import { codePointLength } from './render.mjs';

const DATA_FILE = new URL('../data/inputs.json', import.meta.url);

export async function runDemo() {
  const data = JSON.parse(await readFile(DATA_FILE, 'utf8'));
  const output = [];
  const make = () => new RerouteService(data);

  const ask = async (service, sessionId, text, channel = 'phone') => {
    const { parse, response } = await service.ask(sessionId, text, { persist: false });
    const rendered = service.renderResponse(response, channel);
    output.push({
      title: `[${sessionId}] 旅客：${text}`,
      parsed: {
        lang: parse.lang,
        target: parse.target,
        accessibility: parse.accessibility,
        clueKinds: parse.clues.map((clue) => clue.type),
        gateClaim: parse.gateClaim,
      },
      position: service.getSession(sessionId).position,
      responseKind: response.kind,
      rendered,
    });
    return response;
  };

  // 场景一：同名解歧 -> 逐步指引 -> 改线（重开 R3、封闭 R4）-> 旧指引作废 -> 替代路线要过单向闸口 -> 本人确认。
  output.push({ title: '场景一：二层东换乘、全程无阶差；改线后取消旧指引，替代路线经单向闸口' });
  {
    const service = make();
    service.createSession('D1');
    await ask(service, 'D1', 'I need the coaches. No steps please.'); // 只有目标和硬约束，缺位置
    await ask(service, 'D1', '看到了东换乘，但我不确定有没有过闸。'); // 同名 + 过闸未确认 -> 先问现场
    await ask(service, 'D1', '我在二层，东换乘。'); // 旅客自报楼层 -> 确认 D24，给第一步 R4->L23
    await ask(service, 'D1', '我看到 L23 了。'); // 亲眼确认 -> 下一步 R5->T18

    // 第二位旅客仍停在 D24，持有 R4 指引。
    service.createSession('D1B');
    await ask(service, 'D1B', '我在二层，东换乘，全程无阶差，去地面巴士。');

    // 改线：先重开 R3（新动线启用），再封闭 R4（旧动线段）。
    output.push({ title: '运行：重开 R3（解除 C1）', reopen: await service.reopenCorridor('C1') });
    const reverify = await service.submitClosure({ id: 'C2', corridor: 'R4', notice: '西侧通道临时检修。' });
    output.push({ title: '运行：封闭 R4（C2），受影响会话再核对', reverify });

    await ask(service, 'D1B', '我还在东换乘这边。'); // 同名 -> 辨认问题
    await ask(service, 'D1B', '我在二层。'); // 解歧到 D24；替代第一步 R1 要过闸，且此前有过闸疑问 -> 问闸
    await ask(service, 'D1B', '我应该已经过闸了吧？'); // 不确定 -> 仍不代认，继续请本人辨认
    await ask(service, 'D1B', '我还没过闸，就在闸口前面。'); // 明确未过闸 -> 给 R1->G21，附取消说明与单向提示

    const phone = service.renderResponse(
      service.engine.advise(service.getSession('D1B')),
      'phone',
    );
    const smallEn = service.renderResponse(
      service.engine.advise(service.getSession('D1B')),
      'small-en',
    );
    output.push({ title: 'D1B 手机长文案（含取消与原因）', phone });
    output.push({ title: 'D1B 小屏英文版（预算 44，分步、保留楼层/无障碍事实）', small: smallEn });
    output.push({ title: '被纠正的旧指引', stale: service.staleInstructions() });
  }

  // 场景二：一层、带行李（软偏好）；升级为硬性无阶差后本层无合规路线 -> 不引导有阶差路，给现场等候/求助。
  output.push({ title: '场景二：一层东换乘，软偏好升级为硬性无阶差' });
  {
    const service = make();
    service.createSession('D2');
    await ask(service, 'D2', '找地面巴士，尽量别用扶梯。');
    await ask(service, 'D2', '我在看见巴士图案的东换乘。'); // 凭巴士图案锁定 D14，R7 含阶差但软偏好可放行并如实标注
    await ask(service, 'D2', '还是不能走楼梯。'); // 升级硬约束：无无阶差路线 -> 原地等候/求助，不引导 R7
  }

  // 场景三：相反线索纠正推断；系统不替旅客确认过闸。
  output.push({ title: '场景三：相反位置线索纠正推断；过闸必须本人确认' });
  {
    const service = make();
    service.createSession('D3');
    await ask(service, 'D3', '我在二层，东换乘，要去地面巴士。');
    await ask(service, 'D3', '我看到的是没开门的那个。'); // 封闭线索只能推断/存疑
    await ask(service, 'D3', '不对，我现在读到的标牌是 D14。'); // 亲眼读到编号，推翻推断到一层
    await ask(service, 'D3', '我应该已经过闸了吧？'); // 不确定过闸：记录未决，但 R7 不过闸，不阻拦当前步
    output.push({ title: 'D3 审计：位置三档与推断纠正记录', explain: service.explain('D3').session });
  }

  // 场景四：换语言后当前建议必须仍指向同一动作。
  output.push({ title: '场景四：中文切英文，动作一致性核对' });
  {
    const service = make();
    service.createSession('D4');
    await ask(service, 'D4', '我在二层，东换乘，要去地面巴士，带行李。'); // R4/R1 第一步不同 -> 先问现场
    await ask(service, 'D4', '我看到 L23 了。'); // 亲眼读到西侧标牌 -> 唯一化，给 R5->T18
    const switched = service.switchLanguage('D4', 'en');
    output.push({ title: 'D4 切换到英文', switched });
  }

  // 场景五：回放资料中的历史问路记录（合成数据）。
  output.push({ title: '场景五：回放 data/sessions 中的历史问路记录' });
  {
    const service = make();
    output.push({ title: 'seed', seeded: await service.seedFromInputs() });
  }

  // 全渠道长度预算核对（取场景一最终态与场景四）。
  output.push({ title: '全部渠道长度预算核对（码点 <= max）', budgetChecks: await collectBudgetChecks(make, data) });
  return output;
}

async function collectBudgetChecks(make, data) {
  const checks = [];
  const service = make();
  service.createSession('B1');
  await service.ask('B1', '我在二层，东换乘，全程无阶差，去地面巴士。', { persist: false });
  service.createSession('B2');
  await service.ask('B2', '我在看见巴士图案的东换乘，找地面巴士。', { persist: false });
  for (const channel of data.channels) {
    for (const sessionId of ['B1', 'B2']) {
      const response = service.engine.advise(service.getSession(sessionId));
      const rendered = service.renderResponse(response, channel.id);
      const lengths = rendered.segments
        ? rendered.segments.map(codePointLength)
        : [codePointLength(rendered.text)];
      checks.push({
        channel: channel.id,
        max: channel.max,
        sessionId,
        lengths,
        fits: lengths.every((value) => value <= channel.max),
      });
    }
  }
  return checks;
}

if (import.meta.url === new URL(`file://${process.argv[1]}`, import.meta.url).href) {
  console.log(JSON.stringify(await runDemo(), null, 2));
}
