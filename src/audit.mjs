// 追加式审计日志：值班员回查“原话如何被解释、当时给了哪一步、哪些旧指引被纠正”。
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export class AuditLog {
  constructor(file = null) {
    this.file = file instanceof URL ? fileURLToPath(file) : file;
    this.entries = [];
  }

  async record(entry) {
    const full = { seq: this.entries.length + 1, at: new Date().toISOString(), ...entry };
    this.entries.push(full);
    if (this.file) {
      await mkdir(dirname(this.file), { recursive: true });
      await appendFile(this.file, `${JSON.stringify(full)}\n`, 'utf8');
    }
    return full;
  }

  bySession(sessionId) {
    return this.entries.filter((entry) => entry.sessionId === sessionId);
  }

  cancelledInstructions(sessionId = null) {
    return this.entries.filter(
      (entry) => entry.kind === 'instruction-cancelled' && (!sessionId || entry.sessionId === sessionId),
    );
  }

  issuedInstructions(sessionId = null) {
    return this.entries.filter(
      (entry) => entry.kind === 'instruction-issued' && (!sessionId || entry.sessionId === sessionId),
    );
  }

  // 换语言后核对当前建议是否仍指向同一个动作（同一通道/同一目标标牌）。
  // 只比较“语言发生切换”的相邻两条，避免把正常走步误判为不一致。
  checkSameAction(sessionId) {
    const issued = this.issuedInstructions(sessionId);
    if (issued.length < 2) return { consistent: true, pairs: [] };
    const keyOf = (entry) => `${entry.edgeId}->${entry.target}`;
    const pairs = [];
    for (let i = 1; i < issued.length; i += 1) {
      if (issued[i - 1].lang === issued[i].lang) continue;
      pairs.push({
        fromLang: issued[i - 1].lang,
        toLang: issued[i].lang,
        sameAction: keyOf(issued[i - 1]) === keyOf(issued[i]),
        previous: keyOf(issued[i - 1]),
        current: keyOf(issued[i]),
      });
    }
    return { consistent: pairs.every((pair) => pair.sameAction), pairs };
  }

  async load() {
    if (!this.file) return;
    try {
      const text = await readFile(this.file, 'utf8');
      this.entries = text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}
