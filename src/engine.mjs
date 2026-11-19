// 路径引擎：把会话状态变成“当下可执行的一步”或一个现场可辨认的问题。
let instructionSeq = 0;

export class Engine {
  constructor(model, audit) {
    this.model = model;
    this.audit = audit;
  }

  #stepFree(session) {
    return session.accessibility === 'hardStepFree';
  }

  // 运行人员提交通道变化后，对受影响会话做再核对（不直接下发，等旅客下次打开）。
  reverify(session) {
    const instruction = session.activeInstruction;
    if (!instruction) return { status: 'no-active-instruction' };

    const blockedEdge = instruction.route.edges.find((edgeId) => this.model.isClosed(edgeId));
    const stepFreeNow = this.#stepFree(session);
    const inaccessible =
      stepFreeNow &&
      instruction.route.edges.some((edgeId) => !this.model.corridors.get(edgeId).stepFree);

    if (!blockedEdge && !inaccessible) {
      this.audit?.record({
        kind: 'reverify-ok',
        sessionId: session.id,
        instructionId: instruction.id,
        checkedAt: new Date().toISOString(),
      });
      return { status: 'still-valid', instructionId: instruction.id };
    }

    const reason = blockedEdge
      ? { type: 'closed', corridorId: blockedEdge, closureIds: this.model.closuresOn(blockedEdge) }
      : { type: 'stepFreeMismatch' };

    // 已确认安全走过的边保留；从当前位置重新找路。旧指引标记需纠正。
    instruction.superseded = true;
    instruction.invalidReason = reason;
    session.noteCancellation(instruction, reason);
    const previous = session.replaceInstruction(null);
    this.audit?.record({
      kind: 'instruction-cancelled',
      sessionId: session.id,
      instructionId: previous.id,
      reason,
      safeHistory: [...session.history],
    });
    return { status: 'cancelled', instructionId: previous.id, reason };
  }

  advise(session) {
    const lang = session.lang;

    if (session.helpRequested || (!session.target && session.position)) {
      return this.#helpResponse(session, '旅客请求人工帮助');
    }
    if (!session.target) {
      return this.#question(session, {
        code: 'need-target',
        detail: '旅客未说明要去的交通方式',
      });
    }

    // 同名地标未决：先问现场能辨认的标识，不能猜楼层。
    if (session.position?.kind === 'ambiguous') {
      return this.#question(session, {
        code: 'same-name-sign',
        candidates: session.position.candidates,
        detail: `同名地标「${session.position.name}」多个楼层挂牌，需现场辨认`,
      });
    }

    const start = session.currentSignId;
    if (!start) {
      return this.#question(session, {
        code: 'need-position',
        detail: '没有可用的位置线索',
      });
    }

    if (start === session.target) {
      return {
        kind: 'arrived',
        lang,
        action: { type: 'arrived', signId: session.target },
        audit: { kind: 'arrived', sessionId: session.id, signId: session.target },
      };
    }

    const stepFree = this.#stepFree(session);
    const options = this.model.allPaths(start, session.target, { stepFree });

    // 明确要求全程无阶差却无合规路线：不得引导有阶差路线，如实告知并给求助点。
    if (options.length === 0 && stepFree) {
      this.audit?.record({
        kind: 'no-step-free-route',
        sessionId: session.id,
        start,
        target: session.target,
      });
      const helpPath = this.model.pathToHelp(start, { stepFree: true });
      const response = {
        kind: 'help',
        lang,
        action: helpPath
          ? { type: 'askHelp', signId: this.model.helpDesk, corridorId: helpPath.edges[0] ?? null }
          : { type: 'stay', signId: start },
        route: helpPath,
        warnings: ['noStepFreeRoute'],
        detail: '硬性无阶差要求下无可达路线',
      };
      this.audit?.record({
        kind: 'help',
        sessionId: session.id,
        lang,
        helpDesk: this.model.helpDesk,
        route: helpPath?.edges ?? null,
        detail: response.detail,
      });
      return response;
    }

    if (options.length === 0) {
      // 无任何偏好约束也无路：给可辨认的求助点，或原地等候。
      const helpPath = this.model.pathToHelp(start, { stepFree: false });
      if (helpPath) return this.#helpResponse(session, '目标不可达，引导至求助点', helpPath);
      return {
        kind: 'help',
        lang,
        action: { type: 'stay', signId: start },
        audit: { kind: 'stay', sessionId: session.id, signId: start },
      };
    }

    // 第一步完全一致且对本人可行：只发这一步，不提前暴露后续岔路。
    const firstEdgeId = options[0].edges[0];
    const sameFirstStep = options.every((path) => path.edges[0] === firstEdgeId);
    if (!sameFirstStep) {
      return this.#question(session, {
        code: 'first-step-diverges',
        candidates: [...new Set(options.map((path) => path.edges[0]))],
        detail: '候选路径第一步不同，需先辨认现场标识再选路',
      });
    }

    const firstEdge = this.model.corridors.get(firstEdgeId);
    // 这一步要穿过单向闸口，而旅客此前对“是否已过闸”表述不确定：
    // 系统不能代认，必须请旅客在现场辨认闸后标牌。
    if (this.model.isGate(firstEdge.to) && session.pendingGate) {
      return this.#question(session, {
        code: 'oneway-gate',
        gateId: firstEdge.to,
        detail: '该步穿过单向闸口，是否已通过只能由旅客本人确认',
      });
    }
    const chosen = options[0];
    const nextSign = this.model.sign(firstEdge.to);

    // 若上一条指引已被状态变化作废，本条响应携带明确的取消与替代文字。
    const pendingCancellation = session.lastCancellation;
    const cancelled = pendingCancellation
      ? { instructionId: pendingCancellation.instructionId, reason: pendingCancellation.reason }
      : null;
    // 取消信息随下一条可执行指引一次性下发，之后不再重复。
    if (cancelled) session.consumeCancellation();

    // 同一位置、同一目标且首步未变时复用现有指引：
    // 旅客只是重复询问（例如换语言、再打开），不应新建指引把已确认进度冲掉。
    const existing = session.activeInstruction;
    const reusable =
      existing &&
      !existing.superseded &&
      existing.fromSign === start &&
      existing.expectedSign === nextSign.id &&
      existing.action.corridorId === firstEdge.id &&
      existing.stepFree === stepFree;

    const instruction = reusable
      ? existing
      : {
          id: `I${(instructionSeq += 1)}`,
          issuedAt: new Date().toISOString(),
          lang,
          action: { type: 'goto', signId: nextSign.id, corridorId: firstEdge.id },
          route: chosen,
          stepFree,
          accessibility: session.accessibility,
          // 指引只负责这一步：旅客在起点被要求去读 nextSign，位置不提前跳。
          fromSign: start,
          expectedSign: nextSign.id,
          superseded: false,
        };
    if (!reusable) session.replaceInstruction(instruction);

    const warnings = [];
    if (session.accessibility === 'softAvoidEscalator') {
      // 软偏好下如实告知：避开了就说明，避不开也要标明，不伪装成无阶差。
      warnings.push(firstEdge.stepFree ? 'softAvoidHonored' : 'softAvoidUnavoidable');
    }
    if (this.model.isGate(nextSign.id)) warnings.push('onewayGateAhead');

    this.audit?.record({
      kind: 'instruction-issued',
      sessionId: session.id,
      instructionId: instruction.id,
      lang,
      start,
      target: session.target,
      edgeId: firstEdge.id,
      routeEdges: chosen.edges,
      stepFree,
      warnings,
      cancelled,
    });

    return {
      kind: 'instruction',
      lang,
      action: instruction.action,
      instructionId: instruction.id,
      cancelled,
      warnings,
      remainingRoute: chosen,
      audit: null,
    };
  }

  #question(session, payload) {
    this.audit?.record({ kind: 'question', sessionId: session.id, lang: session.lang, ...payload });
    return {
      kind: 'question',
      lang: session.lang,
      questionCode: payload.code,
      candidates: payload.candidates ?? null,
      gateId: payload.gateId ?? null,
      detail: payload.detail,
    };
  }

  #helpResponse(session, detail, route = null) {
    const helpId = this.model.helpDesk;
    this.audit?.record({
      kind: 'help',
      sessionId: session.id,
      lang: session.lang,
      helpDesk: helpId,
      route: route?.edges ?? null,
      detail,
    });
    return {
      kind: 'help',
      lang: session.lang,
      action: route
        ? { type: 'askHelp', signId: helpId, corridorId: route.edges[0] ?? null }
        : { type: 'askHelp', signId: helpId },
      route,
      detail,
    };
  }
}
