/* ============================================================
   小资记账 · 数据层
   ------------------------------------------------------------
   设计要点（每一条都有理由，不要随手改）：

   1. 金额一律用「分」存整数。
      0.1 + 0.2 在计算机里不等于 0.3（浮点数误差），记账最忌这个。
      显示时再除 100，永远只在这一处做转换。

   2. 数据是一个 JSON 文件，不是数据库。
      文件在 App 的私有数据目录里（Directory.Data），
      「清缓存」清不掉，只有「清除数据」和「卸载」会删。

   3. 写入是「攒一下再写」（防抖 300ms）+ 原子落盘（先写临时文件、再改名）。
      记一笔就连写一次文件没必要。
      注意：pagehide 时调 flush 是「尽力而为」—— async 写没办法在页面卸载前
      保证跑完，所以最多可能丢 300ms 内的改动。别把它当成「关页面就一定落地」。

   4. 文件损坏时有兜底：主文件读不出来就回退到 .bak。
      .bak 是「上一次成功的完整内容」，不是「今天第一份」——
      否则今天记了 30 笔、晚上写坏了，恢复出来的是今天早上的，一整天全丢。
   ============================================================ */

const Store = (function () {
  const DATA_FILE = 'xiaozi-data.json';
  const BAK_FILE = 'xiaozi-data.bak.json';
  const TMP_FILE = 'xiaozi-data.tmp.json';
  const SCHEMA_VERSION = 3;   // v2：银行类支付方式合并为「银行卡」；v3：备注按使用次数排序
  const LS_KEY = 'xiaozi-data';

  // 运行环境判断：在手机 App 里用文件，在电脑浏览器里调试用 localStorage
  const isNative = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());

  let db = null;             // 内存里的数据（唯一真相）
  let writeTimer = null;     // 防抖计时器
  let lastGoodText = null;   // 上一次成功落盘的完整内容 —— 用来滚成 .bak

  /* ---------- 默认设置 ---------- */
  function defaultData() {
    return {
      schemaVersion: SCHEMA_VERSION,
      records: [],
      settings: {
        expenseCats: ['餐饮', '交通', '购物', '居住', '娱乐', '医疗', '人情', '学习', '通讯', '其他'],
        incomeCats: ['工资', '兼职', '红包', '理财', '退款', '其他'],
        accounts: ['微信', '支付宝', '现金', '银行卡'],
        noteCount: {},          // { 备注: 用过几次 } —— 备注备选按次数取前几个
        lastAccountByCat: {},   // { 分类名: 上次用的支付方式 } —— 按分类记忆
        lastBackupAt: 0,
        // 用户偏好（设置页里能改的那些）。
        // 这些是「口味问题」不是对错问题，所以做成开关让你自己换，而不是我拍板写死。
        prefs: {
          // 长辈模式：off 关闭 / big 大 / huge 特大。
          // 字号由它**直接决定**，没有单独的字号项 ——
          // 拆成两项时会出现「关掉长辈模式、字号却不跟着回去」的问题，
          // 用户还得手动再调一次。
          elder: 'off',
          amountColor: 'seal',    // 支出金额颜色：seal 印泥红 / ink 墨色
          weekStart: 1,           // 一周从周几算（1=周一，0=周日）
          defaultTab: 'ledger',   // 打开 App 停在哪个标签
          noteHints: 5,           // 备注备选显示几个
          backupDays: 30,         // 多少天没备份就在首页提醒（0 = 不提醒）
          theme: 'light'          // light 浅色 / dark 深色 / auto 跟随系统
        }
      },
      meta: { createdAt: Date.now() }
    };
  }

  /* ---------- 底层读写 ---------- */
  async function readRaw(name) {
    try {
      if (isNative) {
        const r = await window.Capacitor.Plugins.Filesystem.readFile({
          path: name, directory: 'DATA', encoding: 'utf8'
        });
        return typeof r.data === 'string' ? r.data : null;
      }
      return localStorage.getItem(LS_KEY + ':' + name);
    } catch (e) {
      return null; // 文件不存在是正常情况（第一次运行）
    }
  }

  async function writeRaw(name, text) {
    if (isNative) {
      await window.Capacitor.Plugins.Filesystem.writeFile({
        path: name, data: text, directory: 'DATA', encoding: 'utf8'
      });
    } else {
      localStorage.setItem(LS_KEY + ':' + name, text);
    }
  }

  // 改名（同目录内）。
  // 安卓那边 Capacitor 的 rename 内部是「先删目标、再 renameTo」，
  // 严格说不是原子操作 —— 但窗口是毫秒级，比"直接覆盖几 MB 文件"小几个数量级。
  async function renameRaw(from, to) {
    if (isNative) {
      await window.Capacitor.Plugins.Filesystem.rename({
        from: from, to: to, directory: 'DATA'
      });
    } else {
      const v = localStorage.getItem(LS_KEY + ':' + from);
      if (v !== null) localStorage.setItem(LS_KEY + ':' + to, v);
      localStorage.removeItem(LS_KEY + ':' + from);
    }
  }

  /* ---------- 初始化 ---------- */
  // init 阶段直接写主文件用这个 —— 顺手记下 lastGoodText，
  // 否则第一次 flush 时「上一份内容」还是空的，那之前主文件坏了就没有 .bak 可退。
  async function commitInit(text) {
    await writeRaw(DATA_FILE, text);
    lastGoodText = text;
  }

  async function init() {
    const raw = await readRaw(DATA_FILE);
    if (!raw) {
      // 主文件不在，但备份还在 —— 这只会发生在「临时文件改名成主文件」那一瞬间
      // 进程被杀。这时**绝不能**当成"第一次运行"直接建空账本，那等于把数据丢了。
      const bak0 = await readRaw(BAK_FILE);
      if (bak0) {
        try {
          db = migrate(JSON.parse(bak0));
          await commitInit(JSON.stringify(db));
          return { ok: true, source: 'backup', count: db.records.length,
            warn: '主文件不见了，已从备份恢复' };
        } catch (e) { /* 备份也读不出来，只能当新账本 */ }
      }
    }
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        // 结构要变了，先把改动前的原文整份留一份 —— 这是「改结构前自动导出」那条规定
        const fromVer = parsed.schemaVersion || 1;
        if (fromVer < SCHEMA_VERSION) {
          await writeRaw('xiaozi-data.before-v' + SCHEMA_VERSION + '.json', raw);
        }
        db = migrate(parsed);
        return { ok: true, source: 'file', count: db.records.length };
      } catch (e) {
        // 主文件坏了。**先把原文另存一份再动手** ——
        // 被截断的 JSON，尾部数据其实还在文本里（只是缺个 ]}），
        // 人工或者让 AI 补一下能救回大部分。直接覆盖掉就把唯一的证据毁了。
        // （原来的代码只在"备份也坏"那条分支里留档，这条反而没留 —— 顺序正好反了。）
        await writeRaw('xiaozi-data.corrupt-' + Date.now() + '.json', raw);

        const bak = await readRaw(BAK_FILE);
        if (bak) {
          try {
            db = migrate(JSON.parse(bak));
            await commitInit(JSON.stringify(db));
            return { ok: true, source: 'backup', count: db.records.length,
              warn: '主文件损坏，已从备份恢复' };
          } catch (e2) { /* 备份也坏 */ }
        }
        // 两个都坏：重建空库。坏文件上面已经另存了，绝不静默丢数据
        db = defaultData();
        await commitInit(JSON.stringify(db));
        return { ok: true, source: 'rebuilt', count: 0, warn: '数据文件损坏，已另存坏文件并重建空账本' };
      }
    }
    db = defaultData();
    await commitInit(JSON.stringify(db));
    return { ok: true, source: 'new', count: 0 };
  }

  // 结构升级的地方。以后加字段必须写在这里，不能直接改上面的结构
  function migrate(d) {
    if (!d.records) d.records = [];
    d.settings = Object.assign(defaultData().settings, d.settings || {});
    if (!d.meta) d.meta = { createdAt: Date.now() };

    // 注意：每一步升级都必须用版本号 gate 住，只能跑一次。
    // 如果不 gate，用户以后自己建一个叫「招商银行」的支付方式，
    // 每次启动都会被悄悄改回「银行卡」—— 这是个真实存在的隐患。
    const from = d.schemaVersion || 1;
    if (from < 2) mergeBanks(d);      // v1 → v2：银行类支付方式合并成「银行卡」

    // v3：备注改成按使用次数排序。
    // 注意这里必须用「版本号」判断，不能用「字段是否存在」——
    // 因为上面那行已经用默认值把 noteCount 补成了一个空对象（空对象是真的），
    // 用存在性判断的话这段永远不会执行，历史备注的次数就全是 0。
    if (from < 3) {
      const c = {};
      d.records.forEach(r => { if (r.note) c[r.note] = (c[r.note] || 0) + 1; });
      d.settings.noteCount = c;
    }

    d.schemaVersion = SCHEMA_VERSION;

    // 这两个字段已经没有任何读取方了，老数据里还留着，顺手清掉 ——
    // 别让它们继续假装有用：
    //   catUseCount  —— 分类顺序早就改成「手动顺序」（见踩坑 #18），这个字段只写不读
    //   noteHistory  —— 备注备选改用 noteCount（按次数），这个也只写不读
    delete d.settings.catUseCount;
    delete d.settings.noteHistory;
    return d;
  }

  // 2026-09-17 的变更：把「中国银行 / 交通银行 / 招商银行」等合并成一个「银行卡」
  // 具体是哪张卡写在备注里。这个函数是幂等的 —— 重复运行不会有任何副作用。
  function mergeBanks(d) {
    const ALIAS = ['中国银行', '交通银行', '招商银行', '工商银行', '建设银行',
      '农业银行', '邮政储蓄银行', '中信银行', '浦发银行'];
    const TARGET = '银行卡';
    const out = [];
    let placed = false;
    (d.settings.accounts || []).forEach(a => {
      if (ALIAS.indexOf(a) >= 0) {                    // 银行名 → 合并，且只放一次
        if (!placed && out.indexOf(TARGET) < 0) { out.push(TARGET); placed = true; }
        return;
      }
      if (out.indexOf(a) < 0) out.push(a);            // 顺便去重
    });
    if (!out.length) out.push('微信', '支付宝', '现金');
    d.settings.accounts = out;

    // 已有记录里的银行名也一并改掉，否则历史数据会指向一个不存在的支付方式
    d.records.forEach(r => { if (ALIAS.indexOf(r.account) >= 0) r.account = TARGET; });
    const m = d.settings.lastAccountByCat || {};
    Object.keys(m).forEach(k => { if (ALIAS.indexOf(m[k]) >= 0) m[k] = TARGET; });
  }

  /* ---------- 写入（防抖 + 原子落盘） ---------- */
  function scheduleSave() {
    if (writeTimer) clearTimeout(writeTimer);
    writeTimer = setTimeout(flush, 300);
  }

  /* 原子落盘。三步的顺序是刻意安排的：
       ① 新内容先写进临时文件 —— 这一步失败或被杀，主文件完好无损
       ② 临时文件改名成主文件 —— 有风险的窗口只有毫秒级
       ③ 上一份完整内容滚进 .bak —— 这一步被杀最多让 .bak 变坏，主文件仍然完好
     换句话说：**唯一有风险的那次写，动的是备份，不是正本。**

     为什么必须这样：Capacitor 的 writeFile 在安卓上就是
     FileOutputStream(截断) + 逐块写，没有临时文件、没有 fsync。
     写几 MB 要几百毫秒，这个窗口里进程被杀（系统回收、滑掉、断电）
     主文件就是一个半截 JSON —— 而这是唯一真正的"丢数据"入口。 */
  async function flush() {
    if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
    if (!db) return;
    const text = JSON.stringify(db);
    const prev = lastGoodText;
    try {
      await writeRaw(TMP_FILE, text);
      await renameRaw(TMP_FILE, DATA_FILE);
      lastGoodText = text;
      if (prev) await writeRaw(BAK_FILE, prev);
    } catch (e) {
      // 改名这条路失败了（个别机型/权限），退回直接写 —— 至少别让这次的改动丢掉
      try { await writeRaw(DATA_FILE, text); lastGoodText = text; } catch (e2) { /* 只能放弃这次 */ }
    }
  }

  /* ---------- 记录 ---------- */
  function uid() {
    return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function add(rec) {
    const r = Object.assign({
      id: uid(),
      type: 'expense',        // expense 支出 / income 收入 / void 不计收支
      amount: 0,              // 单位：分
      cat: '餐饮',
      account: '微信',
      date: todayStr(),
      time: nowTimeStr(),
      note: '',
      createdAt: Date.now()
    }, rec);
    db.records.push(r);

    // 学习用户习惯：按分类记住支付方式；备注按使用次数累计（备选栏用它排序）
    const s = db.settings;
    s.lastAccountByCat[r.cat] = r.account;
    if (r.note) {
      s.noteCount[r.note] = (s.noteCount[r.note] || 0) + 1;
    }
    scheduleSave();
    return r;
  }

  function update(id, patch) {
    const i = db.records.findIndex(r => r.id === id);
    if (i < 0) return null;
    db.records[i] = Object.assign({}, db.records[i], patch, { updatedAt: Date.now() });
    scheduleSave();
    return db.records[i];
  }

  // 删除：返回被删的记录，供「3 秒撤销」用
  function remove(id) {
    const i = db.records.findIndex(r => r.id === id);
    if (i < 0) return null;
    const gone = db.records.splice(i, 1)[0];
    scheduleSave();
    return gone;
  }

  function restore(rec) {
    if (!rec) return;
    db.records.push(rec);
    scheduleSave();
  }

  /* ---------- 查询 ---------- */
  function all() { return db.records.slice(); }
  function settings() { return db.settings; }
  function data() { return db; }

  // 某个月的记录（month 形如 '2026-09'），按时间倒序
  function byMonth(month) {
    return db.records
      .filter(r => r.date.slice(0, 7) === month)
      .sort((a, b) => (b.date + (b.time || '')).localeCompare(a.date + (a.time || '')));
  }

  function sum(list) {
    let expense = 0, income = 0;
    list.forEach(r => {
      if (r.type === 'expense') expense += r.amount;
      else if (r.type === 'income') income += r.amount;
    });
    return { expense, income, net: income - expense };
  }

  // 分类合计，按金额从大到小。
  // kind 默认 'expense'，传 'income' 就是按收入分类合计（统计页要在收支之间切）
  function byCategory(list, kind) {
    const k0 = kind || 'expense';
    const m = {};
    list.forEach(r => {
      if (r.type !== k0) return;
      m[r.cat] = (m[r.cat] || 0) + r.amount;
    });
    return Object.keys(m)
      .map(k => ({ cat: k, amount: m[k] }))
      .sort((a, b) => b.amount - a.amount);
  }

  function saveSettings(patch) {
    Object.assign(db.settings, patch);
    scheduleSave();
  }

  // 读一条偏好（带兜底：老数据里没有 prefs 时不会拿到 undefined）
  function pref(key) {
    const p = db.settings.prefs || {};
    const d = defaultData().settings.prefs;
    return (p[key] === undefined) ? d[key] : p[key];
  }

  function setPref(key, value) {
    if (!db.settings.prefs) db.settings.prefs = {};
    db.settings.prefs[key] = value;
    scheduleSave();
  }

  /* ---------- 分类 / 支付方式的管理 ----------
     listKey: 'expenseCats' | 'incomeCats' | 'accounts'
     前两个改的是记录的 cat 字段，accounts 改的是 account 字段。
     这些操作会动到已有账目，所以每一条都有对应的单测守着。 */

  const LIST_FIELD = { expenseCats: 'cat', incomeCats: 'cat', accounts: 'account' };

  function listOf(listKey) { return db.settings[listKey] || []; }

  // 某个分类/支付方式下有多少笔记录
  function usageOf(listKey, name) {
    const f = LIST_FIELD[listKey];
    if (!f) return 0;
    return db.records.filter(r => r[f] === name).length;
  }

  function addEntry(listKey, name) {
    const list = listOf(listKey);
    const n = String(name == null ? '' : name).trim();
    if (!n || n.length > 6) return { ok: false, why: n ? '名字最多 6 个字' : '名字不能为空' };
    if (list.indexOf(n) >= 0) return { ok: false, why: '已经有同名的了' };
    list.push(n);
    scheduleSave();
    return { ok: true };
  }

  function renameEntry(listKey, oldName, newNameRaw) {
    const list = listOf(listKey);
    const n = String(newNameRaw == null ? '' : newNameRaw).trim();
    const i = list.indexOf(oldName);
    if (i < 0) return { ok: false, why: '找不到这一项' };
    if (!n || n.length > 6) return { ok: false, why: n ? '名字最多 6 个字' : '名字不能为空' };
    if (n === oldName) return { ok: true, changed: 0 };
    if (list.indexOf(n) >= 0) return { ok: false, why: '已经有同名的了' };

    list[i] = n;
    const f = LIST_FIELD[listKey];
    let changed = 0;
    db.records.forEach(r => { if (r[f] === oldName) { r[f] = n; changed++; } });

    const s = db.settings;
    if (s.lastAccountByCat[oldName] !== undefined) {
      s.lastAccountByCat[n] = s.lastAccountByCat[oldName];
      delete s.lastAccountByCat[oldName];
    }
    if (listKey === 'accounts') {
      Object.keys(s.lastAccountByCat).forEach(k => {
        if (s.lastAccountByCat[k] === oldName) s.lastAccountByCat[k] = n;
      });
    }
    scheduleSave();
    return { ok: true, changed: changed };
  }

  // 删除。如果有记录在用，必须指定一个接管的名字（否则那些账目会指向不存在的分类）
  function removeEntry(listKey, name, reassignTo) {
    const list = listOf(listKey);
    const i = list.indexOf(name);
    if (i < 0) return { ok: false, why: '找不到这一项' };
    if (list.length <= 1) return { ok: false, why: '至少要留一项' };

    const used = usageOf(listKey, name);
    if (used > 0 && !reassignTo) return { ok: false, needReassign: true, used: used };

    list.splice(i, 1);
    let moved = 0;
    if (used > 0) {
      if (list.indexOf(reassignTo) < 0) list.push(reassignTo);
      const f = LIST_FIELD[listKey];
      db.records.forEach(r => { if (r[f] === name) { r[f] = reassignTo; moved++; } });
    }
    // 「按分类记住的支付方式」也要跟着改 —— 只删键是不够的。
    // 不改的话，值还指着已删除的那个支付方式，下次记这个分类的账
    // 就会悄悄写上一个不存在的支付方式（录入页那一排还会一个都不高亮）。
    // 注意：renameEntry 里一直是有 remap 的，删除这条路原来漏了。
    if (listKey === 'accounts' && reassignTo) {
      const m = db.settings.lastAccountByCat;
      Object.keys(m).forEach(k => { if (m[k] === name) m[k] = reassignTo; });
    }
    delete db.settings.lastAccountByCat[name];
    scheduleSave();
    return { ok: true, moved: moved };
  }

  function moveEntry(listKey, name, delta) {
    const list = listOf(listKey);
    const i = list.indexOf(name);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= list.length) return { ok: false };
    list.splice(i, 1);
    list.splice(j, 0, name);
    scheduleSave();
    return { ok: true };
  }

  /* ---------- 统计用的聚合 ---------- */

  function shiftMonth(m, delta) {
    const p = m.split('-').map(Number);
    const d = new Date(p[0], p[1] - 1 + delta, 1);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  }

  // 日历格子用：按天分别累计支出和收入。
  // 格子里显示的那个数字是「收入 − 支出」的当日结余，所以两个都要单独算。
  // 另外记「有没有任何记录」，用来区分"只有收入的日子"和"完全空白的日子"。
  function byDay(list) {
    const expense = {}, income = {}, count = {};
    list.forEach(r => {
      count[r.date] = (count[r.date] || 0) + 1;
      if (r.type === 'expense') expense[r.date] = (expense[r.date] || 0) + r.amount;
      else if (r.type === 'income') income[r.date] = (income[r.date] || 0) + r.amount;
    });
    return { expense: expense, income: income, count: count };
  }

  // 备注备选：按用过的次数从多到少取前 n 个。
  // 传了 q 就只留包含 q 的（打字时给提示）；不传 q 就是「你最常用的几个」。
  function topNotes(n, q) {
    const c = db.settings.noteCount || {};
    const query = String(q == null ? '' : q).trim();
    const keys = Object.keys(c).filter(k => k && (!query || k.indexOf(query) >= 0));
    keys.sort((a, b) => (c[b] - c[a]) || (a < b ? -1 : a > b ? 1 : 0));
    return keys.slice(0, n);
  }

  /* ---------- 搜索 ----------
     q       关键词（空则不按关键词过滤）
     type    'all' | 'expense' | 'income' | 'void'
     cat     'all' 或分类名
     from,to 日期区间（含端点，形如 '2026-09-01'）
     min,max 金额区间（单位：分，0 表示不限）
     结果按时间倒序。 */
  function search(opts) {
    opts = opts || {};
    const q = String(opts.q == null ? '' : opts.q).trim().toLowerCase();
    const minA = opts.min || 0, maxA = opts.max || 0;

    const out = db.records.filter(r => {
      if (opts.type && opts.type !== 'all' && r.type !== opts.type) return false;
      if (opts.cat && opts.cat !== 'all' && r.cat !== opts.cat) return false;
      if (minA && r.amount < minA) return false;
      if (maxA && r.amount > maxA) return false;
      if (opts.from && r.date < opts.from) return false;
      if (opts.to && r.date > opts.to) return false;
      if (q) {
        // 搜的地方：备注、分类、支付方式、金额、日期
        // 金额同时按「元」的显示文本和原始分值匹配，输 380 能命中 380.00
        const hay = [r.note || '', r.cat || '', r.account || '',
          fmt(r.amount), String(r.amount), r.date].join(' ').toLowerCase();
        if (hay.indexOf(q) < 0) return false;
      }
      return true;
    });

    out.sort((a, b) => (b.date + (b.time || '')).localeCompare(a.date + (a.time || '')));
    return out;
  }

  /* ---------- 导入导出 ---------- */
  function toJSON() { return JSON.stringify(db); }

  // 一条记录是不是"结构上能用"。
  // 为什么必须校验：备份文件是用户手里能编辑的东西（自己手改过、或者让 AI 帮忙
  // 合并两份备份，在这个项目里都不罕见），而**一条坏记录就足够毁掉整个账本**：
  //   amount 是字符串 "1250" → sum() 里 `expense += r.amount` 退化成字符串拼接
  //                            → 首页"本月支出"变成一个乱码数字（不报错！）
  //   缺 date                → byMonth() 里 r.date.slice() 直接抛错
  //                            → 首页整页只剩一条错误条，而且坏数据已经写进文件了
  // 所以宁可不导入那几条，并如实告诉用户跳过了多少条。
  function validRec(r) {
    return !!r
      && typeof r.id === 'string' && r.id.length > 0
      && Number.isSafeInteger(r.amount) && r.amount >= 0
      && typeof r.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.date)
      && ['expense', 'income', 'void'].indexOf(r.type) >= 0;
  }

  // 导入是「合并」，不是「覆盖」。
  // 覆盖会让你新记的账被一份旧备份冲掉 —— 那是灾难。
  // 合并规则：同一个 id 以 updatedAt 更新的为准；分类/支付方式/备注次数取并集。
  async function importJSON(text) {
    let incoming;
    try { incoming = JSON.parse(text); }
    catch (e) { throw new Error('这个文件不是有效的备份文件（不是 JSON）'); }
    if (!incoming || !Array.isArray(incoming.records)) {
      throw new Error('这个文件里没有账目数据，不是本 App 导出的备份');
    }

    const inc = migrate(incoming);   // 顺带把老结构升级、银行名合并

    const byId = {};
    db.records.forEach(r => { byId[r.id] = r; });
    let added = 0, updated = 0, skipped = 0;
    inc.records.forEach(r => {
      if (!validRec(r)) { skipped++; return; }
      const cur = byId[r.id];
      if (!cur) { db.records.push(r); byId[r.id] = r; added++; }
      else if ((r.updatedAt || 0) > (cur.updatedAt || 0)) { Object.assign(cur, r); updated++; }
    });

    // 分类与支付方式取并集，别因为导入把现有的弄丢
    ['expenseCats', 'incomeCats', 'accounts'].forEach(k => {
      const cur = db.settings[k] || [];
      const add = (inc.settings && inc.settings[k]) || [];
      const out = cur.slice();
      add.forEach(x => { if (out.indexOf(x) < 0) out.push(x); });
      db.settings[k] = out;
    });

    // 备注次数也要并进去 —— 不并的话，换手机/重装后导入备份，
    // 账目一笔不差全回来了，但**备注备选栏是空的**，用惯的「午饭 / 地铁」全没了。
    // （migrate 里那段"从记录里统计备注次数"是给老备份用的，算完就被丢掉了。）
    // 取 max 而不是相加：导入一份旧备份不该把现在的次数压低。
    const incCount = (inc.settings && inc.settings.noteCount) || {};
    Object.keys(incCount).forEach(n => {
      if (!n) return;
      db.settings.noteCount[n] = Math.max(db.settings.noteCount[n] || 0, incCount[n] || 0);
    });

    // 「按分类记住的支付方式」：现有缺哪个分类才补哪个，不覆盖已经学到的
    const incLast = (inc.settings && inc.settings.lastAccountByCat) || {};
    Object.keys(incLast).forEach(k => {
      if (!db.settings.lastAccountByCat[k]) db.settings.lastAccountByCat[k] = incLast[k];
    });

    await flush();
    return { added: added, updated: updated, skipped: skipped, total: db.records.length };
  }

  // 导出成 CSV，给 Excel 看。开头那个 \ufeff 是 BOM —— 不加的话
  // Excel 会把中文读成乱码（这是个经典坑）。
  function toCSV() {
    const typeName = { expense: '支出', income: '收入', void: '不计收支' };
    const esc = v => {
      const s = String(v === undefined || v === null ? '' : v);
      return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const lines = [['日期', '时间', '类型', '分类', '支付方式', '金额', '备注'].join(',')];
    db.records
      .slice()
      .sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')))
      .forEach(r => {
        lines.push([r.date, r.time || '', typeName[r.type] || r.type, r.cat, r.account,
          fmt(r.amount), r.note || ''].map(esc).join(','));
      });
    return '\ufeff' + lines.join('\r\n');
  }

  function daysSinceBackup() {
    const t = db.settings.lastBackupAt || 0;
    if (!t) return null;
    return Math.floor((Date.now() - t) / 86400000);
  }

  /* ---------- 工具 ---------- */
  function todayStr(d) {
    d = d || new Date();
    const p = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }
  function nowTimeStr() {
    const d = new Date();
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }
  // 分 → 显示字符串，例如 1250 → "12.50"
  function fmt(amount) {
    const neg = amount < 0;
    const a = Math.abs(amount);
    const s = Math.floor(a / 100) + '.' + String(a % 100).padStart(2, '0');
    return (neg ? '-' : '') + s;
  }
  // 千分位，例如 1250 → "12.50"，125000 → "1,250.00"
  function fmtGroup(amount) {
    const s = fmt(amount);
    const neg = s[0] === '-';
    const body = neg ? s.slice(1) : s;
    const parts = body.split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (neg ? '-' : '') + parts.join('.');
  }

  // 日历格子里用的极简金额：9900 分 → "99"，6650 分 → "66.5"，1234500 分 → "12.3k"
  function compactYuan(cents) {
    const y = cents / 100;
    if (y >= 10000) return Math.round(y / 1000) + 'k';
    if (y >= 1000) return (y / 1000).toFixed(1) + 'k';
    if (y >= 100) return String(Math.round(y));
    if (y === Math.round(y)) return String(y);
    return y.toFixed(1);
  }

  // 页面要走了，必须把没落地的写进去
  window.addEventListener('pagehide', () => { if (writeTimer) flush(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && writeTimer) flush();
  });

  // 这笔账是不是「补记」的：**录入那天** 和 **它记的那天** 不是同一天。
  // 为什么要判断这个：明细行的时间列显示的是**录入时刻**，
  // 而对一笔补记的账来说那个时刻没有意义 ——
  // 「9月1日 19:35」读起来像"9月1日晚上七点半花的"，实际上是昨天补录的。
  // 真机上就是这么被误读的（用户原话：「不清楚是今天的时间写的，还是昨天的时间写的」）。
  // 所以补记的记录，时间列改显示「补记」两个字。
  function isBackfilled(r) {
    if (!r || !r.createdAt || !r.date) return false;
    const d = new Date(r.createdAt);
    // 脏 createdAt（老数据、或被手工改过的备份）会得到 Invalid Date，
    // 那时 getFullYear() 是 NaN、拼出来 "NaN-NaN-NaN"，会**误判成补记**。
    // 宁可当成普通记录（老实显示时刻），也不要给用户乱贴「补记」标签。
    if (isNaN(d.getTime())) return false;
    const made = d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
    return made !== r.date;
  }

  return {
    init, all, settings, byMonth, sum, byCategory, byDay, shiftMonth, search,
    add, update, remove, restore, saveSettings, flush, pref, setPref,
    addEntry, renameEntry, removeEntry, moveEntry, usageOf, listOf, topNotes,
    toJSON, importJSON, toCSV, daysSinceBackup,
    fmt, fmtGroup, compactYuan, todayStr, isBackfilled,
    isNative,
    // 仅供自动化测试调用，界面代码不要用
    _test: { migrate: migrate, mergeBanks: mergeBanks, validRec: validRec }
  };
})();
