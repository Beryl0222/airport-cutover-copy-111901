// 会话状态机。
// 位置分三档：
//   confirmed  旅客亲眼读到的标牌编号/可唯一辨认的现场标识
//   inferred   系统按上一条指引推断的位置，旅客未确认
//   ambiguous  同名地标或楼层未决，系统不得自行选择
// 关键纪律：闸口是单向节点，系统永远不能替旅客确认“已经过闸”。
import { parseUtterance } from './parser.mjs';

export class Session {
  constructor(id, model, { lang = 'zh' } = {}) {
    this.id = id;
    this.model = model;
    this.lang = lang;
    this.position = null; // { kind: 'confirmed'|'inferred'|'ambiguous', ... }
    this.target = null;
    this.accessibility = null; // 最近一次有效表述：hardStepFree | softAvoidEscalator | null
    this.pendingGate = null; // 旅客自称可能过了闸但未确认
    this.activeInstruction = null; // 最近一条仍有效的指引
    this.lastCancellation = null; // 最近一次被状态变化作废的指引，待下一条回复携带后清除
    this.history = []; // 已确认走过的边（旅客读到后续标牌后回填）
    this.turns = []; // { rawText, lang, parse, positionBefore, positionAfter, response }
  }

  get currentSignId() {
    if (this.position?.kind === 'confirmed' || this.position?.kind === 'inferred') {
      return this.position.signId;
    }
    return null;
  }

