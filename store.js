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
          streakLine: 'on',       // 记账页「已记账 X 天 · 连续 Y 天」显不显示（v1.7.0）
          bdDim: 'cat',           // 统计页构成维度：cat 按分类 / pay 按支付方式（v1.7.0，切换即记住）
          backupDays: 30,         // 多少天没备份就在首页提醒（0 = 不提醒）
          theme: 'light'          // light 浅色 / dark 深色 / auto 跟随系统
        }
      },
      meta: { createdAt: Date.now() }
    };
  }

  /* ---------- 底层读写 ---------- */
  // Capacitor 在「文件不存在」时抛的错，文案是 "File does not exist"
  // （不同版本可能略有出入），所以这里宽松匹配。
  // localStorage 那条路不会抛 —— getItem 不存在时返回 null。
  function isMissingErr(e) {
    const m = String((e && (e.message || e.errorMessage)) || e || '');
    return /not exist|no such file|ENOENT/i.test(m);
  }

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
      // ⚠️ 以前这里一律 return null —— 于是「文件不存在」和「读失败」在 init 眼里
      // 完全一样，一次偶发读失败就会走「从 .bak 恢复」那条路，
      // 把好端端的主文件**回滚成上一份备份**，而且不可逆、不留档。
      // 现在把两种情况分开：真·不存在 → null；读失败 → 抛出去。
      if (isMissingErr(e)) return null;
      throw e;
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
    let raw = null, readErr = null;
    try { raw = await readRaw(DATA_FILE); } catch (e) { readErr = e; }

    // ① 「读不到」不等于「不存在」—— 这种情况**什么恢复动作都不要做**。
    //    走「从备份恢复」会把主文件回滚成上一份备份（丢一段数据、不可逆、不留档）；
    //    走「建空账本」更糟。宁可报错让用户重试，也别动磁盘上那份数据。
    if (readErr) {
      return { ok: false, source: 'unreadable', count: 0,
        warn: '读不到数据文件（可能是权限或存储问题）。为了不覆盖你的账本，' +
              '这次没有做任何恢复动作。重启 App 再试；如果一直这样，先别卸载，' +
              '把 App 数据目录里的 xiaozi-data.json 导出来。' };
    }

    // ② 主文件不在：磁盘上其实可能有两份可用的 —— .bak（上一份）和 .tmp（**最新**的）。
    //    这个状态只出现在「.tmp 改名成主文件」那一瞬间进程被杀。
    //    ⚠️ 先看 .tmp：rename 是「先删目标、再 renameTo」，被杀在中间时最新数据在
    //    .tmp 里，而 .bak 是**更旧**的那一份 —— 老逻辑只认 .bak，会白白丢数据。
    //    实测：.bak 10 条 / .tmp 16 条时，老逻辑恢复出 10 条，丢了 6 条。
    //    （.tmp 可能是写了一半的，解析失败就跳过它、退回 .bak。）
    if (!raw) {
      const pick = (t) => { try { return t ? migrate(JSON.parse(t)) : null; } catch (e) { return null; } };
      let tmp0 = null, bak0 = null;
      try { tmp0 = await readRaw(TMP_FILE); } catch (e) { /* 读不到就当没有 */ }
      try { bak0 = await readRaw(BAK_FILE); } catch (e) { /* 同上 */ }
      const fromTmp = pick(tmp0);
      const d = fromTmp || pick(bak0);
      if (d) {
        db = d;
        await commitInit(JSON.stringify(db));
        return { ok: true, source: fromTmp ? 'tmp' : 'backup', count: db.records.length,
          warn: fromTmp ? '主文件不见了，已从临时文件恢复（这是最新的那一份）'
                        : '主文件不见了，已从备份恢复' };
      }
      // 走到这里说明：三份文件都不在，**或者**它们在、但一份都解析不出来。
      // 后者是「曾经有数据、现在坏了」—— 不能静默当新账本：用户会看到一个空账本、
      // 一句提示都没有，而坏文件在第一次落盘时就被覆盖掉了。
      if (tmp0 || bak0) {
        if (bak0) {
          try { await writeRaw('xiaozi-data.corrupt-bak-' + Date.now() + '.json', bak0); } catch (e) { /* 留档失败就算了 */ }
        }
        db = defaultData();
        await commitInit(JSON.stringify(db));
        return { ok: true, source: 'rebuilt', count: 0,
          warn: '主文件和备份都读不出来了，已把坏文件另存一份并重建空账本' };
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
        // ⚠️ 正常启动这条路上也要记下 lastGoodText —— 不记的话，
        // 开机后**第一次**落盘时 prev 是空的，于是不会滚 .bak：
        // 那一整段时间里 .bak 还停在上一会话的旧版本，安全网是漏的。
        // （commitInit 的注释说的就是这件事，但以前只有新账本/恢复那三条分支调了它。）
        lastGoodText = JSON.stringify(db);
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
        // 两个都坏：重建空库。坏的主文件上面已经另存了，**坏备份也要留一份** ——
        // 不然开机后第一次落盘就把它覆盖了，那也是一份证据。
        if (bak) {
          try { await writeRaw('xiaozi-data.corrupt-bak-' + Date.now() + '.json', bak); } catch (e3) { /* 留档失败就算了 */ }
        }
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
      // 只统计「能用的记录」—— 不然坏记录的备注会混进备选栏。
      // （导入一份 v2 老备份时，被 validRec 拒收的那几条，它们的备注
      //   会出现在备注备选里，点一下就把一个只存在于坏记录里的词填进去了。）
      d.records.forEach(r => { if (r.note && validRec(r)) c[r.note] = (c[r.note] || 0) + 1; });
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
  /* 落盘（带「正在写」保护）。
     ⚠️ 这个锁是必须的，别删：flush 的三步全是 await，两次调用会**交错往同一个
     TMP_FILE 写** —— 两个 FileOutputStream 开在同一路径上，后开的把文件截断、
     先开的还按自己的偏移继续写，落盘内容就成了两份的混合物，主文件和 .bak 会
     **一起坏掉**。实测：300 条的账本并发落盘一次，主文件从 49694 字节变成 20 字节，
     下次启动直接重建空账本（300 条全丢，坏文件也救不回来）。
     触发路径很日常：① 连点两次「导出备份」（导出里直接 await flush）；
     ② 防抖 300ms 撞上一次落盘 —— 账本越大一次落盘越久，这个窗口就越宽。
     并发时后来的调用**排队**（`flushing.then(() => flush())`），而不是直接复用
     前一个 Promise —— 复用会让「这一次的改动」根本没被写进去。 */
  let flushing = null;

  function flush() {
    if (flushing) return flushing.then(() => flush());
    flushing = doFlush().finally(() => { flushing = null; });
    return flushing;
  }

  // 最后一次落盘失败的原因（成功时清空）。
  let lastWriteError = null;

  async function doFlush() {
    if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
    if (!db) return true;
    const text = JSON.stringify(db);
    const prev = lastGoodText;
    try {
      await writeRaw(TMP_FILE, text);
      await renameRaw(TMP_FILE, DATA_FILE);
      lastGoodText = text;
      if (prev) await writeRaw(BAK_FILE, prev);
      lastWriteError = null;
      return true;
    } catch (e) {
      // 改名这条路失败了（个别机型/权限），退回直接写 —— 至少别让这次的改动丢掉
      try {
        await writeRaw(DATA_FILE, text);
        lastGoodText = text;
        lastWriteError = null;
        return true;
      } catch (e2) {
        // 两次都失败了。**必须让上层知道** —— PWA 撞上 localStorage 配额就是这种情况：
        // 从这一刻起**全部不再落盘**（磁盘冻结在最后一版），而界面还在说「已记下」。
        // 以前这两层 catch 全吞掉，用户完全无感，刷新页面才发现记录没了。
        lastWriteError = e2;
        return false;
      }
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
      // 默认分类/支付方式取当前清单的第一项，而不是写死「餐饮」「微信」——
      // 写死的话，用户把那一项删掉之后，任何没传这两个字段的调用都会写进
      // 一个**不存在的名字**（界面层一直会传，所以以前没暴露出来）。
      cat: (db.settings.expenseCats && db.settings.expenseCats[0]) || '餐饮',
      account: (db.settings.accounts && db.settings.accounts[0]) || '微信',
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

    // 编辑也要「学习」：把一笔账的支付方式从微信改成现金之后，
    // 「按分类记住的支付方式」该记的是**现金**（你刚选的那个），
    // 否则下次记这个分类时默认还是微信 —— 也就是你刚刚改走的那个。
    // （add() 一直有这一步，update() 没有，两条路不对称。）
    // ⚠️ noteCount 这里**故意不动**：它统计的是「这个备注用过几次」，
    //    编辑一下不该让计数 +1（那是新增的语义）。
    const r = db.records[i];
    if (r.account) db.settings.lastAccountByCat[r.cat] = r.account;

    scheduleSave();
    return r;
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

  // 支付方式合计，按金额从大到小（v1.7.0：统计页「按支付方式」看构成）。
  // 口径与 byCategory **完全一致**：只算 kind 那一类，「不计收支」天然被排除
  //（红线：void 必须在每一处统计里被排除）。
  // 为什么单独一个函数、不给 byCategory 加参数合并：两者返回的字段名不同
  //（cat / account），合并后两个调用方都开始字段串台（分类管理那类 bug 的温床）。
  function byPayMethod(list, kind) {
    const k0 = kind || 'expense';
    const m = {};
    list.forEach(r => {
      if (r.type !== k0) return;
      // 缺 account 的脏记录归到「（没填）」，不丢金额 —— 口径上要对得上总数
      const a = r.account || '（没填）';
      m[a] = (m[a] || 0) + r.amount;
    });
    return Object.keys(m)
      .map(k => ({ account: k, amount: m[k] }))
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
     这些操作会动到已有账目。⚠️ 这里以前写的是「每一条都有对应的单测守着」——
     那是**假的**：全项目只有 fixTest.js 里一条 removeEntry('accounts',…)，
     renameEntry / moveEntry / usageOf / addEntry 一条测试都没有。
     而正是这个盲区，让「改支出分类会串到收入记录」那个 bug 活到了 v1.6.5。
     现在这一块由 catManageTest.js 覆盖（v1.7.0 落地，19 项）。 */

  const LIST_FIELD = { expenseCats: 'cat', incomeCats: 'cat', accounts: 'account' };

  function listOf(listKey) { return db.settings[listKey] || []; }

  /* 一条记录算不算「用到了 listKey 里这个叫 name 的项」。
     ⚠️ 为什么必须带类型判断：分类的**支出和收入共用 r.cat 这一个字段**，
     但两个清单是分开的 —— 只按名字匹配就会串到另一种类型上去。
     默认数据里 expenseCats 和 incomeCats **都有「其他」**，所以这不是理论路径：
     把支出分类「其他」改个名，收入里记成「其他」的那些记录会被一起改掉，
     而且改成一个不属于收入分类的孤儿名（录入页点开它，分类格一个都不高亮）。
     accounts（支付方式）是单独一个字段，不分类型。 */
  function recMatch(listKey, r, name) {
    const f = LIST_FIELD[listKey];
    if (!f || r[f] !== name) return false;
    if (listKey === 'expenseCats') return r.type === 'expense';
    if (listKey === 'incomeCats') return r.type === 'income';
    return true;
  }

  // 某个分类/支付方式下有多少笔记录
  function usageOf(listKey, name) {
    if (!LIST_FIELD[listKey]) return 0;
    return db.records.filter(r => recMatch(listKey, r, name)).length;
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
    db.records.forEach(r => { if (recMatch(listKey, r, oldName)) { r[f] = n; changed++; } });

    // 「按分类记住的支付方式」是「分类 → 支付方式」的映射：**键是分类，值是支付方式**。
    // 所以改分类名要动**键**、改支付方式名要动**值** —— 以前这里没分先后，
    // 名字一撞车（比如分类和支付方式都叫「其他」）就会动错，把记忆弄丢。
    const s = db.settings;
    if (listKey === 'accounts') {
      Object.keys(s.lastAccountByCat).forEach(k => {
        if (s.lastAccountByCat[k] === oldName) s.lastAccountByCat[k] = n;
      });
    } else if (s.lastAccountByCat[oldName] !== undefined) {
      s.lastAccountByCat[n] = s.lastAccountByCat[oldName];
      delete s.lastAccountByCat[oldName];
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
      db.records.forEach(r => { if (recMatch(listKey, r, name)) { r[f] = reassignTo; moved++; } });
    }
    // 「按分类记住的支付方式」跟着改。
    // ⚠️ 两条路都要处理，而且**不能绑在 reassignTo 上**：
    //   · 删支付方式 → 把**值**等于它的键 remap 到接管项；没有接管项
    //     （used === 0，界面最常走的那条路）就**删掉这些键** —— 留着的话，
    //     下次记那个分类的账会悄悄写上一个已删除的支付方式，录入页那一排一个都不高亮。
    //     （上一轮修 B3 时只补了 reassignTo 那条路，所以 used=0 这条路一直漏着。）
    //   · 删分类 → 删掉这个**键**（键才是分类）。
    // 以前这里是「无条件 delete 键 + 只在 reassignTo 时 remap 值」，
    // 结果两头都不对：used=0 时留孤儿，名字撞车时又会删错键。
    const m = db.settings.lastAccountByCat;
    if (listKey === 'accounts') {
      Object.keys(m).forEach(k => {
        if (m[k] === name) { if (reassignTo) m[k] = reassignTo; else delete m[k]; }
      });
    } else {
      delete m[name];
    }
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

  // 累计 / 连续记账天数（v1.7.0：记账页那一行小字）。
  //   totalDays：有记录的**不同日期**数 —— 同一天记 5 笔也算 1 天；
  //              「不计收支」也算记了（它不进金额统计，但那天确实动账了）
  //   streak：从「最近有记录的那天」往前逐天数的连续天数。
  //            规则：最近记录日离今天**超过 1 天**才算断（=0）。
  //            为什么「今天还没记」不算断：晚上才记账的人不该在零点瞬间清零 ——
  //            昨天记过就还算连着，今天之内补上就续。
  // 日期差按 UTC 天数算（见 dayNum），不受夏令时/时区影响。
  function streak(list, today) {
    const t = today || todayStr();
    const days = {};
    (list || []).forEach(r => { if (r && typeof r.date === 'string') days[r.date] = 1; });
    const keys = Object.keys(days).sort();          // 升序，最后一个是最近
    const totalDays = keys.length;
    if (!totalDays) return { totalDays: 0, streak: 0 };

    const last = keys[keys.length - 1];
    if (dayNum(t) - dayNum(last) > 1) return { totalDays: totalDays, streak: 0 };

    let n = 1;
    for (let i = keys.length - 1; i > 0; i--) {
      if (dayNum(keys[i]) - dayNum(keys[i - 1]) === 1) n++;
      else break;
    }
    return { totalDays: totalDays, streak: n };
  }
  // 'YYYY-MM-DD' → 天序号（UTC 日期部分 / 864e5）。只用于日期差，不做本地时间换算
  function dayNum(s) {
    const p = String(s).split('-').map(Number);
    return Math.floor(Date.UTC(p[0], p[1] - 1, p[2]) / 864e5);
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
     pay     'all' 或支付方式名（v1.7.0 加）
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
      // 支付方式过滤（v1.7.0）。搜索页的筛选维度之一 ——
      // 搜「这个月微信付了多少」以前只能靠关键词碰运气，现在能正经筛。
      // 注意这是**搜索**不是统计：void 记录在搜索里本来就该能搜到，
      // 所以这里不排除它（排除只发生在 byCategory / byPayMethod / sum 这类统计里）。
      if (opts.pay && opts.pay !== 'all' && (r.account || '') !== opts.pay) return false;
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
    // 这四项是「没法兜底」的：id 缺了就没法合并（每次导入都会新增，重复导入会翻倍）、
    // amount/date/type 缺了这笔账本身就不成立。其余字段缺了都走 fixRec 补默认值。
  }

  /* 导入时把「可以补」的字段补上。
     为什么不直接跳过：用户手改过的备份（比如从 Excel 转过来）很容易漏掉
     account 这种字段，一跳过就是**整批记录都进不来**，他会看到「跳过 30 笔」。
     对记账 App 来说「补一个默认值」比「丢掉一整笔账」好得多 ——
     分类和支付方式事后都能改，丢掉的账找不回来。
     （cat 缺了补「其他」，account 缺了补清单第一项 —— 都是当前账本里真实存在的名字。） */
  function fixRec(r) {
    if (typeof r.cat !== 'string' || !r.cat) r.cat = '其他';
    if (typeof r.account !== 'string' || !r.account) {
      r.account = (db.settings.accounts && db.settings.accounts[0]) || '微信';
    }
    if (typeof r.note !== 'string') r.note = '';
    if (typeof r.time !== 'string') r.time = '';
    return r;
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

    // ⚠️ 形态校验必须在**动内存之前**做完。
    // 以前这里没有校验：三个清单要是字符串而不是数组（手改过、或让 AI 合并过的
    // 备份很常见），下面那句 add.forEach 会抛错 —— 而那时**记录已经并进 db 了**。
    // 用户看到的是「导入失败：add.forEach is not a function」，以为没导成，
    // 之后随便记一笔触发落盘，那批"失败"的记录就悄悄进了文件。
    ['expenseCats', 'incomeCats', 'accounts'].forEach(k => {
      const v = inc.settings && inc.settings[k];
      if (v !== undefined && !Array.isArray(v)) {
        throw new Error('这个备份里的「' + k + '」不是列表格式，没法合并。' +
          '如果你手工改过这个文件，检查一下这一项；没改过的话它可能已经损坏了。');
      }
    });

    const byId = {};
    db.records.forEach(r => { byId[r.id] = r; });
    let added = 0, updated = 0, skipped = 0;
    inc.records.forEach(r => {
      if (!validRec(r)) { skipped++; return; }
      fixRec(r);                       // 缺的字段补默认值，别因为少个 account 就丢掉一整笔
      const cur = byId[r.id];
      if (!cur) { db.records.push(r); byId[r.id] = r; added++; }
      else {
        // 两边都有这条记录，怎么定谁赢：
        //   · 有 updatedAt 的按时间比（谁新谁赢）—— 老规则
        //   · **两边都没有 updatedAt** → 以导入的为准
        //     Store.add 从不写 updatedAt（只有 update 才写），所以「从没被编辑过的
        //     记录」两边都没有它。老规则在这种平局里判给现有记录，导致
        //     「用一份手改过的备份纠正账目」这条路走不通：备份里改了金额但没加
        //     updatedAt，导入结果是「新增 0 笔，更新 0 笔」，用户以为恢复成功了，
        //     其实账目一点没变（实测过）。而这正是加字段校验时假设会发生的场景。
        const ri = r.updatedAt || 0, ci = cur.updatedAt || 0;
        if (ri > ci || (ri === ci && JSON.stringify(r) !== JSON.stringify(cur))) {
          Object.assign(cur, r); updated++;
        }
      }
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
        lines.push([r.date, isBackfilled(r) ? '补记' : (r.time || ''), typeName[r.type] || r.type, r.cat, r.account,
          fmt(r.amount), r.note || ''].map(esc).join(','));
      });
    return '\ufeff' + lines.join('\r\n');
  }

  function daysSinceBackup() {
    const t = db.settings.lastBackupAt || 0;
    if (!t) return null;
    // 夹到 0：用户把系统日期往回调过的话，差值会是负数 ——
    // 那时备份提醒会消失、弹窗里会显示「-3 天前」。
    return Math.max(0, Math.floor((Date.now() - t) / 86400000));
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
    init, all, settings, byMonth, sum, byCategory, byPayMethod, byDay, shiftMonth, search, streak,
    add, update, remove, restore, saveSettings, flush, pref, setPref,
    addEntry, renameEntry, removeEntry, moveEntry, usageOf, listOf, topNotes,
    toJSON, importJSON, toCSV, daysSinceBackup,
    fmt, fmtGroup, compactYuan, todayStr, isBackfilled,
    isNative,
    // 仅供自动化测试调用，界面代码不要用
    _test: { migrate: migrate, mergeBanks: mergeBanks, validRec: validRec }
  };
})();
