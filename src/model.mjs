// 合成平面资料的内存模型：标牌、有向通道、单向闸口、封闭状态与路径搜索。
// 通道按有向边处理：边的方向就是允许通行的方向，没有反向边即不能原路返回。
export class AirportModel {
  constructor(data) {
    this.data = data;
    this.signs = new Map(data.signs.map((sign) => [sign.id, sign]));
    this.corridors = new Map(data.corridors.map((corridor) => [corridor.id, corridor]));
    this.gates = new Set(data.gates ?? []);
    this.helpDesk = data.helpDesk;
    this.closureNotices = new Map((data.closures ?? []).map((item) => [item.id, item]));
    // corridorId -> Set<closureId>
    this.closedBy = new Map();
    for (const closure of data.closures ?? []) this.#markClosed(closure.corridor, closure.id);
  }

  #markClosed(corridorId, closureId) {
    if (!this.closedBy.has(corridorId)) this.closedBy.set(corridorId, new Set());
    this.closedBy.get(corridorId).add(closureId);
  }

  #unmarkClosed(corridorId, closureId) {
    this.closedBy.get(corridorId)?.delete(closureId);
    if (this.closedBy.get(corridorId)?.size === 0) this.closedBy.delete(corridorId);
  }

  // 运行人员提交变化：临时封闭 / 重新开放。
  applyClosure(closure) {
    if (!this.corridors.has(closure.corridor)) {
      throw new Error(`未知通道编号: ${closure.corridor}`);
    }
    this.closureNotices.set(closure.id, closure);
    this.#markClosed(closure.corridor, closure.id);
  }

  liftClosure(closureId) {
    const closure = this.closureNotices.get(closureId);
    if (!closure) return false;
    this.#unmarkClosed(closure.corridor, closureId);
    this.closureNotices.delete(closureId);
    return true;
  }

  closuresOn(corridorId) {
    return [...(this.closedBy.get(corridorId) ?? [])];
  }

  isClosed(corridorId) {
    return this.closedBy.has(corridorId);
  }

  sign(id) {
    const sign = this.signs.get(id);
    if (!sign) throw new Error(`未知标牌编号: ${id}`);
    return sign;
  }

  signText(id, lang) {
    return this.sign(id)[lang];
  }

  isGate(id) {
    return this.gates.has(id);
  }

  // 同名地标（两种语言各自比对），用于识别“东换乘/East Transfer”这类重复挂牌。
  sameNameGroup(id) {
    const sign = this.sign(id);
    return [...this.signs.values()].filter(
      (item) => item.zh === sign.zh || item.en === sign.en,
    );
  }

  findByText(text) {
    const normalized = text.trim().toLowerCase();
    return [...this.signs.values()].filter(
      (item) =>
        item.zh === text.trim() ||
        item.en.toLowerCase() === normalized,
    );
  }

  // 从某标牌出发当前可用的有向边。
  outgoing(signId, { stepFree = false } = {}) {
    return [...this.corridors.values()].filter((corridor) => {
      if (corridor.from !== signId) return false;
      if (this.isClosed(corridor.id)) return false;
      if (stepFree && !corridor.stepFree) return false;
      return true;
    });
  }

  edgeAllowed(corridorId, { stepFree = false } = {}) {
    const corridor = this.corridors.get(corridorId);
    if (!corridor || this.isClosed(corridorId)) return false;
    if (stepFree && !corridor.stepFree) return false;
    return true;
  }

  // 最短可行路径（BFS），找不到返回 null。
  findPath(start, target, { stepFree = false } = {}) {
    if (start === target) return { nodes: [start], edges: [] };
    const queue = [start];
    // prev: 到达某节点时，记录它的前驱节点与所用边。
    const prev = new Map([[start, { node: null, edge: null }]]);
    let found = false;
    while (queue.length > 0) {
      const current = queue.shift();
      for (const edge of this.outgoing(current, { stepFree })) {
        if (prev.has(edge.to)) continue;
        prev.set(edge.to, { node: current, edge: edge.id });
        if (edge.to === target) {
          found = true;
          break;
        }
        queue.push(edge.to);
      }
      if (found) break;
    }
    if (!found) return null;
    const nodes = [];
    const edges = [];
    let cursor = target;
    while (cursor !== start) {
      const link = prev.get(cursor);
      nodes.unshift(cursor);
      edges.unshift(link.edge);
      cursor = link.node;
    }
    nodes.unshift(start);
    return { nodes, edges };
  }

  // 枚举全部简单路径（平面图很小），用于判断多条候选路径的第一步是否一致。
  allPaths(start, target, { stepFree = false } = {}) {
    const results = [];
    const visit = (node, nodes, edges, visited) => {
      if (node === target) {
        results.push({ nodes: [...nodes], edges: [...edges] });
        return;
      }
      for (const edge of this.outgoing(node, { stepFree })) {
        if (visited.has(edge.to)) continue;
        visited.add(edge.to);
        nodes.push(edge.to);
        edges.push(edge.id);
        visit(edge.to, nodes, edges, visited);
        nodes.pop();
        edges.pop();
        visited.delete(edge.to);
      }
    };
    visit(start, [start], [], new Set([start]));
    return results;
  }

  // 到任一可辨认求助点的最短路径；没有则返回 null。
  pathToHelp(start, opts = {}) {
    if (start === this.helpDesk) return { nodes: [start], edges: [] };
    return this.findPath(start, this.helpDesk, opts);
  }
}
