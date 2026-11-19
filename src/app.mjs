// 编排层：把模型、会话、引擎、渲染与审计串成一个本地服务，供 CLI 与测试共用。
import { AirportModel } from './model.mjs';
import { Session } from './session.mjs';
import { Engine } from './engine.mjs';
import { AuditLog } from './audit.mjs';
import { JsonStore } from './store.mjs';
import { renderForChannel, renderPhone } from './render.mjs';

export class RerouteService {
  constructor(data, { auditFile = null, storeFile = null } = {}) {
    this.data = data;
    this.model = new AirportModel(data);
    this.audit = new AuditLog(auditFile);
    this.store = new JsonStore(storeFile);
    this.engine = new Engine(this.model, this.audit);
    this.sessions = new Map();
  }

  // 异步工厂：确保磁盘上的运行态已载入（CLI 每次调用是独立进程）。
  static async create(data, opts = {}) {
    const service = new RerouteService(data, opts);
    if (opts.storeFile) {
      await service.store.open();
      service.restoreClosures();
    }
    // 载入历史审计，使 explain/stale 等回查能跨进程连续。
    if (opts.auditFile) await service.audit.load();
    return service;
  }

  createSession(id, { lang = 'zh' } = {}) {
    const session = new Session(id, this.model, { lang });
    this.sessions.set(id, session);
    return session;
  }

  getSession(id) {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`未知会话: ${id}`);
    return session;
  }

  // 从运行态快照恢复会话（CLI 每次调用是独立进程）。
  restoreSession(id) {
    const snapshot = this.store.state.sessions[id];
    if (!snapshot) return null;
    const session = this.createSession(id, { lang: snapshot.lang });
    session.target = snapshot.target;
    session.accessibility = snapshot.accessibility;
    session.pendingGate = snapshot.pendingGate;
    session.history = [...snapshot.history];
    session.position = snapshot.position;
    // 恢复有效指引；被作废的指引转为待下发的取消信息。
    if (snapshot.activeInstruction) {
      const active = snapshot.activeInstruction;
      session.activeInstruction = {
        ...active,
        // 快照优先保留完整 nodes；旧快照缺 nodes 时按边重建。
        route: active.nodes
          ? { nodes: active.nodes, edges: active.edges }
          : this.#rebuildRoute(active),
        superseded: false,
      };
    }
    if (snapshot.lastCancellation) session.lastCancellation = snapshot.lastCancellation;
    return session;
  }

  #rebuildRoute(active) {
    // 快照只存了 edges；按边在模型中重建 nodes，保证结构完整。
    const nodes = [];
    for (const edgeId of active.edges) {
      const edge = this.model.corridors.get(edgeId);
      if (!nodes.length) nodes.push(edge.from);
      nodes.push(edge.to);
    }
    return { nodes, edges: [...active.edges] };
  }

  ensureSession(id, { lang = 'zh' } = {}) {
    if (this.sessions.has(id)) return this.sessions.get(id);
    return this.restoreSession(id) ?? this.createSession(id, { lang });
  }

  // 载入资料中的历史问路记录：只回放原句，位置仍由规则重新判定，不直接信任旧字段。
  async seedFromInputs() {
    const summaries = [];
    for (const record of this.data.sessions ?? []) {
      this.createSession(record.id);
      for (const utterance of record.turns) {
        const { response } = await this.ask(record.id, utterance, { persist: false });
        summaries.push({ sessionId: record.id, utterance, responseKind: response.kind });
      }
    }
    return summaries;
  }

  async ask(sessionId, rawText, { persist = true } = {}) {
    const session = this.getSession(sessionId);
    const { parse, record } = session.handleUtterance(rawText);
    const response = this.engine.advise(session);
    record.response = {
      kind: response.kind,
      questionCode: response.questionCode ?? null,
      action: response.action ?? null,
      instructionId: response.instructionId ?? null,
    };
    await this.audit.record({
      kind: 'utterance',
      sessionId,
      lang: parse.lang,
      rawText,
      parsed: parse,
      position: session.position,
    });
    if (persist) await this.store.saveSession(session);
    return { session, parse, response };
  }

  // 运行人员提交临时封闭/重新开放。
  async submitClosure(closure) {
    this.model.applyClosure(closure);
    await this.store.addClosureRecord({ at: new Date().toISOString(), ...closure });
    await this.audit.record({ kind: 'closure-submitted', closure });
    return this.reverifyAll();
  }

  async reopenCorridor(closureId) {
    const closure = this.model.closureNotices.get(closureId);
    if (!closure) throw new Error(`未知封闭记录: ${closureId}`);
    this.model.liftClosure(closureId);
    await this.audit.record({ kind: 'closure-lifted', closureId, corridor: closure.corridor });
    return this.reverifyAll();
  }

  // 恢复运行态存储中的全部会话（运营变化要对所有在途旅客再核对）。
  restoreAllSessions() {
    for (const id of Object.keys(this.store.state.sessions)) {
      if (!this.sessions.has(id)) this.restoreSession(id);
    }
  }

  // 把运行态里已提交的封闭重新应用到模型（CLI 新进程启动后恢复现场）。
  restoreClosures() {
    for (const record of this.store.state.closures ?? []) {
      if (!this.model.closureNotices.has(record.id)) {
        this.model.applyClosure({ id: record.id, corridor: record.corridor, notice: record.notice });
      }
    }
  }

  // 对所有持有有效指引的会话重新核对：已发出的短句是否还会把人带到封路口。
  async reverifyAll() {
    this.restoreAllSessions();
    const results = [];
    for (const session of this.sessions.values()) {
      const result = this.engine.reverify(session);
      if (result.status !== 'no-active-instruction') results.push({ sessionId: session.id, ...result });
      await this.store.saveSession(session);
    }
    return results;
  }

  render(sessionId, channelId) {
    const session = this.getSession(sessionId);
    const channel = this.data.channels.find((item) => item.id === channelId);
    if (!channel) throw new Error(`未知展示渠道: ${channelId}`);
    const response = this.engine.advise(session);
    return renderForChannel(this.model, response, channel);
  }

  // 换语言重发同一步：动作键必须与上一条一致，文案语言切换。
  switchLanguage(sessionId, lang) {
    const session = this.getSession(sessionId);
    const before = this.audit.issuedInstructions(sessionId).at(-1);
    session.lang = lang;
    // 不重新解析新句子，直接对当前状态重算，验证动作不变。
    const response = this.engine.advise(session);
    const after = this.audit.issuedInstructions(sessionId).at(-1);
    const consistency = this.audit.checkSameAction(sessionId);
    const channel = this.data.channels.find((item) => item.id === 'phone');
    return {
      rendered: renderForChannel(this.model, response, channel),
      previousInstruction: before,
      currentInstruction: after,
      consistency,
    };
  }

  explain(sessionId) {
    const session = this.getSession(sessionId);
    return {
      session: session.snapshot(),
      log: this.audit.bySession(sessionId),
      languageConsistency: this.audit.checkSameAction(sessionId),
    };
  }

  staleInstructions() {
    return this.audit.cancelledInstructions();
  }

  // 纯函数式渲染，供测试直接调用。
  renderResponse(response, channelId) {
    const channel = this.data.channels.find((item) => item.id === channelId);
    return renderForChannel(this.model, response, channel);
  }

  phoneText(response) {
    return renderPhone(this.model, response);
  }
}
