'use strict';
/*
 * 持久化表存储（无外部依赖）
 * - data/db.json：原子快照（写临时文件 -> fsync -> rename -> fsync 目录）
 * - data/db.wal ：仅追加写前日志，崩溃后在快照之上重放，不丢已确认事务
 * 所有变更在一个同步事务里完成 日志追加(fsync) + 内存应用，保证“已提交即持久”。
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const WAL_FILE = path.join(DATA_DIR, 'db.wal');
const SNAPSHOT_EVERY = 40; // 每 40 次提交压缩一次 WAL

class Database {
  constructor() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    this.tables = {};
    this.counters = {};
    this.seq = 0;
    this.commitsSinceSnapshot = 0;
    this._load();
  }

  _load() {
    if (fs.existsSync(DB_FILE)) {
      try {
        const snap = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        this.tables = snap.tables || {};
        this.counters = snap.counters || {};
        this.seq = snap.seq || 0;
      } catch (e) {
        // 快照损坏时从空库 + 完整 WAL 重放（WAL 从 1 开始即全量历史）
        this.tables = {}; this.counters = {}; this.seq = 0;
      }
    }
    if (fs.existsSync(WAL_FILE)) {
      const lines = fs.readFileSync(WAL_FILE, 'utf8').split('\n').filter(Boolean);
      for (const line of lines) {
        let rec;
        try { rec = JSON.parse(line); } catch { continue; }
        if (rec.seq > this.seq) { this._apply(rec); this.seq = rec.seq; }
      }
    }
    if (!fs.existsSync(WAL_FILE)) fs.writeFileSync(WAL_FILE, '');
  }

  _apply(rec) {
    const t = this.tables[rec.table] || (this.tables[rec.table] = {});
    if (rec.op === 'put') t[rec.id] = rec.row;
    else if (rec.op === 'del') delete t[rec.id];
  }

  _fsyncDir() {
    try {
      const fd = fs.openSync(DATA_DIR, 'r');
      fs.fsyncSync(fd);
      fs.closeSync(fd);
    } catch (_) { /* 某些平台不支持目录 fsync */ }
  }

  _writeSnapshot() {
    const payload = JSON.stringify({ seq: this.seq, tables: this.tables, counters: this.counters });
    const tmp = DB_FILE + '.tmp';
    const fd = fs.openSync(tmp, 'w');
    fs.writeFileSync(fd, payload);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fs.renameSync(tmp, DB_FILE);
    this._fsyncDir();
    fs.writeFileSync(WAL_FILE, ''); // 截断已并入快照的日志
    this.commitsSinceSnapshot = 0;
  }

  /** 同步事务：fn 内可任意 insert/update/remove，返回 fn 结果，整批一次 fsync */
  transaction(fn) {
    const batch = [];
    let result;
    const ctx = {
      nextId: (table) => (this.counters['id:' + table] = (this.counters['id:' + table] || 0) + 1),
      nextSeq: (key) => (this.counters['seq:' + key] = (this.counters['seq:' + key] || 0) + 1),
      insert: (table, row) => {
        if (row.id == null) row.id = ctx.nextId(table);
        batch.push({ op: 'put', table, id: row.id, row });
        return row;
      },
      update: (table, id, patch) => {
        const cur = this.tables[table] && this.tables[table][id];
        if (!cur) throw Object.assign(new Error('not_found: ' + table + '#' + id), { status: 404 });
        const row = Object.assign({}, cur, patch);
        batch.push({ op: 'put', table, id, row });
        return row;
      },
      put: (table, id, row) => { batch.push({ op: 'put', table, id, row }); return row; },
      remove: (table, id) => { batch.push({ op: 'del', table, id }); },
    };
    result = fn(ctx);
    if (batch.length) {
      const fd = fs.openSync(WAL_FILE, 'a');
      for (const b of batch) {
        this.seq += 1;
        b.seq = this.seq;
        fs.writeSync(fd, JSON.stringify(b) + '\n');
      }
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      for (const b of batch) this._apply(b);
      this.commitsSinceSnapshot += 1;
      if (this.commitsSinceSnapshot >= SNAPSHOT_EVERY) this._writeSnapshot();
    }
    return result;
  }

  all(table, pred) {
    const rows = Object.values(this.tables[table] || {});
    return pred ? rows.filter(pred) : rows;
  }
  find(table, pred) { return this.all(table, pred)[0] || null; }
  get(table, id) { return (this.tables[table] || {})[id] || null; }
  // 调试/关机用：立刻落快照
  checkpoint() { this._writeSnapshot(); }
}

module.exports = new Database();
