// 本地运行态存储：会话快照与运营变化。资料 data/inputs.json 只读，运行态单独落盘。
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export class JsonStore {
  constructor(file) {
    // 同时接受路径字符串与 file:// URL。
    this.file = file instanceof URL ? fileURLToPath(file) : file;
    this.state = { sessions: {}, closures: [] };
  }

  static async open(file) {
    const store = new JsonStore(file);
    await store.open();
    return store;
  }

  // 从磁盘载入已有运行态；文件不存在时保持空状态。
  async open() {
    if (!this.file) return;
    try {
      this.state = JSON.parse(await readFile(this.file, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  saveSession(session) {
    this.state.sessions[session.id] = session.snapshot();
    return this.persist();
  }

  addClosureRecord(record) {
    this.state.closures.push(record);
    return this.persist();
  }

  async persist() {
    if (!this.file) return;
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify(this.state, null, 2), 'utf8');
  }
}