  #setPosition(position, reason) {
    const before = this.position ? JSON.stringify(this.position) : null;
    this.position = position;
    return { before, reason };
  }

  // 旅客亲眼读到后续标牌：把已经走完的边记为安全已走路段。
  // 即使上一条指引已被状态变化替换，也按当前标牌与新标牌之间的实际图边补记。
  #confirmProgress(confirmedSignId) {
    const fromSign = this.currentSignId;
    if (this.activeInstruction) {
      const { nodes, edges } = this.activeInstruction.route;
      const index = nodes.indexOf(confirmedSignId);
      if (index > 0) {
        for (let i = 0; i < index; i += 1) {
          if (!this.history.includes(edges[i])) this.history.push(edges[i]);
        }
        const confirmedEdge = edges[index - 1];
        // 已走完的指引不再需要取消。
        if (index === nodes.length - 1) this.activeInstruction = null;
        return confirmedEdge;
      }
    }
    // 兜底：在图上找一条从当前位置到亲眼确认标牌的实际边。
    if (fromSign && fromSign !== confirmedSignId) {
      const edge = [...this.model.corridors.values()].find(
        (item) => item.from === fromSign && item.to === confirmedSignId,
      );
      if (edge && !this.history.includes(edge.id)) {
        this.history.push(edge.id);
        return edge.id;
      }
    }
    return null;
  }

  handleUtterance(rawText) {
    const parse = parseUtterance(rawText, this.model);
    this.lang = parse.lang;
    const positionBefore = this.position ? JSON.parse(JSON.stringify(this.position)) : null;

    if (parse.target) this.target = parse.target;
    if (parse.accessibility) this.accessibility = parse.accessibility;
    // 求助意图只在本轮有效，不应永久锁死后续指引。
    this.helpRequested = parse.askedHelp;

    const positionUpdate = this.#absorbClues(parse);

    // 若本次亲眼确认的标牌正是上一条指引的预期节点：该步视为走完。
    // 先记下走过的边（此时指引尚未被清空），再把已确认节点之后的位置保持为推断，
    // 系统不会提前替旅客确认任何后续节点。
    if (this.position?.kind === 'confirmed' && this.activeInstruction) {
      const instruction = this.activeInstruction;
      const index = instruction.route.nodes.indexOf(this.position.signId);
      if (index > 0) {
        const edgeId = instruction.route.edges[index - 1];
        this.#confirmProgress(this.position.signId);
        this.markStepConfirmed(this.position.signId, edgeId);
      }
    }
    const record = {
      at: new Date().toISOString(),
      rawText,
      lang: parse.lang,
      parse,
      positionBefore,
      positionUpdate,
      positionAfter: this.position ? JSON.parse(JSON.stringify(this.position)) : null,
    };
    this.turns.push(record);
    return { parse, record };
  }

  #absorbClues(parse) {
    const updates = [];

    // 1) 标牌编号：亲眼读到，最高优先级，可推翻此前的推断与旧确认。
    const idClues = parse.clues.filter((clue) => clue.type === 'signId' && !clue.uncertain);
    for (const clue of idClues) {
      const wasInferred = this.position?.kind === 'inferred';
      this.#setPosition(
        { kind: 'confirmed', signId: clue.signId, source: 'signId', evidence: clue.signId },
        '旅客亲口读出标牌编号',
      );
      this.pendingGate = null;
      updates.push({ type: 'confirm', signId: clue.signId, correctedInference: wasInferred });
    }

    // 2) 可唯一辨认的挂牌文字（同名组只有 1 个）才算确认。
    const nameClues = parse.clues.filter((clue) => clue.type === 'signName');
    for (const clue of nameClues) {
      if (clue.uncertain) continue;
      const group = this.model.sameNameGroup(clue.signId);
      const levelClue = parse.clues.find((item) => item.type === 'level');
      if (group.length === 1) {
        this.#setPosition(
          { kind: 'confirmed', signId: clue.signId, source: 'signName', evidence: this.model.sign(clue.signId).zh },
          '挂牌文字唯一',
        );
        this.pendingGate = null;
        updates.push({ type: 'confirm', signId: clue.signId });
      } else if (levelClue && !levelClue.uncertain) {
        // 同名但旅客给出了现场楼层：楼层是旅客自己辨认的，可解歧。
        const resolved = group.find((sign) => sign.level === levelClue.level);
        if (resolved) {
          this.#setPosition(
            {
              kind: 'confirmed',
              signId: resolved.id,
              source: 'signName+level',
              evidence: `${resolved.zh}/${levelClue.level}层`,
            },
            '同名标牌按旅客自报楼层解歧',
          );
          // 新的亲眼确认使旧的过闸疑问失效：但系统仍不会主动声称旅客已过闸。
          this.pendingGate = null;
          updates.push({ type: 'confirm', signId: resolved.id, resolvedAmbiguity: true });
        }
      } else {
        // 同名地标悬而未决：保留候选，等旅客辨认楼层或编号。
        this.#setPosition(
          {
            kind: 'ambiguous',
            name: this.model.sign(clue.signId).zh,
            candidates: group.map((sign) => sign.id),
            source: 'signName',
          },
          '同名地标未解决',
        );
        updates.push({ type: 'ambiguous', candidates: group.map((sign) => sign.id) });
      }
    }

    // 3) 巴士图案：资料中与一层东换乘同区，是楼层 1 的现场证据而非直接位置确认。
    const symbolClue = parse.clues.find((clue) => clue.type === 'coachSymbol');
    if (symbolClue) {
      const levelOne = [...this.model.signs.values()].filter(
        (sign) => sign.level === symbolClue.level && sign.zh === '东换乘',
      );
      if (levelOne.length === 1 && !symbolClue.uncertain) {
        this.#setPosition(
          {
            kind: 'confirmed',
            signId: levelOne[0].id,
            source: 'coachSymbol',
            evidence: parse.lang === 'zh' ? '巴士图案' : 'coach symbol',
          },
          '凭巴士图案锁定一层同名标牌',
        );
        this.pendingGate = null;
        updates.push({ type: 'confirm', signId: levelOne[0].id, resolvedAmbiguity: true });
      }
    }

    // 3b) 只有楼层线索时，与上一轮悬而未决的同名候选合并解歧（旅客是在回答系统的辨认问题）。
    //     若本轮带任何可定位的标牌线索（编号/名称/图案/封闭点），则由对应分支处理，不走这里。
    const levelOnly = parse.clues.find((clue) => clue.type === 'level');
    const hasSignClue = parse.clues.some(
      (clue) => ['signId', 'signName', 'coachSymbol', 'closedLandmark'].includes(clue.type),
    );
    if (
      levelOnly &&
      !hasSignClue &&
      this.position?.kind === 'ambiguous' &&
      !levelOnly.uncertain
    ) {
      const resolved = this.position.candidates
        .map((id) => this.model.sign(id))
        .find((sign) => sign.level === levelOnly.level);
      if (resolved) {
        this.#setPosition(
          {
            kind: 'confirmed',
            signId: resolved.id,
            source: 'ambiguous+level',
            evidence: `${this.position.name}/${levelOnly.level}层`,
          },
          '旅客用楼层回答同名辨认问题',
        );
        this.pendingGate = null;
        updates.push({ type: 'confirm', signId: resolved.id, resolvedAmbiguity: true });
      }
    }

    // 4) “没开门的那个”：按当前封闭记录给出受影响端点，仍需旅客对照现场。
    const closedClue = parse.clues.find((clue) => clue.type === 'closedLandmark');
    if (closedClue) {
      const near = this.model.sign(closedClue.nearSign);
      const sameName = this.model.sameNameGroup(near.id);
      if (sameName.length > 1 && !idClues.length) {
        this.#setPosition(
          {
            kind: 'ambiguous',
            name: near.zh,
            candidates: sameName.map((sign) => sign.id),
            source: 'closedLandmark',
            relatedCorridor: closedClue.corridorId,
          },
          '封闭端点同名，需现场辨认',
        );
        updates.push({ type: 'ambiguous', candidates: sameName.map((sign) => sign.id) });
      } else if (!idClues.length && this.position?.kind !== 'confirmed') {
        this.#setPosition(
          { kind: 'inferred', signId: near.id, source: 'closedLandmark', relatedCorridor: closedClue.corridorId },
          '按封闭记录推断位置，未经旅客确认',
        );
        updates.push({ type: 'infer', signId: near.id });
      }
    }

    // 5) 闸口声明：
    //    - 不确定是否过闸：挂起，等旅客在现场辨认；
    //    - 明确未过闸：解除挂起，系统据此允许闸前指引，但绝不声称旅客已过闸；
    //    - 明确自称已过闸：仍需闸后标牌佐证，未佐证前只挂起不代认。
    if (parse.gateClaim) {
      const gateId = [...this.model.gates][0] ?? null;
      if (parse.gateClaim.negated && !parse.gateClaim.passed) {
        this.pendingGate = null;
        updates.push({ type: 'gateConfirmedNotPassed', gateId });
      } else {
        this.pendingGate = { question: '是否已通过单向闸口', gateId };
        updates.push(parse.gateClaim.uncertain ? { type: 'gateUnconfirmed' } : { type: 'gateNeedsCorroboration' });
      }
    }

    return updates;
  }

  // 旅客确认读到指引预期的下一块标牌后调用：该步走完。
  // 当前节点保持“亲眼确认”；仅把走过的边记录在案，后续节点在旅客再次确认前都不算确认。
  markStepConfirmed(confirmedSignId, edgeId) {
    const instruction = this.activeInstruction;
    if (instruction && instruction.expectedSign === confirmedSignId) {
      const index = instruction.route.nodes.indexOf(confirmedSignId);
      const resolvedEdge = edgeId ?? (index > 0 ? instruction.route.edges[index - 1] : null);
      if (resolvedEdge && !this.history.includes(resolvedEdge)) {
        this.history.push(resolvedEdge);
      }
    }
  }

  // 重新打开/状态变化后，由引擎写回新的有效指引。
  replaceInstruction(instruction) {
    const previous = this.activeInstruction;
    this.activeInstruction = instruction;
    return previous;
  }

  // 记录被作废的指引，使旅客下次打开时能收到明确的取消与替代文字。
  noteCancellation(instruction, reason) {
    this.lastCancellation = {
      instructionId: instruction.id,
      reason,
      edges: instruction.route.edges,
      at: new Date().toISOString(),
    };
  }

  consumeCancellation() {
    const cancellation = this.lastCancellation;
    this.lastCancellation = null;
    return cancellation;
  }

  snapshot() {
    return JSON.parse(JSON.stringify({
      id: this.id,
      lang: this.lang,
      position: this.position,
      target: this.target,
      accessibility: this.accessibility,
      pendingGate: this.pendingGate,
      lastCancellation: this.lastCancellation,
      activeInstruction: this.activeInstruction
        ? {
            id: this.activeInstruction.id,
            action: this.activeInstruction.action,
            edges: this.activeInstruction.route.edges,
            nodes: this.activeInstruction.route.nodes,
            fromSign: this.activeInstruction.fromSign,
            expectedSign: this.activeInstruction.expectedSign,
            stepFree: this.activeInstruction.stepFree,
          }
        : null,
      history: this.history,
      turnCount: this.turns.length,
    }));
  }
}
