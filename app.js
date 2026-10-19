/* ============================================================
   小资记账 · 界面逻辑
   ============================================================ */
(function () {
  const $ = id => document.getElementById(id);

  /* ---------------------------------------------------------
     先把「出错就显示在屏幕上」装上。
     必须放在最前面 —— 模块顶层的接线一旦抛错，后面的自检根本跑不到。
     上次就是这样：我把统计页顶栏换掉时删了一个元素，代码还在引用它，
     结果整个界面白屏、数据全空，而我这边一点提示都没有，只能靠截图猜。
     --------------------------------------------------------- */
  function showFatal(msg) {
    try {
      let bar = document.getElementById('fatal-bar');
      if (!bar) {
        bar = document.createElement('div');
        bar.id = 'fatal-bar';
        bar.style.cssText = 'position:fixed;left:0;right:0;top:0;z-index:999;background:#A8342A;' +
          'color:#fff;font-size:11px;padding:8px 12px;line-height:1.6;word-break:break-all;' +
          // 红条在 iPhone PWA 上必须让出刘海/状态栏，否则第一行字正好被盖住 ——
          // 「让错误可见」的机制在最需要它的渠道上看不清，就白装了。
          'padding-top:calc(8px + var(--safe-area-inset-top, env(safe-area-inset-top, 0px)))';
        // 点一下就关掉 —— 否则一条永不消失的红条压在最上面，比问题本身还烦人
        bar.addEventListener('click', function () {
          bar.style.display = 'none';
          if (document.getElementById('fatal-dot')) document.getElementById('fatal-dot').style.display = 'block';
        });
        document.body.appendChild(bar);
        // 关掉之后留一个小圆点，提醒"这里还有一条没处理的提示"
        const dot = document.createElement('div');
        dot.id = 'fatal-dot';
        dot.style.cssText = 'display:none;position:fixed;right:8px;' +
          'top:calc(8px + var(--safe-area-inset-top, env(safe-area-inset-top, 0px)));' +
          'z-index:999;width:8px;height:8px;border-radius:50%;background:#A8342A';
        dot.addEventListener('click', function () {
          bar.style.display = 'block'; dot.style.display = 'none';
        });
        document.body.appendChild(dot);
      }
      bar.style.display = 'block';
      bar.textContent = msg;
      const d = document.getElementById('fatal-dot');
      if (d) d.style.display = 'none';
    } catch (e) { /* 连提示都画不出来就只能认了 */ }
  }
  window.addEventListener('error', function (e) {
    showFatal('出错：' + (e.message || e.error) +
      '（' + String(e.filename || '').split('/').pop() + ' 第 ' + e.lineno + ' 行）');
  });
  window.addEventListener('unhandledrejection', function (e) {
    showFatal('异步出错：' + ((e.reason && e.reason.message) || e.reason));
  });

  const isNative = Store.isNative;
  // 版本号：设置页底部会显示它，方便确认手机上装的到底是哪一版。
  // 改版本时这三处要一起改：这里、package.json、android/app/build.gradle。
  const APP_VERSION = '1.7.1';

  const Haptics = isNative && window.Capacitor.Plugins.Haptics;

  let month = Store.todayStr().slice(0, 7);   // 当前查看的月份 '2026-09'
  let expr = '';                               // 金额键盘上正在输入的表达式
  let editingId = null;                        // 正在编辑的记录 id（null = 新增）
  let draftToday = '';                         // 打开录入页那一刻的「今天」（用于跨零点判断）
  let draft = null;                            // 录入页的当前状态
  let undoAction = null;                       // 撤销条当前的动作
  let undoTimer = null;

  /* ---------------------------------------------------------
     工具
     --------------------------------------------------------- */
  function buzz(style) {
    if (!Haptics) return;
    try {
      // impact 返回 Promise：同步 try/catch 抓不到 rejection，
      // 插件一拒收就会走 unhandledrejection → 每次按键弹一条红条。
      const p = Haptics.impact({ style: style || 'LIGHT' });
      if (p && typeof p.catch === 'function') p.catch(function () {});
    } catch (e) {}
  }

  function toast(msg, ms) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(t._t);
    t._t = setTimeout(() => t.classList.remove('show'), ms || 1600);
  }

  // 底部横条：既用于「已记下 / 再记一笔」，也用于「已删除 / 撤销」
  // 这条横条现在承载三件事，用 kind 区分：
  //   'redo'   —— 已记下 / 再记一笔
  //   'undo'   —— 已删除 / 撤销。⚠️ **不能被「记一笔」顶掉**：删错了想撤销，
  //               手快点了「＋ 记一笔」就再也撤不回来了，而且没有任何提示。
  //   'backup' —— 备份已准备好 / 已经发出去了
  let undoKind = '';
  function showBar(text, btnText, action, ms, kind) {
    const bar = $('undo');
    $('undo-text').textContent = text;
    $('undo-btn').textContent = btnText;
    undoAction = action;
    undoKind = kind || 'redo';
    bar.classList.add('show');
    clearTimeout(undoTimer);
    undoTimer = setTimeout(() => { bar.classList.remove('show'); undoAction = null; }, ms || 4200);
  }
  // onlyKind 传了就只关这一类（openEntry 只该顶掉「再记一笔」，不该顶掉「撤销」）
  function hideBar(onlyKind) {
    if (onlyKind && undoKind !== onlyKind) return;
    $('undo').classList.remove('show');
    clearTimeout(undoTimer);
    undoAction = null;
    undoKind = '';
  }
  // 「优先保撤销」的 showBar：撤销条还在显示时，保存一笔/导出完成不要顶掉它
  //（第三轮审查 🟠 B6：注释承诺过「undo 不能被顶掉」，但 doSave 的 showBar
  //  是无条件覆盖 —— 删错了手快记一笔就永远撤不回来了）。
  function showBarUnlessUndo(text, btnText, action, ms, kind) {
    if (undoKind === 'undo' && $('undo').classList.contains('show')) {
      toast(text, Math.max(1800, Math.min(ms || 2000, 3200)));
      return;
    }
    showBar(text, btnText, action, ms, kind);
  }
  $('undo-btn').addEventListener('click', () => {
    if (undoAction) undoAction();
    hideBar();
  });

  function monthLabel(m) {
    const [y, mm] = m.split('-');
    return parseInt(y, 10) + ' 年 ' + parseInt(mm, 10) + ' 月';
  }
  const shiftMonth = Store.shiftMonth;
  function dayLabel(dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const wd = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][new Date(y, m - 1, d).getDay()];
    const today = Store.todayStr();
    let head = m + '月' + d + '日';
    if (dateStr === today) head = '今天';
    else if (dateStr === Store.todayStr(new Date(Date.now() - 864e5))) head = '昨天';
    return head + ' ' + wd;
  }

  /* ---------------------------------------------------------
     记账页
     --------------------------------------------------------- */
  /* 首页那个大数字：换月、或者刚记完一笔之后，让它从旧值滚到新值，
     而不是「啪」地跳过去。只滚数字部分 —— ¥ 和 .00 那一截是装饰，
     跟着滚反而晃眼。
     （.total 上有 font-variant-numeric:tabular-nums，所以滚动过程中宽度不会抖。）
     三个细节：
       · 第一次渲染不滚 —— 否则开 App 时数字从 0 滚上来，像在加载
       · 用 token 取消上一个动画 —— 连点月份时会有好几个 rAF 同时在跑，
         不取消的话它们互相覆盖，数字会乱跳
       · 系统开了「减弱动态效果」就直接画，不滚 */
  let totalPainted = null, totalToken = 0;
  function renderTotal(cents) {
    const el = $('total');
    const paint = (c) => {
      totalPainted = c;                    // 记下「屏幕上真正显示的值」
      const t = Store.fmtGroup(c);
      const dot = t.lastIndexOf('.');
      el.innerHTML = '<span class="cur">¥</span>' + t.slice(0, dot) +
        '<span class="dec">' + t.slice(dot) + '</span>';
      // 长辈模式放大字号后，百万级金额会溢出容器、被 .pages 裁掉右边
      // （第三轮审查 🟠 B14，实测 1.45 倍下 ¥1,240,216.46 溢出 51px）。
      // 量一下，超了就加 long —— CSS 里再降一档字号。
      el.classList.toggle('long', el.scrollWidth > el.clientWidth + 1);
    };

    // ⚠️ 起点要用 totalPainted（屏幕上当前那个值），不是上一次的**目标**。
    // 上一次动画被打断时显示值停在半路（比如 1944），而目标已经是 2200 ——
    // 这时新动画从 2200 起步，肉眼看就是「数字先窜上去一下再掉下来」。
    const from = totalPainted;
    const my = ++totalToken;

    const calm = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (from === null || from === cents || calm) { paint(cents); return; }

    const t0 = performance.now(), DUR = 420;
    (function step(now) {
      if (my !== totalToken) return;               // 已经被下一次渲染取代了
      const p = Math.min(1, (now - t0) / DUR);
      const e = 1 - Math.pow(1 - p, 3);            // ease-out：先快后慢，收尾稳
      paint(Math.round(from + (cents - from) * e));
      if (p < 1) requestAnimationFrame(step);
    })(t0);
  }

  function renderLedger() {
    const list = Store.byMonth(month);
    const s = Store.sum(list);

    $('btn-month').textContent = monthLabel(month);
    $('mo-label').textContent = monthLabel(month);

    renderTotal(s.expense);
    $('sum-income').textContent = Store.fmtGroup(s.income);
    $('sum-net').textContent = (s.net < 0 ? '-' : '') + Store.fmtGroup(Math.abs(s.net));

    renderDelta(s.expense);
    renderStreak();
    renderBreakdown(list, s.expense);
    renderList(list);
    renderStats();
    updateBackupHint();
  }

  // 比上月同期：本月比到「今天几号」，上月也比到同一天，这样才公平
  function renderDelta(thisExpense) {
    const today = Store.todayStr();
    const isThisMonth = month === today.slice(0, 7);
    const lastMonth = shiftMonth(month, -1);

    let prevRecs = Store.byMonth(lastMonth);
    if (isThisMonth) {
      const cut = parseInt(today.slice(8), 10);
      prevRecs = prevRecs.filter(r => parseInt(r.date.slice(8), 10) <= cut);
    }
    const prev = Store.sum(prevRecs).expense;
    const el = $('delta');

    if (prev === 0) {
      el.className = 'delta';
      el.innerHTML = isThisMonth ? '上月同期没有记录' : '上月没有支出记录';
      return;
    }
    const diff = thisExpense - prev;
    // 两边一样时以前会显示「比上月同期少 0.00 / −0%」—— 数字对，话是错的。
    if (diff === 0) {
      el.className = 'delta';
      el.innerHTML = isThisMonth ? '和上月同期一样' : '和上月一样';
      return;
    }
    const pct = Math.round(Math.abs(diff) / prev * 1000) / 10;
    const up = diff > 0;
    el.className = 'delta ' + (up ? 'up' : 'down');
    el.innerHTML = '<b>' + (isThisMonth ? '比上月同期' : '比上月') + (up ? '多' : '少') + ' ' +
      Store.fmtGroup(Math.abs(diff)) + '</b>' +
      '<span class="pill">' + (up ? '+' : '−') + pct + '%</span>';
  }

  // 累计 / 连续记账天数（v1.7.0）：「已记账 X 天 · 连续 Y 天」。
  // 算法在 store.js 的 streak()；显示与否是口味问题 → 设置页「记账天数」开关。
  // 断了（连续 0 天）就不显示「连续」那一段，避免「连续 0 天」这种废话。
  function renderStreak() {
    const el = $('streakline');
    if (!el) return;
    if (Store.pref('streakLine') === 'off') { el.style.display = 'none'; return; }
    el.style.display = '';
    const s = Store.streak(Store.all());
    el.textContent = '已记账 ' + s.totalDays + ' 天' +
      (s.streak > 0 ? ' · 连续 ' + s.streak + ' 天' : '');
  }

  function renderBreakdown(list, totalExpense) {
    const cats = Store.byCategory(list);
    const box = $('breakdown');
    if (!cats.length) { box.style.display = 'none'; return; }
    box.style.display = '';

    const top = cats.slice(0, 6);
    const colors = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5)', 'var(--s6)'];

    // 条子取前 6 名，再补一段「其他」把零头收进来。
    // 不补的话：条子的总宽对应的是「前 6 名之和」，而图例里的百分比是按**整月**算的，
    // 两个口径不一致 —— 长尾越长，每一段被放大得越多（前 6 名只占整月 80% 时，每段放大约 25%）。
    // 这不是"不好看"，是图在说谎。统计页的环形图一直是补了「其他」的，这里对齐。
    const rest = cats.slice(6).reduce((a, c) => a + c.amount, 0);
    const segs = top.map((c, i) => ({ cat: c.cat, amount: c.amount, col: colors[i] }));
    // merged:true 标记「长尾合计」。它借用了「其他」这个名字，但点进去不能按
    // 真实分类「其他」过滤 —— 否则段宽 500 元、明细 5000 元（第三轮审查 🟠 B8）。
    if (rest > 0) segs.push({ cat: '其他', amount: rest, col: 'var(--s6)', merged: true });

    $('bar').innerHTML = segs.map(c =>
      '<i style="background:' + c.col + ';flex:' + c.amount + '" title="' + esc(c.cat) + ' ' +
      Store.fmtGroup(c.amount) + '"></i>').join('');

    $('legend').innerHTML = top.map((c, i) => {
      const pct = totalExpense ? Math.round(c.amount / totalExpense * 100) : 0;
      return '<span data-cat="' + esc(c.cat) + '"><i class="dot" style="background:' + colors[i] + '"></i>' +
        '<span class="nm">' + esc(c.cat) + '</span>' + Store.fmtGroup(c.amount) +
        '<span class="pc">' + pct + '%</span></span>';
    }).join('');

    // 点构成条 / 图例 → 去统计页看这个分类的明细
    // ⚠️ 两处选择器都必须精确：
    //   · 图例那一侧要写 `#legend > span`（**只用直接子元素**）。图例每一项里还有
    //     `.nm`（分类名）和 `.pc`（百分比）两个内层 span，写成 `#legend span` 会把
    //     它们也算进来 —— 于是序号整体错位：点第 2 个分类会跳去看第 4 个的明细，
    //     再往后的直接越界、点了没反应。而且点分类名时内层先触发、外层再触发，
    //     最后一次覆盖前一次，所以「第 1 项刚好是对的」，看着像能用。
    //     （这条是两个独立审查各自用 headless 测出来的，9 组数据全部吻合。）
    //   · 序号直接由 forEach 给，不再用 idx - top.length 反推。
    document.querySelectorAll('#bar i').forEach((el, i) => {
      el.addEventListener('click', () => {
        if (!segs[i]) return;
        if (segs[i].merged) { toast('这一段是前 6 名之外的长尾合计，点图例里的分类看明细'); return; }
        goStats(segs[i].cat, month);
      });
    });
    document.querySelectorAll('#legend > span[data-cat]').forEach((el, i) => {
      el.addEventListener('click', () => { if (top[i]) goStats(top[i].cat, month); });
    });
  }

  // 明细行的「时间」那一格。
  // 正常记录显示录入时刻；补记的显示「补记」两个字 ——
  // 录入时刻对一笔补记的账没有意义，还会被误读成「那天的那个钟点」
  // （判断逻辑在 store.js 的 isBackfilled）。
  function timeCell(r) {
    return Store.isBackfilled(r) ? '补记' : (r.time || '');
  }

  function renderList(list) {
    const box = $('list');
    if (!list.length) {
      box.innerHTML = '<div class="empty">' + monthLabel(month) + '还没有记录<br>点上面的「记一笔」开始</div>';
      return;
    }
    const days = {};
    list.forEach(r => { (days[r.date] = days[r.date] || []).push(r); });

    let html = '';
    Object.keys(days).sort().reverse().forEach(date => {
      const rows = days[date];
      let daySum = 0;
      rows.forEach(r => { if (r.type === 'expense') daySum += r.amount; else if (r.type === 'income') daySum -= r.amount; });

      html += '<div class="day"><div class="dayhead"><span>' + dayLabel(date) + '</span>' +
        '<span class="dsum' + (daySum === 0 ? '' : (daySum > 0 ? ' exp' : ' inc')) + '">' +
        (daySum === 0 ? '' : (daySum > 0 ? '− ' : '+ ') + Store.fmtGroup(Math.abs(daySum))) + '</span></div>';

      rows.forEach(r => {
        const cls = r.type === 'income' ? ' income' : (r.type === 'void' ? ' void' : '');
        const sign = r.type === 'income' ? '+' : (r.type === 'void' ? '' : '');
        html += '<div class="row" data-id="' + esc(r.id) + '">' +
          '<span class="time">' + esc(timeCell(r)) + '</span>' +
          '<span class="what"><span class="cat">' + esc(r.cat) + '</span>' +
          (r.note ? '<span class="note">' + esc(r.note) + '</span>' : '') + '</span>' +
          '<span class="amt' + cls + '">' + sign + Store.fmtGroup(r.amount) + '</span></div>';
      });
      html += '</div>';
    });
    box.innerHTML = html;

    box.querySelectorAll('.row').forEach(row => {
      row.addEventListener('click', () => openEntry(row.dataset.id));
    });
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  /* ---------------------------------------------------------
     统计页：周 / 月 / 年 三种尺度 + 占比图（环形图或构成条，设置里选）+ 趋势
     --------------------------------------------------------- */
  let statsDrill = null;                  // 下钻：{ dim:'cat'|'pay', name }（v1.7.0 起分类/支付方式都能下钻）
  let stPeriod = 'month';                 // week | month | year
  let stDate = Store.todayStr();          // 当前查看周期里的任意一天（导航的锚点）
  let stKind = 'expense';                 // 占比图看支出还是收入
  let stBd = 'cat';                       // 占比图按什么构成：cat 分类 / pay 支付方式（v1.7.0）
  // ⚠️ 构成维度的口味偏好（bdDim）**不能在这里读** —— 这里是 IIFE 顶层，
  // Store.init() 还没跑完、db 还是 null，调 Store.pref 会当场抛 TypeError
  //（v1.7.0 截图验证时踩过：整个 app.js 后半段全挂，页面只剩静态骨架）。
  // 初始化在启动块里 Store.init() 之后做。

  function shiftDays(d, n) {
    const t = new Date(d + 'T00:00:00');
    t.setDate(t.getDate() + n);
    return Store.todayStr(t);
  }
  function monthEnd(m) {
    const p = m.split('-').map(Number);
    return m + '-' + String(new Date(p[0], p[1], 0).getDate()).padStart(2, '0');
  }
  // 本周的第一天。偏好里可选周一或周日
  function weekStartOf(d) {
    const ws = Store.pref('weekStart');
    const dow = new Date(d + 'T00:00:00').getDay();     // 0 = 周日
    return shiftDays(d, -((ws === 1) ? ((dow + 6) % 7) : dow));
  }
  // 构造日期并把非法日子收敛掉（比如从 3月31日 往前一个月会得到 2月31日）
  function makeDate(y, m, d) {
    const last = new Date(y, m, 0).getDate();
    return y + '-' + String(m).padStart(2, '0') + '-' + String(Math.min(d, last)).padStart(2, '0');
  }

  function stRange() {
    if (stPeriod === 'week') {
      const s = weekStartOf(stDate);
      return { from: s, to: shiftDays(s, 6) };
    }
    if (stPeriod === 'year') {
      const y = stDate.slice(0, 4);
      return { from: y + '-01-01', to: y + '-12-31' };
    }
    const m = stDate.slice(0, 7);
    return { from: m + '-01', to: monthEnd(m) };
  }
  function stLabel() {
    if (stPeriod === 'week') {
      const s = weekStartOf(stDate), e = shiftDays(s, 6);
      // 跨年那一周要带年份：只写「12/29 – 1/4」看不出是哪一年。
      const yS = s.slice(0, 4), yE = e.slice(0, 4);
      const f = d => {
        const md = parseInt(d.slice(5, 7), 10) + '/' + parseInt(d.slice(8), 10);
        return (yS !== yE) ? d.slice(0, 4) + '/' + md : md;
      };
      return f(s) + ' – ' + f(e);
    }
    if (stPeriod === 'year') return stDate.slice(0, 4) + ' 年';
    return monthLabel(stDate.slice(0, 7));
  }
  function stShift(dir) {
    if (stPeriod === 'week') { stDate = shiftDays(stDate, 7 * dir); return; }
    const y = parseInt(stDate.slice(0, 4), 10);
    const m = parseInt(stDate.slice(5, 7), 10);
    const d = parseInt(stDate.slice(8), 10);
    if (stPeriod === 'year') { stDate = makeDate(y + dir, m, d); return; }
    const nm = m + dir;
    stDate = makeDate(y + Math.floor((nm - 1) / 12), ((nm - 1 + 12) % 12) + 1, d);
  }
  function syncSeg() {
    document.querySelectorAll('#st-seg button').forEach(x =>
      x.classList.toggle('on', x.dataset.p === stPeriod));
  }

  document.querySelectorAll('#st-seg button').forEach(b => b.addEventListener('click', () => {
    stPeriod = b.dataset.p;
    syncSeg();
    renderStats();
    buzz();
  }));
  $('st-prev').addEventListener('click', () => { stShift(-1); renderStats(); buzz(); });
  $('st-next').addEventListener('click', () => { stShift(1); renderStats(); buzz(); });
  $('st-label').addEventListener('click', () => { stDate = Store.todayStr(); renderStats(); });

  // 从记账页点构成条进来时，要把记账页正在看的那个月一起带过来 ——
  // 否则统计页会用它自己的周期锚点（默认是今天），你在 6 月点的那一段，
  // 打开统计页看到的却是 9 月的明细，数字对不上，页头那句"返回 X 月统计"也在误导。
  function goStats(cat, fromMonth) {
    statsDrill = cat ? { dim: 'cat', name: cat } : null;
    // 记账页的构成条只画**支出** —— 下钻口径必须跟着它走。
    // 不重置的话：上次在统计页切过「收入」，回来点支出构成段会显示
    // 「没有「餐饮」的收入」（0 笔），与点的段自相矛盾（第三轮审查 🟠 B7）。
    stKind = 'expense';
    if (fromMonth) {
      stPeriod = 'month';
      stDate = fromMonth + '-01';
      stBd = 'cat';               // 从记账页「分类构成」条进来 —— 下钻维度一定是分类
      syncSeg();
    }
    switchTab('stats');
    renderStats();
  }

  function renderStats() {
    const box = $('stats-scroll');
    if (!box) return;
    // 统计页没显示就直接返回，别白算。
    // 年视图下这一次要跑 12 遍全表扫描，而 renderLedger 每记一笔都会顺带调一次
    // —— 哪怕你正在记账页。切到统计页时 switchTab 会重新算，所以不会漏掉。
    // 判断「在不在统计页」看的是 .on（当前页标记），不是 .hidden ——
    // 三个主标签页现在靠位移并排，谁都没有 .hidden，用 hidden 判断会永远为假。
    if (!$('view-stats').classList.contains('on')) return;
    $('st-label').textContent = stLabel();

    const r = stRange();
    const list = Store.search({ from: r.from, to: r.to });
    // （这里原来还有一句 `const total = Store.sum(list).expense;` —— 算完没人用，
    //   是「支出/收入/结余」那一行从统计页删掉之后的残留。年视图下每渲染一次
    //   就白跑一遍全表 sum，删掉。）

    // 分类 / 支付方式下钻（跟着当前周期走，v1.7.0 起两个维度都能下钻）
    if (statsDrill) {
      // 下钻要跟着当前是「支出」还是「收入」走 —— 写死 expense 的话，
      // 在收入占比里点「工资」会显示「这个月没有「工资」的支出」（自相矛盾）。
      // 两边同名的分类（默认数据里「其他」就是）更隐蔽：会显示支出那几笔，
      // 看着"有数据"，其实口径错了。
      const kk = stKind === 'income' ? 'income' : 'expense';
      const nm = statsDrill.name;
      const rows = list.filter(x =>
        (statsDrill.dim === 'pay'
          // byPayMethod 把缺 account 的记录归到「（没填）」；下钻必须用同一个口径，
          // 否则点这一项永远是 0 笔（第三轮审查 🟡 C40）。
          ? (x.account || '（没填）') === nm
          : x.cat === nm) && x.type === kk);
      const sub = rows.reduce((a, x) => a + x.amount, 0);
      let html = '<button class="back-row" id="stats-back">‹ 返回 ' + stLabel() + ' 统计</button>' +
        '<div class="sec-head"><span class="t">' + esc(nm) + '</span>' +
        '<span class="hint">' + rows.length + ' 笔 · ' + Store.fmtGroup(sub) + '</span></div>';
      if (!rows.length) html += '<div class="empty">这' +
        (stPeriod === 'week' ? '周' : stPeriod === 'year' ? '年' : '个月') +
        '没有「' + esc(nm) + '」的' + (stKind === 'income' ? '收入' : '支出') + '</div>';
      rows.forEach(x => {
        // 跨年的记录补上年份：只看「01/05」分不清 2025 还是 2026。
        const thisYear = Store.todayStr().slice(0, 4);
        const dstr = x.date.slice(0, 4) !== thisYear
          ? x.date.slice(2).replace(/-/g, '/')
          : x.date.slice(5).replace('-', '/');
        // 注意：这里的 class 必须是 "cat-row plain"。
        // 直接复用分类行的 4 列网格，会把备注挤进 10px 宽的第一列 —— 一个字都显示不全。
        html += '<button class="cat-row plain" data-id="' + esc(x.id) + '">' +
          '<span class="nm">' + esc(x.note || x.cat) + '</span>' +
          '<span class="pct">' + dstr + '</span>' +
          '<span class="amt">' + Store.fmtGroup(x.amount) + '</span></button>';
      });
      box.innerHTML = html;
      $('stats-back').addEventListener('click', () => { statsDrill = null; renderStats(); });
      box.querySelectorAll('.cat-row[data-id]').forEach(el =>
        el.addEventListener('click', () => openEntry(el.dataset.id)));
      return;
    }

    // 顺序：日历/网格 → 分类占比 → 趋势。
    // 这里**不放**「支出/收入/结余」那一行 —— 记账页顶上已经有了，
    // 两处都放是同一件事说两遍。真正需要收支的地方是每个格子里的那个数字。
    box.innerHTML = periodGridHTML(list) + breakdownHTML(list) + trendHTML();

    box.querySelectorAll('[data-date]').forEach(el =>
      el.addEventListener('click', () => openEntry(null, el.dataset.date)));
    // 年视图点某个月 → 跳到那个月的月视图
    box.querySelectorAll('[data-month]').forEach(el =>
      el.addEventListener('click', () => {
        stPeriod = 'month'; stDate = el.dataset.month + '-01'; syncSeg(); renderStats();
      }));
    box.querySelectorAll('.cat-row[data-cat]').forEach(el =>
      el.addEventListener('click', () => {
        statsDrill = { dim: stBd, name: el.dataset.cat };
        renderStats();
      }));
    // 占比图在支出/收入之间切
    box.querySelectorAll('#st-kind button').forEach(b =>
      b.addEventListener('click', () => { stKind = b.dataset.k; renderStats(); buzz(); }));
    // 占比图在「按分类 / 按支付方式」之间切（v1.7.0），切完记住这个口味
    box.querySelectorAll('#st-bd button').forEach(b =>
      b.addEventListener('click', () => {
        stBd = b.dataset.bd;
        Store.setPref('bdDim', stBd);
        renderStats(); buzz();
      }));
  }

  /* ---------------------------------------------------------
     左右滑动切换页面（v1.6.3 起是**跟手**的）
     ---------------------------------------------------------
     方向感跟相册翻页一致：**内容跟着手指走**。
       左滑 → 看右边那一页（记账 → 统计 → 搜索）
       右滑 → 看左边那一页（搜索 → 统计 → 记账）

     「跟手」是什么意思：手指按住往左拖，页面就 1:1 跟着往左走，
     松手时够远就吸附到下一页、不够远就弹回原处 ——
     而不是「滑完了才播一段动画」。

     v1.6.4 起统计页也走这一条规则 —— 它原来还有一层「先在自己内部切
     周 / 月 / 年、滑到头才跨标签」，那一层被删掉了（理由见统计页那段注释）。
     现在三个页面的滑动语义完全一致：左滑看右边、右滑看左边。

     三条不抢手势的规矩（沿用原来的）：
       1. 屏幕左右各 28px 留给系统的返回手势，别抢
       2. 多点触控（缩放）不参与
       3. 横向位移要明显大于纵向 —— 否则算「滚动」不算「滑」
     新增第四条（跟手必须有）：**先定主轴，再决定跟不跟**。
       方向没定之前一动不动；一旦判定是纵向滚动，整个手势就让给列表。
       少了这条，上下翻账本时页面会跟着横向抖。
     --------------------------------------------------------- */
  const SWIPE = {
    EDGE: 28,       // 左右各留 28px 给系统返回手势
    TRIGGER: 0.32,  // 拖过屏宽的 32% → 松手就翻页（v1.6.3 是固定 60px=15%，太灵敏；
                    //   v1.6.4 改成一半=50%，真机反馈「滑的有点费力」；32% 是折中）
    FLICK: 0.5,     // 快速轻扫：px/ms（0.5 = 500px/s）。没拖到一半也能翻
    FLICK_MIN: 40,  // 轻扫至少要走这么远才算数（防手抖）
    RATIO: 1.6,     // 横向位移要明显大于纵向，否则算滚动
    LOCK: 8,        // 先动这么多像素，才开始判方向
    AXIS: 1.2,      // 横向 / 纵向 超过这个比例才算横向
    DAMP: 0.3       // 已经到头了还硬拖：拖得动，但明显变沉
  };

  // 改「现在停在第几页」。跟手时传的是小数（比如 0.37），位移由 CSS 算。
  function setCur(v) {
    document.documentElement.style.setProperty('--cur', String(v));
  }

  // 手指正在拖。拖动期间必须关掉过渡（见 app.css 的 :root.dragging），
  // 否则 1:1 跟手会变成「拖一下、等它慢慢滑」。
  let dragBase = 0, dragOn = false;
  function dragStop() {
    dragOn = false;
    document.documentElement.classList.remove('dragging');
  }

  /* whatHappens(dir) 回答「往这个方向滑会发生什么」，两种答案：
       'flip'  换标签页  → 页面跟手，松手吸附到相邻页
       'none'  已经到头了 → 拖得动但带阻尼，松手必定弹回
     不传这个回调就默认 'flip'。
     （v1.6.4 之前还有第三种 'inner' = 页面内部换内容，是给统计页切周/月/年用的；
       那个手势删掉之后这个分支就没有生产者了，一并清掉 —— 留着就是死代码。） */
  function bindSwipe(el, onSwipe, whatHappens) {
    if (!el) return;
    let x0 = 0, y0 = 0, t0 = 0, tracking = false, axis = null, act = null;

    el.addEventListener('touchstart', function (e) {
      // 多指触摸（第二根手指落屏、或另一只手去点底部标签）：
      // ⚠️ 这里必须把**全局的** dragOn 也复位、并把 dragging 类摘掉。
      // dragOn/dragBase 是三个页面共用的模块级变量，而下面 touchend/touchcancel
      // 的开头都是 `if (!tracking) return` —— tracking 一置 false，那些复位就永远
      // 走不到。结果是：页面**卡在半路**（--cur 停在半路、dragging 类留在 <html> 上、
      // 之后切页没过渡），而且残留的 dragOn 会让「主轴判断」失效 ——
      // 判成纵向之后 `if (!dragOn) return` 会放行，纵向滚列表也带着页面横移。
      if (e.touches.length !== 1) {
        tracking = false;
        if (dragOn) { dragStop(); setCur(dragBase); }
        return;
      }
      const t = e.touches[0];
      if (t.clientX < SWIPE.EDGE || t.clientX > window.innerWidth - SWIPE.EDGE) {
        tracking = false; return;
      }
      x0 = t.clientX; y0 = t.clientY; t0 = Date.now();
      tracking = true; axis = null; act = null;
    }, { passive: true });

    el.addEventListener('touchmove', function (e) {
      if (!tracking) return;
      const t = e.touches[0];
      const dx = t.clientX - x0, dy = t.clientY - y0;

      if (axis === null) {
        if (Math.abs(dx) < SWIPE.LOCK && Math.abs(dy) < SWIPE.LOCK) return;
        axis = Math.abs(dx) >= Math.abs(dy) * SWIPE.AXIS ? 'x' : 'y';
        if (axis === 'x') {
          act = whatHappens ? whatHappens(dx < 0 ? 1 : -1) : 'flip';
          dragOn = true;
          dragBase = TAB_ORDER.indexOf(curTab);
          document.documentElement.classList.add('dragging');
        }
      }
      // ⚠️ 判据用 axis 而不是 dragOn：dragOn 是三个页面共用的模块级变量，
      // 万一被别处残留成 true，纵向手势就会被放行、页面跟着横移。
      if (axis !== 'x') return;
      // 到头了还硬拖：位移打三折，手感上就是「拖不动了」。松手必定弹回（见 finish）。
      const eff = (act === 'none') ? dx * SWIPE.DAMP : dx;
      setCur(dragBase - eff / window.innerWidth);
    }, { passive: true });

    function finish(dx, dy, dt) {
      // 松手判定（v1.6.4 重做的）。
      // 原来写的是「位移 >= 60px 就算翻页」—— 60px 在 390 宽的屏上只占 **15%**，
      // 手指随便一蹭就翻页了。真机反馈原话：「往左拖一半再松手，没有弹回原处，
      // 而是翻到了统计页」。所以改成按屏幕比例算，并且把「快速轻扫」单独认出来：
      //   ① 拖过屏幕一半        → 翻页（慢慢拖也能翻，意图明确）
      //   ② 没到一半但甩得快    → 也翻页（少了这条，轻扫会翻不动、手感发钝）
      //   ③ 其余                → 弹回
      const horizontal = Math.abs(dx) >= Math.abs(dy) * SWIPE.RATIO;
      const fast = Math.abs(dx) >= SWIPE.FLICK_MIN && dt > 0 &&
                   Math.abs(dx) / dt >= SWIPE.FLICK;
      const far = horizontal && (Math.abs(dx) >= window.innerWidth * SWIPE.TRIGGER || fast);

      if (dragOn) {
        // 先摘掉 dragging（恢复过渡）再改 --cur，这样吸附/回弹才是一段动画；
        // 顺序反了的话过渡还是 none，页面会「啪」地跳过去。
        dragStop();
        const dir = dx < 0 ? 1 : -1;
        setCur(far && act !== 'none' ? dragBase + dir : dragBase);
        if (far) onSwipe(dir);
        return;
      }
      // 没进跟手 —— 现在只剩一种情况：方向被判成了纵向滚动。
      // 这里再兜一次底（far 里本来就要求「横向明显大于纵向」），别让竖着划一下把页面翻了。
      if (!far) return;
      onSwipe(dx < 0 ? 1 : -1);     // +1 = 左滑（去右边那页），-1 = 右滑（去左边那页）
    }

    el.addEventListener('touchend', function (e) {
      if (!tracking) return;
      tracking = false;
      const t = e.changedTouches[0];
      finish(t.clientX - x0, t.clientY - y0, Date.now() - t0);
    }, { passive: true });

    // 被系统打断（来电、从边缘触发了返回手势…）：
    // 必须把页面放回原位，不能让它卡在半路上。
    el.addEventListener('touchcancel', function () {
      if (!tracking) return;
      tracking = false;
      if (dragOn) { dragStop(); setCur(dragBase); }
    }, { passive: true });
  }

  // 三个主标签的顺序。滑动就是在这个数组上前后移动。
  // ⚠️ 必须和 index.html 里 .tabs 那三个按钮的 data-tab 顺序一致 ——
  //    tests/navTest.js 里有一条测试盯着这件事。
  const TAB_ORDER = ['ledger', 'stats', 'search'];
  // （这里原来还有一张 PERIOD_ORDER = ['week','month','year'] 顺序表，v1.6.4 删了：
  //   它唯一的用途是「滑动切周期」时算下一档，而那个手势已经删掉。
  //   现在周期的合法值由 index.html 的 #st-seg 按钮定义，syncSeg 直接遍历它们，
  //   navTest 里有一条测试盯着 stPeriod 的初始值必须是那三个之一。）

  // 在列表里走一步。走出界返回 null，由调用方决定「出界了去哪」。
  // 抽成一个小函数是为了让「出界」只有一个判断点，不容易写错。
  function stepIndex(list, cur, dir) {
    const i = list.indexOf(cur) + dir;
    return (i < 0 || i >= list.length) ? null : i;
  }

  // 统计页的滑动 = 和另外两页一样，纯粹翻标签。
  // v1.6.4 删掉了这里原有的「先在自己内部切 周/月/年、滑到头才跨标签」那一层。
  // 删的理由：跟手之后，同一个左滑在统计页和在记账页结果不同 ——
  //   当前是「周」→ 切到「月」（内容变、页面不动）；当前是「年」→ 翻到搜索页（整页滑走）。
  //   同一个动作两种反应，用户没法形成稳定预期（这是真实的理解成本，不是洁癖）。
  // 切 周/月/年 交给顶栏下面那三个按钮：它们一直在屏幕上，
  // 而且「点」比「滑」更确定 —— 滑的时候你并不知道下一档是什么。
  // （绑定挪到了 swipeTab 那边，三个页面统一绑，见下面。）

  // 一格一个数字：当天的结余（收入 − 支出）。
  // 正数墨绿（这天净进账）、负数印泥红（这天净支出）。
  // 一个数字就把两头都说清了：只有支出时它就是那笔支出，只有收入时它就是那笔收入。
  function amountLines(e, i) {
    if (!e && !i) return '';
    const net = i - e;
    if (net === 0) return '<span class="v net zero">0</span>';
    return '<span class="v net ' + (net > 0 ? 'pos' : 'neg') + '">' +
      (net > 0 ? '+' : '−') + Store.compactYuan(Math.abs(net)) + '</span>';
  }
  function dayAmounts(dd, ds) {
    return amountLines(dd.expense[ds] || 0, dd.income[ds] || 0);
  }

  // ① 周期网格：周 = 7 个格子 / 月 = 日历 / 年 = 12 个月
  //    有记录的格子是深色带金额，空白的只有浅灰日期 —— 扫一眼就知道哪天漏了
  //    每一格都能点：周和月点进「补记到那天」，年点进那个月的月视图
  function periodGridHTML(list) {
    const dd = Store.byDay(list);
    const today = Store.todayStr();
    const ws = Store.pref('weekStart');

    if (stPeriod === 'week') {
      const s = weekStartOf(stDate);
      const names = ws === 1 ? ['一', '二', '三', '四', '五', '六', '日']
                             : ['日', '一', '二', '三', '四', '五', '六'];
      let cells = '', filled = 0;
      for (let i = 0; i < 7; i++) {
        const ds = shiftDays(s, i);
        const has = (dd.count[ds] || 0) > 0;
        if (has) filled++;
        cells += '<button class="grid-cell' + (has ? ' has' : '') + (ds === today ? ' today' : '') +
          '" style="--i:' + i + '" data-date="' + ds + '"><span class="k">' + names[i] + ' ' +
          parseInt(ds.slice(8), 10) + '</span>' + dayAmounts(dd, ds) + '</button>';
      }
      // 标题要跟着周期走 —— 翻到 5 月的那一周时不能还写「本 周」
      // （年视图写「全 年 各 月」、月视图写「日 历」，都是跟的）
      const isThisWeek = weekStartOf(stDate) === weekStartOf(today);
      return '<div class="sec-head"><span class="t">' + (isThisWeek ? '本 周' : '那 一 周') + '</span>' +
        '<span class="hint">' + filled + ' 天有记录 · ' + (7 - filled) + ' 天空白，点一天补记</span></div>' +
        '<div class="wk-grid">' + cells + '</div>';
    }

    if (stPeriod === 'year') {
      const y = stDate.slice(0, 4);
      let cells = '', filled = 0;
      for (let m = 1; m <= 12; m++) {
        const mm = y + '-' + String(m).padStart(2, '0');
        const l = Store.search({ from: mm + '-01', to: monthEnd(mm) });
        const ss = Store.sum(l);
        if (l.length) filled++;
        cells += '<button class="grid-cell' + (l.length ? ' has' : '') +
          (today.slice(0, 7) === mm ? ' today' : '') + '" style="--i:' + (m - 1) +
          '" data-month="' + mm + '">' +
          '<span class="k">' + m + ' 月</span>' + amountLines(ss.expense, ss.income) + '</button>';
      }
      return '<div class="sec-head"><span class="t">全 年 各 月</span>' +
        '<span class="hint">' + filled + ' 个月有记录 · 点一个月看它的明细</span></div>' +
        '<div class="yr-grid">' + cells + '</div>';
    }

    // 月：日历
    const m = stDate.slice(0, 7);
    const p = m.split('-').map(Number);
    const daysInMonth = new Date(p[0], p[1], 0).getDate();
    const lead = (new Date(p[0], p[1] - 1, 1).getDay() + 7 - ws) % 7;
    let cells = '';
    for (let i = 0; i < lead; i++) cells += '<span class="cal-cell blank"></span>';
    let filled = 0;
    for (let d = 1; d <= daysInMonth; d++) {
      const ds = m + '-' + String(d).padStart(2, '0');
      const has = (dd.count[ds] || 0) > 0;
      if (has) filled++;
      cells += '<button class="cal-cell' + (has ? ' has' : '') + (ds === today ? ' today' : '') +
        '" style="--i:' + (lead + d - 1) + '" data-date="' + ds + '"><span class="d">' + d +
        '</span>' + dayAmounts(dd, ds) + '</button>';
    }
    const wk = (ws === 1 ? ['一', '二', '三', '四', '五', '六', '日']
                         : ['日', '一', '二', '三', '四', '五', '六'])
      .map(w => '<span class="cal-w">' + w + '</span>').join('');

    return '<div class="sec-head"><span class="t">日 历</span>' +
      '<span class="hint">' + filled + ' 天有记录 · ' + (daysInMonth - filled) + ' 天空白，点一天补记</span></div>' +
      '<div class="cal">' + wk + cells + '</div>';
  }

  // ② 构成占比：环形图 + 列表（v1.7.0 起支持「按分类 / 按支付方式」两种构成）。
  //    这里固定用环形图 —— 构成条在记账页已经有了，两处都放是同一件事说两遍。
  //    （记账页那条要的是「极简 + 可点击」，只有 14 像素高；环形图要的是「报表感」，
  //      各在各的地方，就不重复了。）
  function breakdownHTML(list) {
    // 口径红线：byCategory / byPayMethod 都只算 stKind 那一类，「不计收支」被排除
    const raw = stBd === 'pay'
      ? Store.byPayMethod(list, stKind)
      : Store.byCategory(list, stKind);
    // 统一成 { name, amount }：cat / account 在这里都是「这一段叫什么」，下游不再区分
    const cats = raw.map(c => ({ name: stBd === 'pay' ? c.account : c.cat, amount: c.amount }));
    const total = cats.reduce((a, c) => a + c.amount, 0);
    const unit = stPeriod === 'week' ? '周' : stPeriod === 'year' ? '年' : '个月';
    const kindName = stKind === 'income' ? '收入' : '支出';
    const subWord = stBd === 'pay' ? '种支付方式' : '个分类';

    // 行头放两个小切换：左边选构成维度、右边选收支口径。
    // 原来右边只有「支出/收入」，左边是「分 类 占 比」四个字的标题 ——
    // 标题位置让给维度切换（按钮文案「按分类/按支付方式」本身就点题），
    // 这样一行放两个 seg-mini 在长辈模式 1.45 倍下也不挤（.sec-head-kind 允许换行兜底）。
    const head = '<div class="sec-head sec-head-kind">' +
      '<span class="seg-mini" id="st-bd">' +
      '<button data-bd="cat"' + (stBd === 'cat' ? ' class="on"' : '') + '>按分类</button>' +
      '<button data-bd="pay"' + (stBd === 'pay' ? ' class="on"' : '') + '>按支付方式</button>' +
      '</span>' +
      '<span class="seg-mini" id="st-kind">' +
      '<button data-k="expense"' + (stKind === 'expense' ? ' class="on"' : '') + '>支出</button>' +
      '<button data-k="income"' + (stKind === 'income' ? ' class="on"' : '') + '>收入</button>' +
      '</span></div>';

    if (!cats.length) {
      return head + '<div class="empty" style="padding:22px 0">这' + unit +
        '没有' + kindName + '记录</div>';
    }

    const colors = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5)', 'var(--s6)'];
    const max = cats[0].amount || 1;

    const rows = cats.map((c, i) => {
      const pct = total ? Math.round(c.amount / total * 1000) / 10 : 0;
      const w = Math.max(2, Math.round(c.amount / max * 100));
      // 第 6 项起统一用中性灰 —— 不能再用 --s6，那是环形图里「其他」段的颜色，
      // 两者撞色会让看图的人把「医疗」那一行的小圆点当成「其他」段
      // （实测截图里就是这样：7 个分类时医疗/人情两行都长得像「其他」）。
      const col = i < 5 ? colors[i] : 'var(--ink3)';
      return '<button class="cat-row" data-cat="' + esc(c.name) + '" style="--w:' + w + '%">' +
        '<i class="dot" style="background:' + col + '"></i>' +
        '<span class="nm">' + esc(c.name) + '</span>' +
        '<span class="amt">' + Store.fmtGroup(c.amount) + '</span>' +
        '<span class="pct">' + pct + '%</span></button>';
    }).join('');

    return head + donutHTML(cats, total, kindName, subWord) + '<div class="cat-list">' + rows + '</div>';
  }

  // 环形图：每一段用 stroke-dasharray 画在同一个圆上。
  // 为什么不用 path 画扇形：当某个分类占 100% 时，扇形的起点和终点重合，弧画不出来
  // （会变成一片空白）。dasharray 画法没有这个问题。
  function donutHTML(cats, total, kindName, subWord) {
    const R = 64, SW = 26, C = 80;
    const CIRC = 2 * Math.PI * R;
    const colors = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5)', 'var(--s6)'];

    // 前 5 名各自一段，第 6 段是「其他」—— 这样环形图加起来正好是 100%
    const segs = cats.slice(0, 5);
    const rest = cats.slice(5).reduce((a, c) => a + c.amount, 0);
    if (rest > 0) segs.push({ name: '其他', amount: rest });
    const tt = segs.reduce((a, c) => a + c.amount, 0) || 1;

    let off = 0;
    const rings = segs.map((c, i) => {
      const len = (c.amount / tt) * CIRC;
      const s = '<circle cx="' + C + '" cy="' + C + '" r="' + R + '" fill="none" stroke="' + colors[i] +
        '" stroke-width="' + SW + '" stroke-dasharray="' + len.toFixed(2) + ' ' +
        (CIRC - len).toFixed(2) + '" stroke-dashoffset="' + (-off).toFixed(2) +
        '" transform="rotate(-90 ' + C + ' ' + C + ')"/>';
      off += len;
      return s;
    }).join('');

    return '<div class="donut-wrap"><svg class="donut" viewBox="0 0 160 160">' + rings + '</svg>' +
      '<div class="donut-center"><span class="dc-label">' +
      (kindName === '收入' ? '收 入' : '支 出') + '</span>' +
      '<span class="dc-val">' + Store.fmtGroup(total) + '</span>' +
      '<span class="dc-sub">' + cats.length + ' ' + (subWord || '个分类') + '</span></div></div>';
  }

  // ③ 趋势：跟着周期走 —— 周看近 6 周、月看近 6 个月、年看全年 12 个月
  function trendHTML() {
    const data = trendData();
    let max = 0;
    data.forEach(d => { if (d.expense > max) max = d.expense; });

    const cols = data.map((d, i) => {
      // 柱高用固定像素算，不用百分比 —— 百分比在嵌套 flex 里容易出意外
      const h = max ? Math.max(2, Math.round(d.expense / max * 72)) : 2;
      // --i 是给入场动画排队的：柱子从左到右一根根立起来（见 app.css 的 barGrow）
      return '<div class="tcol" title="' + d.key + '：' + Store.fmtGroup(d.expense) + '">' +
        '<span class="tv">' + (d.expense ? Store.compactYuan(d.expense) : '') + '</span>' +
        '<span class="tbar-wrap"><i class="tb' + (d.cur ? ' cur' : '') +
        '" style="height:' + h + 'px;--i:' + i + '"></i></span>' +
        '<span class="tm">' + d.label + '</span></div>';
    }).join('');

    const sumAll = data.reduce((a, d) => a + d.expense, 0);
    const title = stPeriod === 'week' ? '近 6 周 支 出'
      : stPeriod === 'year' ? '全 年 各 月 支 出' : '近 6 个 月 支 出';
    return '<div class="sec-head" style="margin-top:22px">' +
      '<span class="t">' + title + '</span>' +
      '<span class="hint">合计 ' + Store.fmtGroup(sumAll) + '</span></div>' +
      '<div class="trend' + (data.length > 8 ? ' dense' : '') + '">' + cols + '</div>';
  }

  function trendData() {
    const out = [];
    const today = Store.todayStr();
    if (stPeriod === 'week') {
      const s0 = weekStartOf(stDate), curW = weekStartOf(today);
      for (let i = 5; i >= 0; i--) {
        const s = shiftDays(s0, -7 * i), e = shiftDays(s, 6);
        out.push({
          key: s,
          label: parseInt(s.slice(5, 7), 10) + '/' + parseInt(s.slice(8), 10),
          expense: Store.sum(Store.search({ from: s, to: e })).expense,
          cur: s === curW
        });
      }
    } else if (stPeriod === 'year') {
      const y = stDate.slice(0, 4);
      for (let m = 1; m <= 12; m++) {
        const mm = y + '-' + String(m).padStart(2, '0');
        out.push({
          key: mm, label: m + '月',
          expense: Store.sum(Store.search({ from: mm + '-01', to: monthEnd(mm) })).expense,
          cur: today.slice(0, 7) === mm
        });
      }
    } else {
      const m0 = stDate.slice(0, 7);
      for (let i = 5; i >= 0; i--) {
        const mm = Store.shiftMonth(m0, -i);
        out.push({
          key: mm, label: parseInt(mm.slice(5), 10) + '月',
          expense: Store.sum(Store.search({ from: mm + '-01', to: monthEnd(mm) })).expense,
          cur: today.slice(0, 7) === mm
        });
      }
    }
    return out;
  }

  /* ---------------------------------------------------------
     切换标签 / 月份
     --------------------------------------------------------- */
  let curTab = 'ledger';        // 当前在哪个主标签页，滑动时要用
  function switchTab(tab) {
    curTab = tab;
    // 三个主标签页靠一个 CSS 变量定位：--cur = 现在停在第几页。
    // 位移是在 CSS 里算的（见 app.css 的 .view.tabpage），这里只改这一个数 ——
    // 好处是「页面滑动」和「底部那条指示条滑动」读的是同一个变量，不会各走各的。
    // ⚠️ 这里**不能**再用 .hidden（display:none）来切换页面：
    //    display 不能过渡，页面会「啪」地出现，而那正是这次要修掉的感觉。
    const i = TAB_ORDER.indexOf(tab);
    if (i >= 0) setCur(i);
    TAB_ORDER.forEach(n => $('view-' + n).classList.toggle('on', n === tab));
    if (tab === 'ledger') renderLedger();
    else if (tab === 'stats') renderStats();
    else renderSearch();
  }

  // 开机时的定位不要动画：那时界面已经画出来了，再改 --cur 会看到它从旁边
  // 滑进来一下。临时把过渡关掉，定位完（下一帧绘制前）立刻放开。
  function switchTabNoAnim(tab) {
    // ⚠️ 不能用 requestAnimationFrame 摘类：rAF 回调跑在**样式重算之前**，
    // 浏览器算样式时类已经被摘掉了 → 过渡恢复，--cur 的变化照样 animate。
    // （实测：#stats 开机照样记录到 7 条 transitionrun；换成强制重排后全消失。）
    // 正确做法是**先强制一次重排**，让新位置带着 no-anim 落地，再摘类。
    document.documentElement.classList.add('no-anim');
    switchTab(tab);
    void document.documentElement.offsetWidth;      // 强制重排：no-anim 下的位置先落地
    document.documentElement.classList.remove('no-anim');
  }
  document.querySelectorAll('.tabs button').forEach(b =>
    b.addEventListener('click', () => switchTab(b.dataset.tab)));

  // 三个主标签页上的左右滑动 = 翻标签。
  // v1.6.4 起统计页也走这一条 —— 它原来还有一层「先在自己内部切 周/月/年、
  // 滑到头才跨标签」，那层被删掉了（理由见上面统计页那段注释）。
  function swipeTab(dir) {
    const i = stepIndex(TAB_ORDER, curTab, dir);
    if (i === null) return;          // 已经在头/尾了，不动
    switchTab(TAB_ORDER[i]);
  }
  // 两头那两页只有「往中间那页」的方向能翻，另一头已经到头了 ——
  // 到头的那一侧仍然拖得动，但带阻尼、松手弹回（就是 whatHappens 里的 'none'）。
  function tabSwipeWhat(dir) {
    return stepIndex(TAB_ORDER, curTab, dir) !== null ? 'flip' : 'none';
  }
  bindSwipe($('view-ledger'), swipeTab, tabSwipeWhat);
  bindSwipe($('view-stats'), swipeTab, tabSwipeWhat);
  bindSwipe($('view-search'), swipeTab, tabSwipeWhat);

  // 「＋ 记一笔」
  $('btn-add').addEventListener('click', () => openEntry(null));

  // 月份选择
  $('btn-month').addEventListener('click', openMonthPick);
  function openMonthPick() { $('mopick').classList.add('show'); }
  $('mo-prev').addEventListener('click', () => { month = shiftMonth(month, -1); renderLedger(); });
  $('mo-next').addEventListener('click', () => { month = shiftMonth(month, 1); renderLedger(); });
  $('mo-today').addEventListener('click', () => { month = Store.todayStr().slice(0, 7); renderLedger(); });
  $('mo-done').addEventListener('click', () => $('mopick').classList.remove('show'));

  /* ---------------------------------------------------------
     录入页
     --------------------------------------------------------- */
  // 录入页字段区：内容超出时给它加上 more-below，
  // 配合 app.css 里那条底部渐隐，暗示「下面还有内容，可以往下滑」。
  // 为什么需要：iOS 的滚动条是自动隐藏的，内容被切在键盘边缘时
  // 看起来像界面坏了，而不是「还能滚」。
  function updateSheetHint() {
    const box = document.querySelector('.sheet-body');
    if (!box) return;
    // 留 8px 容差：亚像素舍入会让 scrollHeight 比 clientHeight 大一点点，
    // 不留容差的话内容正好放得下时也会显示渐隐，反而遮住最后一行。
    const more = box.scrollHeight - box.scrollTop - box.clientHeight > 8;
    box.classList.toggle('more-below', more);
  }
  (function () {
    const box = document.querySelector('.sheet-body');
    if (box) box.addEventListener('scroll', updateSheetHint, { passive: true });
    window.addEventListener('resize', updateSheetHint);   // 横竖屏切换时也要重算
  })();

  function openEntry(id, presetDate) {
    clearTimeout(entryHideTimer);        // 关闭动画还没走完就重开，别被旧 timer 藏掉
    editingId = id || null;
    const s = Store.settings();
    const today = Store.todayStr();

    if (id) {
      const r = Store.all().find(x => x.id === id);
      if (!r) return;
      draft = { type: r.type, cat: r.cat, account: r.account, date: r.date, note: r.note };
      expr = Store.fmt(r.amount);
    } else {
      const cat = (s.expenseCats[0] || '餐饮');
      draft = {
        type: 'expense',
        cat: cat,
        account: s.lastAccountByCat[cat] || s.accounts[0] || '微信',
        date: presetDate || today,          // 从日历点某一天进来时，日期就定在那天
        note: ''
      };
      expr = '';
    }
    // 记下「打开录入页那一刻的今天」，保存时用它判断用户有没有动过日期 ——
    // 见 doSave 里那段跨零点处理（23:58 打开、00:02 保存的账不该被标成「补记」）。
    draftToday = today;

    $('entry-title').textContent = id ? '改一笔' : '记一笔';
    $('view-entry').classList.toggle('editing', !!id);
    $('note').value = draft.note || '';

    renderSeg(); renderCats(); renderDateChips(); renderAccts(); renderAmount();
    $('view-entry').classList.remove('hidden');
    requestAnimationFrame(() => {
      $('view-entry').classList.add('open');
      // 必须等这一帧的布局落定再量：刚 remove('hidden') 时高度还是 0
      updateSheetHint();
    });
    hideBar('redo');     // 只顶掉「再记一笔」那条，别把「撤销」也顶掉
  }

  // 当前页重画：记账页（顺带统计页）+ 搜索页。
  // 删除、撤销、导入之后都要调 —— 以前撤销只调 renderLedger，
  // 搜索页里数据已经回来了、列表却还是少一行（第三轮审查 🟠 B4）。
  function refreshAfterChange() {
    renderLedger();
    if (curTab === 'search') renderSearch();
  }

  let entryHideTimer = null;
  function closeEntry() {
    $('view-entry').classList.remove('open');
    // 230ms：CSS 滑出过渡是 220ms，200 会把最后 20ms 硬切；
    // 而且这个 timer 必须能被取消 —— 200ms 内重新打开录入页，
    // 旧 timer 会把刚打开的页面再藏掉（第三轮审查 🟡 C7，已实测）。
    clearTimeout(entryHideTimer);
    entryHideTimer = setTimeout(() => $('view-entry').classList.add('hidden'), 230);
    // ⚠️ draft 置成**空对象**而不是 null：备注框的 input 监听器是常驻的，
    // 输入法在拼字（composition）时按了取消/保存，IME 会把候选字提交上来、
    // 在已失焦的框上补发一个 input 事件 —— 那时 draft 若是 null，就是
    // 「Cannot set properties of null」，被 window.onerror 接住、顶上糊一条红条。
    editingId = null; expr = ''; draft = {};
    refreshAfterChange();
  }

  function renderSeg() {
    document.querySelectorAll('#seg button').forEach(b =>
      b.classList.toggle('on', b.dataset.type === draft.type));
  }
  document.querySelectorAll('#seg button').forEach(b => b.addEventListener('click', () => {
    draft.type = b.dataset.type;
    // 切到收入时，如果当前分类不在收入分类里，换成第一个收入分类
    const s = Store.settings();
    const pool = draft.type === 'income' ? s.incomeCats : s.expenseCats;
    if (pool.indexOf(draft.cat) < 0) { draft.cat = pool[0]; draft.account = s.lastAccountByCat[draft.cat] || draft.account; }
    renderSeg(); renderCats(); renderAccts(); buzz();
  }));

  function renderCats() {
    const s = Store.settings();
    const pool = draft.type === 'income' ? s.incomeCats : s.expenseCats;
    // 直接用手动顺序，不按「常用度」自动排。
    // 理由：顺序会变的话手指就记不住位置，而「3 秒一笔」靠的正是肌肉记忆。
    // （这条改掉了原来"常用分类排在前面"的设计，因为管理页提供了上移下移，
    //   两者同时存在会互相打架：你调完顺序，下次记账它又自己变了。）
    const sorted = pool.slice();
    $('cat-grid').innerHTML = sorted.map(c =>
      '<button class="g' + (c === draft.cat ? ' on' : '') + '" data-cat="' + esc(c) + '">' + esc(c) + '</button>'
    ).join('') + '<button class="g more" data-more="1">＋</button>';

    $('cat-grid').querySelectorAll('.g[data-cat]').forEach(b => b.addEventListener('click', () => {
      draft.cat = b.dataset.cat;
      const s2 = Store.settings();
      // 按分类记住上次用的支付方式
      if (s2.lastAccountByCat[draft.cat]) draft.account = s2.lastAccountByCat[draft.cat];
      renderCats(); renderAccts(); buzz();
    }));
    $('cat-grid').querySelector('[data-more]').addEventListener('click', addCategory);
  }

  function addCategory() {
    const pool = draft.type === 'income' ? 'incomeCats' : 'expenseCats';
    inputBox('新建' + (draft.type === 'income' ? '收入' : '支出') + '分类', '', v => {
      const r = Store.addEntry(pool, v);
      if (!r.ok) return r.why;
      draft.cat = String(v).trim();
      renderCats(); buzz();
      return null;
    });
  }

  function renderDateChips() {
    const today = Store.todayStr();
    const y1 = Store.todayStr(new Date(Date.now() - 864e5));
    const y2 = Store.todayStr(new Date(Date.now() - 2 * 864e5));
    document.querySelectorAll('#date-chips .chip').forEach(chip => {
      const d = chip.dataset.day;
      chip.classList.toggle('on',
        (d === '0' && draft.date === today) ||
        (d === '-1' && draft.date === y1) ||
        (d === '-2' && draft.date === y2));
    });
    $('chip-cal').classList.toggle('on', draft.date !== today && draft.date !== y1 && draft.date !== y2);
    // 不是本年度的日期要带上年份 —— 只写「06月05日」的话，
    // 从选择器翻到去年选的日子看不出来，会静默把账记到上一年去。
    const otherYear = draft.date.slice(0, 4) !== today.slice(0, 4);
    $('chip-cal').textContent = (draft.date !== today && draft.date !== y1 && draft.date !== y2)
      ? (otherYear
          ? draft.date.slice(0, 4) + '年' + parseInt(draft.date.slice(5, 7), 10) + '月' +
            parseInt(draft.date.slice(8), 10) + '日'
          : draft.date.slice(5).replace('-', '月') + '日')
      : '选日期';
  }
  document.querySelectorAll('#date-chips .chip[data-day]').forEach(chip =>
    chip.addEventListener('click', () => {
      const off = parseInt(chip.dataset.day, 10);
      draft.date = Store.todayStr(new Date(Date.now() + off * 864e5));
      renderDateChips(); buzz();
    }));
  // 自建日期选择器。
  // 不用系统自带的 <input type="date">：① 它会继承 App 的窗口背景（之前就是它把启动图
  // 的「资」字当背景画了出来）；② 长得跟这个 App 完全不搭。
  // 这套日历和「统计」页那套同源，风格一致。复用在两处：录入页的日期、搜索页的时间范围。
  let dpMonth = null, dpMark = null, dpOnPick = null;

  function openDatePicker(initial, onPick) {
    dpMark = initial || Store.todayStr();
    dpOnPick = onPick || function (d) { draft.date = d; renderDateChips(); };
    dpMonth = dpMark.slice(0, 7);
    renderDatePicker();
    $('date-modal').classList.add('show');
  }

  function renderDatePicker() {
    const p = dpMonth.split('-').map(Number);
    const days = new Date(p[0], p[1], 0).getDate();
    const ws = Store.pref('weekStart');                     // 跟随设置里的「一周从哪天算」
    const lead = (new Date(p[0], p[1] - 1, 1).getDay() + 7 - ws) % 7;
    const today = Store.todayStr();

    $('dp-label').textContent = p[0] + ' 年 ' + p[1] + ' 月';

    // 表头也要跟着偏好走 —— 否则统计页的日历是周日开头、这个日期选择器还是周一开头，
    // 同一个 App 里两套日历不一致。
    let html = (ws === 1 ? ['一', '二', '三', '四', '五', '六', '日']
                         : ['日', '一', '二', '三', '四', '五', '六'])
      .map(w => '<span class="dp-w">' + w + '</span>').join('');
    for (let i = 0; i < lead; i++) html += '<span class="dp-d blank"></span>';
    for (let d = 1; d <= days; d++) {
      const ds = dpMonth + '-' + String(d).padStart(2, '0');
      html += '<button class="dp-d' + (ds === dpMark ? ' on' : '') +
        (ds === today ? ' today' : '') + '" data-d="' + ds + '">' + d + '</button>';
    }
    $('dp-grid').innerHTML = html;

    // 点一天就选定并关闭 —— 少点一下
    $('dp-grid').querySelectorAll('.dp-d[data-d]').forEach(el =>
      el.addEventListener('click', () => {
        $('date-modal').classList.remove('show');
        const d = el.dataset.d;
        if (dpOnPick) dpOnPick(d);
        buzz();
      }));
  }

  $('chip-cal').addEventListener('click', () => openDatePicker(draft.date));
  $('dp-prev').addEventListener('click', () => { dpMonth = Store.shiftMonth(dpMonth, -1); renderDatePicker(); });
  $('dp-next').addEventListener('click', () => { dpMonth = Store.shiftMonth(dpMonth, 1); renderDatePicker(); });
  $('dp-cancel').addEventListener('click', () => $('date-modal').classList.remove('show'));

  function renderAccts() {
    const s = Store.settings();
    $('acct-chips').innerHTML = s.accounts.map(a =>
      '<button class="chip' + (a === draft.account ? ' on' : '') + '" data-a="' + esc(a) + '">' + esc(a) + '</button>'
    ).join('');
    $('acct-chips').querySelectorAll('.chip').forEach(b => b.addEventListener('click', () => {
      draft.account = b.dataset.a; renderAccts(); buzz();
    }));
  }

  /* ---------- 金额键盘 ---------- */
  function renderAmount() {
    const el = $('amount');
    if (/[+\-×÷]/.test(expr)) {
      const cents = evalExpr(expr);
      const t = Store.fmtGroup(cents);
      const dot = t.lastIndexOf('.');
      el.innerHTML = '<span class="cur">¥</span>' + t.slice(0, dot) +
        '<span class="dec">' + t.slice(dot) + '</span><span class="caret"></span>';
      $('expr').textContent = expr.replace(/\+/g, ' ＋ ').replace(/-/g, ' − ')
        .replace(/×/g, ' × ').replace(/÷/g, ' ÷ ');
    } else {
      const shown = expr || '0';
      const dot = shown.indexOf('.');
      el.innerHTML = '<span class="cur">¥</span>' +
        (dot < 0 ? shown : shown.slice(0, dot) + '<span class="dec">' + shown.slice(dot) + '</span>') +
        '<span class="caret"></span>';
      $('expr').textContent = '';
    }
  }

  function press(k) {
    buzz();
    if (k === 'del') { expr = expr.slice(0, -1); renderAmount(); return; }
    if (k === '.') {
      const tail = expr.split(/[+\-×÷]/).pop();
      if (tail.indexOf('.') >= 0) return;
      expr += tail === '' ? '0.' : '.';
      renderAmount(); return;
    }
    // 运算符。注意要同时认两种减号：index.html 里按钮发的是 ASCII 的 "-"，
    // 而表达式里显示/存的是 U+2212 的 "−"。原来只判断了后者，
    // 于是减号永远进不了这个分支（靠下面兜底也能拼对，但那是运气，不是设计）。
    if (k === '+' || k === '−' || k === '-' || k === '×' || k === '÷') {
      if (!expr) return;
      if (/[+\-−×÷]$/.test(expr)) expr = expr.slice(0, -1);   // 连按运算符就替换
      expr += (k === '−' || k === '-' ? '-' : k);
      renderAmount(); return;
    }
    // 数字：防止一个数字段太长
    const tail = expr.split(/[+\-×÷]/).pop();
    if (tail.replace('.', '').length >= 8) return;
    // 小数位最多两位。不限的话「12.567」屏上显示 ¥12.567、而存进去是 12.56
    // （toCents 走字符串截断），屏幕在说谎；而带运算符那条路走的是四舍五入 ——
    // 同一个数两条路规则不一致。直接在键盘上挡住第三位最省事。
    const dot0 = tail.indexOf('.');
    if (dot0 >= 0 && tail.length - dot0 - 1 >= 2) return;
    if (tail === '0' && k !== '.') expr = expr.slice(0, -1);
    expr += k;
    renderAmount();
  }
  document.querySelectorAll('#pad .k').forEach(b =>
    b.addEventListener('click', () => press(b.dataset.k)));

  // 表达式求值 → 返回「分」
  function evalExpr(e) {
    let s = e.replace(/[+\-×÷.]+$/, '');
    if (!s) return 0;
    // 只有一个数字（没有运算符）时走精确转换 —— 免得 4.015 这种被浮点误差吃掉一分
    if (!/[+\-×÷]/.test(s)) return toCents(s);
    const tokens = s.match(/(\d+(?:\.\d*)?)|[+\-×÷]/g) || [];
    if (!tokens.length) return 0;
    const stack = [parseFloat(tokens[0]) || 0];
    for (let i = 1; i < tokens.length; i += 2) {
      const op = tokens[i], n = parseFloat(tokens[i + 1]);
      if (isNaN(n)) break;
      if (op === '×') stack[stack.length - 1] *= n;
      else if (op === '÷') stack[stack.length - 1] = n === 0 ? 0 : stack[stack.length - 1] / n;
      else if (op === '+') stack.push(n);
      else stack.push(-n);
    }
    // 带运算符的表达式只能浮点算，算完在这里收口四舍五入到分
    const v = stack.reduce((a, b) => a + b, 0);
    return Math.round(v * 100);
  }

  /* ---------- 备注：历史提示 ---------- */
  const noteInput = $('note');
  noteInput.addEventListener('focus', () => {
    $('pad').style.display = 'none';               // 自绘键盘让位给系统键盘
    $('btn-save-top').classList.add('show');       // 兜底：万一系统键盘盖住底部保存键
    renderNoteHints('');
    setTimeout(() => { try { noteInput.scrollIntoView({ block: 'center' }); } catch (e) {} }, 260);
  });
  noteInput.addEventListener('blur', () => {
    setTimeout(() => {
      $('pad').style.display = '';
      $('btn-save-top').classList.remove('show');
      hideNoteHints();
    }, 120);
  });

  // 安卓的已知行为：用系统键盘上的「收起 ∨」键隐藏键盘时，输入框**不会失焦**，
  // 所以上面的 blur 逻辑根本不触发 —— 结果是系统键盘没了、自绘键盘也没回来，
  // 用户面前一个键盘都没有。官方 Keyboard 插件能捕获「键盘已收起」，用它补这个洞。
  const Keyboard = isNative && window.Capacitor.Plugins.Keyboard;
  if (Keyboard && Keyboard.addListener) {
    // addListener 返回 Promise：插件拒收时同步 try/catch 抓不到，会弹红条。
    const p = Keyboard.addListener('keyboardDidHide', () => {
      if (document.activeElement === noteInput) noteInput.blur();
    });
    if (p && typeof p.catch === 'function') p.catch(function () {});
  }
  noteInput.addEventListener('input', () => {
    draft.note = noteInput.value;
    renderNoteHints(noteInput.value);
  });
  function renderNoteHints(q) {
    // 按「用过几次」取前 5 个。原来是按「最近用过」取 8 个 —— 结果一次性长备注
    // （比如某个实习工资的名目）也混进来，撑成三行，把界面顶变形。
    const hits = Store.topNotes(Store.pref('noteHints'), q);
    let box = $('note-hints');
    if (!box) {
      box = document.createElement('div');
      box.id = 'note-hints';
      box.className = 'chips';
      // 这个盒子是 createElement 出来的，挂在 .fields 下面 ——
      // 所以 .f .chips{gap:6px} 那条选择器命中不了它。
      // 间距和缩进必须自己写清楚，否则 chips 会挤在一起、还比上面一行多缩进 16px。
      box.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;padding:0 0 10px';
      noteInput.closest('.f').parentNode.appendChild(box);
    }
    box.style.display = hits.length ? 'flex' : 'none';
    box.innerHTML = hits.map(n => '<button class="chip" data-n="' + esc(n) + '" title="' + esc(n) + '">' + esc(n) + '</button>').join('');
    box.querySelectorAll('.chip').forEach(b => b.addEventListener('mousedown', ev => {
      ev.preventDefault();
      noteInput.value = b.dataset.n; draft.note = b.dataset.n;
      renderNoteHints(b.dataset.n);
    }));
  }
  function hideNoteHints() { const b = $('note-hints'); if (b) b.style.display = 'none'; }

  /* ---------- 保存 / 删除 ---------- */
  $('btn-cancel').addEventListener('click', closeEntry);

  $('btn-save').addEventListener('click', doSave);
  $('btn-save-top').addEventListener('click', doSave);

  // 点金额区域 = 收起系统键盘，自绘键盘回来
  $('amount').addEventListener('click', () => {
    if (document.activeElement === noteInput) noteInput.blur();
  });

  // 把「12.5」这样的小数精确转成分。
  // 不能写 Math.round(x * 100)：4.015 * 100 在浮点里是 401.49999999999994，
  // 会存成 401 分（4.01 而不是 4.02）。三位小数日常记账碰不到，
  // 但既然能用字符串精确算，就没必要留着这个隐患。
  function toCents(s) {
    const t = String(s).trim();
    const m = /^(\d*)(?:\.(\d{0,2})\d*)?$/.exec(t);
    if (!m) return NaN;
    const yuan = m[1] ? parseInt(m[1], 10) : 0;
    const frac = (m[2] || '').padEnd(2, '0');
    return yuan * 100 + (frac ? parseInt(frac, 10) : 0);
  }

  async function doSave() {
    const cents = /[+\-×÷]/.test(expr) ? evalExpr(expr) : toCents(expr || '0');
    // 提示要分清三种情况 —— 以前一律说「金额还没填」，
    // 而 10-20 的时候屏上明明写着 ¥-10.00，用户看到的是「我明明填了」。
    if (!isFinite(cents)) { toast('这个算式算不出来'); return; }
    // 新增必须 > 0；**编辑**允许 0（导入的 0 元记录改个备注/分类时不该被卡住）
    if (cents === 0 && !editingId) { toast('金额是 0，先填个数'); return; }
    if (cents < 0) { toast('算出来是负数，检查一下算式'); return; }
    // 上限：1e11 分 = 10 亿元（注释以前写「1000 亿」，差了 100 倍）。
    // 为什么必须有：键盘只限制「一个数字段 8 位」，但 × ÷ 可以无限拼 ——
    // 99999999×99999999 能存进 999999980000000000 分，超过 Number.MAX_SAFE_INTEGER。
    // 那时首页的结余会显示一个**失真的数字**，而且这份数据导出之后
    // **自己都导不回来**（validRec 要求 Number.isSafeInteger）。
    if (cents > 1e11) { toast('金额太大了，检查一下算式'); return; }
    draft.note = noteInput.value.trim();
    // 跨零点：如果用户没动过日期（还是打开录入页那天的值），就按**保存时**的今天重算。
    // 不然 23:58 打开、00:02 才点保存的那笔，createdAt 是次日而 date 还是昨天 ——
    // isBackfilled 会把它标成「补记」，可用户根本没做补记操作。
    if (!editingId && draft.date === draftToday) draft.date = Store.todayStr();
    if (document.activeElement === noteInput) noteInput.blur();

    if (editingId) {
      // 必须把 cents 一起放进 patch。
      // 编辑时 draft 里**从来没有 amount**（金额进的是键盘的 expr，见 openEntry），
      // 只传 draft 的话，分类/日期/备注/支付方式都会改，**只有金额静默不更新** ——
      // 而界面还会告诉你"已更新"。这是最坏的一类 bug：不报错、钱没变、还说成功了。
      Store.update(editingId, Object.assign({ amount: cents }, draft));
      buzz('MEDIUM');
      closeEntry();
      // 主动落盘一次并检查结果 —— 落盘失败必须让用户知道。
      // PWA 撞上 localStorage 配额时，是从那一刻起**全部不再落盘**（磁盘冻结在最后一版），
      // 而界面还在说「已记下」；用户刷新页面才发现记录没了。
      toast(await Store.flush() === false ? '保存失败：存储空间可能满了，先导出备份' : '已更新');
    } else {
      const saved = Store.add(Object.assign({ amount: cents }, draft));
      buzz('MEDIUM');
      closeEntry();
      if (await Store.flush() === false) {
        toast('保存失败：存储空间可能满了，先导出备份');
      } else {
        showBarUnlessUndo('已记下 ' + Store.fmtGroup(saved.amount) + (saved.note ? ' · ' + saved.note : ''),
          '再记一笔', () => openEntry(null), 5000);
      }
    }
  }

  $('btn-delete').addEventListener('click', () => {
    if (!editingId) return;
    const gone = Store.remove(editingId);
    buzz('MEDIUM');
    closeEntry();
    // 删除后的撤销机会给足 6 秒，而且它**不会被「＋ 记一笔」顶掉**（见 hideBar 的 onlyKind）
    if (gone) showBar('已删除 ' + Store.fmtGroup(gone.amount), '撤销',
      () => { Store.restore(gone); refreshAfterChange(); }, 6000, 'undo');
  });

  /* ---------------------------------------------------------
     备份与恢复
     --------------------------------------------------------- */
  const Filesystem = isNative ? window.Capacitor.Plugins.Filesystem : null;
  const Share = isNative ? window.Capacitor.Plugins.Share : null;
  const AppPl = isNative ? window.Capacitor.Plugins.App : null;

  function updateBackupHint() {
    const el = $('backup-hint');
    if (!el) return;
    const total = Store.all().length;
    const d = Store.daysSinceBackup();
    const days = Store.pref('backupDays');
    if (!days) { el.style.display = 'none'; return; }     // 偏好里选了「不提醒」
    if (d === null && total >= 5) {
      el.textContent = '还没有备份过 · 备份文件要发到微信才保险 →';
      el.style.display = 'block';
    } else if (d !== null && d >= days) {
      el.textContent = '已经 ' + d + ' 天没备份了 · 点这里导出 →';
      el.style.display = 'block';
    } else {
      el.style.display = 'none';
    }
  }

  function openBackup() {
    $('bk-count').textContent = Store.all().length + ' 笔';
    const d = Store.daysSinceBackup();
    $('bk-when').textContent = d === null ? '从未备份'
      : (d === 0 ? '今天' : (d === 1 ? '昨天' : d + ' 天前'));
    $('backup-modal').classList.add('show');
  }
  $('backup-hint').addEventListener('click', openBackup);
  $('bk-close').addEventListener('click', () => $('backup-modal').classList.remove('show'));
  $('backup-modal').addEventListener('click', e => {
    if (e.target.id === 'backup-modal') $('backup-modal').classList.remove('show');
  });

  // 导出：写一个文件，然后调起系统分享面板发给微信
  async function exportFile(name, content, mime) {
    if (!isNative) {                       // 电脑浏览器里调试：直接下载
      const blob = new Blob([content], { type: mime });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 3000);
      return;
    }
    await Store.flush();                   // 先把没落地的写进去，别导出半截数据
    const w = await Filesystem.writeFile({
      path: name, data: content, directory: 'CACHE', encoding: 'utf8'
    });
    await Share.share({
      title: '小资记账备份',
      text: '小资记账的账目备份，发给「文件传输助手」保存',
      files: [w.uri],
      dialogTitle: '发送到…'
    });
  }

  // 「我已经把备份发出去了」—— 导出成功**不等于**真的存下来了
  // （分享面板可以取消，而安卓上取消也照样 resolve）。
  // 所以这一步由用户确认。两个入口：导出后的提示条、以及备份弹窗里那一行。
  // ⚠️ 弹窗里那个入口是必须的：提示条只存在 20 秒，错过之后就没有任何地方
  // 能告诉 App「我备份过了」—— 首页那条「已经 N 天没备份了」会一直挂着，
  // 唯一的办法是再导出一次。
  function markBackedUp() {
    Store.saveSettings({ lastBackupAt: Date.now() });
    updateBackupHint();
    toast('已记为今天备份', 2600);
  }

  // 导出 / 导出表格共用一把「正在导出」的锁：连点两次会连续弹两次分享面板
  //（数据安全有 flush 锁兜住，但体验很差）。第三轮审查 🟡 C17。
  let exporting = false;

  $('bk-export').addEventListener('click', async () => {
    if (exporting) return;
    exporting = true;
    try {
      await exportFile('小资记账备份' + Store.todayStr() + '.json',
        Store.toJSON(), 'application/json');
      $('backup-modal').classList.remove('show');
      // 撤销条还在显示时不要顶掉它（见 showBarUnlessUndo）
      showBarUnlessUndo('备份已准备好 —— 在微信里发给「文件传输助手」了吗？',
        '已经发出去了', markBackedUp, 20000, 'backup');
    } catch (e) {
      toast('导出失败：' + (e && e.message ? e.message : e), 3600);
    } finally {
      exporting = false;
    }
  });

  // 备份弹窗里的常驻入口（提示条错过之后的兜底）
  $('bk-mark').addEventListener('click', () => {
    markBackedUp();
    $('backup-modal').classList.remove('show');
  });

  $('bk-csv').addEventListener('click', async () => {
    if (exporting) return;
    exporting = true;
    try {
      await exportFile('小资记账表格' + Store.todayStr() + '.csv', Store.toCSV(), 'text/csv');
      toast('表格已发出（给 Excel 看的，不能导回来）', 3600);
    } catch (e) {
      toast('导出失败：' + (e && e.message ? e.message : e), 3600);
    } finally {
      exporting = false;
    }
  });

  async function doImport(text) {
    try {
      const r = await Store.importJSON(text);
      $('backup-modal').classList.remove('show');
      refreshAfterChange();       // 在搜索页导入时，结果列表也要跟着变
      const base = '导入完成：新增 ' + r.added + ' 笔，更新 ' + r.updated + ' 笔' +
        (r.skipped ? '，跳过 ' + r.skipped + ' 笔格式不对的' : '') +
        '，共 ' + r.total + ' 笔';
      // 导入成功但写不进文件：必须说清楚，否则重启后数据就没了（🟠 B7）
      toast(r.writeError
        ? base + '。⚠️ 但写入文件失败（存储可能满了），先别关 App，导出备份！'
        : base, r.writeError ? 6000 : 3800);
    } catch (err) {
      toast('导入失败：' + (err && err.message ? err.message : err), 3800);
    }
  }

  // 导入路径一：系统文件选择器
  // （安卓 WebView 会弹系统选择器；电脑浏览器里也能用来测试）
  $('bk-import').addEventListener('click', () => {
    const f = $('import-file');
    f.value = '';
    f.click();
  });
  $('import-file').addEventListener('change', e => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => doImport(String(reader.result || ''));
    reader.onerror = () => toast('读文件失败');
    reader.readAsText(file, 'utf-8');
  });

  // 导入路径二：在微信里点开备份文件 → 用其他应用打开 → 小资记账
  // （已核实 @capacitor/app 的安卓源码会处理 ACTION_VIEW 并抛出 appUrlOpen）
  //
  // 两个坑都在这条路上：
  // ① 冷启动时同一个 intent 会被处理两次 —— appUrlOpen 是 retainUntilConsumed
  //    （JS 没注册也会补发），而 BridgeActivity 冷启动时又自己调了一次 onNewIntent，
  //    所以 appUrlOpen 和 getLaunchUrl 会各触发一次。第二次是空合并，白弹一个提示。
  // ② 补发的 appUrlOpen 可能赶在 Store.init 之前到，那时 db 还是 null，
  //    Store.importJSON 会抛错，你会看到一句"导入失败：Cannot read properties of null"，
  //    而数据其实还没导进来。
  // 所以：等开机完成再导，并且同一个 uri 只处理一次。
  let readyResolve = null;
  const ready = new Promise(function (res) { readyResolve = res; });
  const seenUri = {};

  async function importFromUri(uri) {
    if (!uri || !Filesystem) return;
    if (seenUri[uri]) {
      toast('这个文件刚刚已经导过一次了');   // 至少给一句提示，别什么都不发生
      return;
    }
    seenUri[uri] = 1;
    await ready;                       // 等 Store.init 跑完，否则 db 还是 null
    try {
      const r = await Filesystem.readFile({ path: uri, encoding: 'utf8' });
      const text = typeof r.data === 'string' ? r.data : '';
      if (text) await doImport(text);
    } catch (e) {
      // 失败就把标记撤掉 —— 否则用户把文件改好、再从微信点开同一个 uri，
      // 会什么都不发生、连一句提示都没有（他只会觉得「这 App 坏了」）。
      delete seenUri[uri];
      toast('读取文件失败：' + (e && e.message ? e.message : e), 3600);
    }
  }
  if (AppPl && AppPl.addListener) {
    AppPl.addListener('appUrlOpen', data => { if (data && data.url) importFromUri(data.url); });
    setTimeout(async () => {                 // 冷启动时也要接住
      try {
        const r = await AppPl.getLaunchUrl();
        if (r && r.url) importFromUri(r.url);
      } catch (e) {}
    }, 500);
  }

  /* ---------------------------------------------------------
     诊断面板：长按顶部「小资记账」标题 0.8 秒
     用途：手机上的显示问题（状态栏重叠、键盘遮挡等）我这边看不到，
     让 App 自己把关键数值报出来，比来回猜快得多。
     --------------------------------------------------------- */
  function showDiag() {
    const cs = getComputedStyle(document.documentElement);    const varTop = cs.getPropertyValue('--safe-area-inset-top').trim() || '(未注入)';
    const varBot = cs.getPropertyValue('--safe-area-inset-bottom').trim() || '(未注入)';

    const probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;top:0;left:0;width:0;height:env(safe-area-inset-top,0px);';
    document.body.appendChild(probe);
    const envTop = probe.getBoundingClientRect().height;
    probe.style.height = 'env(safe-area-inset-bottom,0px)';
    const envBot = probe.getBoundingClientRect().height;
    probe.remove();

    const csView = getComputedStyle($('view-ledger'));

    // 视口底部（往上 4 像素）那个点上，到底是哪个元素、它是什么底色
    function bottomProbe() {
      const el = document.elementFromPoint(window.innerWidth / 2, window.innerHeight - 4);
      if (!el) return '(取不到)';
      const name = el.id ? '#' + el.id
        : (el.className ? '.' + String(el.className).split(' ')[0] : el.tagName);
      return name + ' · ' + getComputedStyle(el).backgroundColor;
    }
    const rows = [
      ['WebView 版本', (navigator.userAgent.match(/Chrome\/[\d.]+/) || ['未识别'])[0]],
      ['--safe-area-inset-top', varTop],
      ['--safe-area-inset-bottom', varBot],
      ['env(safe-area-inset-top)', envTop + ' px'],
      ['env(safe-area-inset-bottom)', envBot + ' px'],
      ['录入页实际顶部留白', csView.paddingTop],
      ['视口高 / 屏高', window.innerHeight + ' / ' + screen.height + ' px'],
      ['设备像素比', String(window.devicePixelRatio)],
      ['运行环境', isNative ? '手机 App' : '电脑浏览器'],
      ['数据条数', String(Store.all().length)],
      // 一个元素一个元素往上问，看到底是谁在画那块颜色
      ['body 背景色', getComputedStyle(document.body).backgroundColor],
      ['页面高 / 视口高', document.documentElement.scrollHeight + ' / ' + window.innerHeight + ' px'],
      ['视口底部那个元素', bottomProbe()]
    ];

    // 真正的存储自检。
    // 原来那个 selfcheck.html 测的是 IndexedDB —— 而数据层早就换成了
    // Filesystem 里的一个 JSON 文件，测的根本不是我们在用的东西，
    // 而且 App 里也没有入口能打开它。所以把该测的挪到这里，测真东西。
    rows.push(['文件能否解析', (function () {
      try { JSON.parse(Store.toJSON()); return '能 ✓'; } catch (e) { return '不能 ✗'; }
    })()]);
    const bkDays = Store.daysSinceBackup();
    rows.push(['上次导出备份', bkDays === null ? '从未' : (bkDays === 0 ? '今天' : bkDays + ' 天前')]);

    const stash = document.createElement('div');
    stash.id = 'diag-extra';
    stash.style.cssText = 'margin-top:4px';
    if (isNative && Filesystem) {
      stash.textContent = '正在读文件…';
      // 文件大小/时间是异步拿的，所以先占位、后面补进去
      setTimeout(async function () {
        let html = '';
        async function line(label, name, missing) {
          try {
            const st = await Filesystem.stat({ path: name, directory: 'DATA' });
            html += rowHTML(label, Math.round(st.size / 1024) + ' KB · ' +
              new Date(st.mtime).toLocaleString());
          } catch (e) { html += rowHTML(label, missing); }
        }
        await line('数据文件', 'xiaozi-data.json', '读不到');
        await line('备份文件', 'xiaozi-data.bak.json', '还没有（第二次记账后才有）');
        await line('升级前存档', 'xiaozi-data.before-v3.json', '没有（说明没经历过结构升级）');
        stash.innerHTML = html;
      }, 0);
    }

    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;inset:0;z-index:200;background:rgba(35,32,27,.92);' +
      'color:#FAF7F0;padding:24px 18px;overflow:auto;font-size:12px;line-height:1.9;' +
      'font-family:ui-monospace,Consolas,monospace;-webkit-user-select:text;user-select:text';
    function rowHTML(k, v) {
      return '<div style="display:flex;justify-content:space-between;gap:12px;' +
        'border-bottom:1px solid rgba(250,247,240,.15);padding:6px 0">' +
        '<span style="color:#A79E8F">' + k + '</span><span>' + v + '</span></div>';
    }
    box.innerHTML = '<div style="font-size:14px;font-family:sans-serif;margin-bottom:14px">诊断信息</div>' +
      rows.map(r => rowHTML(r[0], r[1])).join('') +
      (isNative ? '<div id="diag-slot"></div>' : '') +
      '<div style="margin-top:22px;text-align:center">' +
      '<button id="diag-close" style="font-family:sans-serif;font-size:14px;padding:11px 30px;' +
      'background:#FAF7F0;color:#23201B;border:none;border-radius:3px">关闭</button></div>';
    document.body.appendChild(box);
    const slot = $('diag-slot');
    if (slot) slot.appendChild(stash);
    $('diag-close').addEventListener('click', () => box.remove());
  }

  (function bindDiag() {
    document.querySelectorAll('.brand').forEach(el => {
      let timer = null;
      const start = () => { clearTimeout(timer); timer = setTimeout(showDiag, 800); };
      const stop = () => clearTimeout(timer);
      el.addEventListener('touchstart', start, { passive: true });
      el.addEventListener('touchend', stop);
      el.addEventListener('touchmove', stop);
      el.addEventListener('touchcancel', stop);
      el.addEventListener('mousedown', start);
      el.addEventListener('mouseup', stop);
      el.addEventListener('mouseleave', stop);
    });
  })();

  /* ---------------------------------------------------------
     搜索页
     --------------------------------------------------------- */
  const srTime = { key: 'all', from: '', to: '' };      // 时间筛选
  // cat/pay 的「全部」哨兵用 '*'，不用 'all'：分类/支付方式名是用户可编辑的，
  // 有人真建了一个叫 all 的分类，就没法单独筛它了（第三轮审查 🟡 C15）。
  const srF = { type: 'all', cat: '*', pay: '*', min: 0 };  // 其余筛选（pay：v1.7.0）
  let srTimer = null;

  const SR_TIME = [
    { k: 'all', t: '全部' }, { k: 'month', t: '本月' },
    { k: 'year', t: '今年' }, { k: 'custom', t: '自定义' }
  ];
  const SR_TYPE = [
    { k: 'all', t: '全部' }, { k: 'expense', t: '支出' },
    { k: 'income', t: '收入' }, { k: 'void', t: '不计收支' }
  ];
  const SR_AMT = [
    { k: 0, t: '不限' }, { k: 10000, t: '100 以上' }, { k: 50000, t: '500 以上' },
    { k: 100000, t: '1000 以上' }, { k: 500000, t: '5000 以上' }
  ];

  function srRange() {
    const today = Store.todayStr();
    if (srTime.key === 'month') return { from: today.slice(0, 7) + '-01', to: today };
    if (srTime.key === 'year') return { from: today.slice(0, 4) + '-01-01', to: today };
    if (srTime.key === 'custom') return { from: srTime.from || '', to: srTime.to || '' };
    return { from: '', to: '' };
  }

  // 当前生效的筛选，用一句话概括（显示在「筛选」按钮右边）
  function srSummary() {
    const parts = [];
    const t = SR_TIME.filter(o => o.k === srTime.key)[0];
    if (srTime.key !== 'all') {
      parts.push(srTime.key === 'custom'
        ? (srTime.from || '最早') + ' 起' + (srTime.to ? ' 至 ' + srTime.to : '')
        : t.t);
    }
    if (srF.type !== 'all') parts.push(SR_TYPE.filter(o => o.k === srF.type)[0].t);
    if (srF.cat !== '*') parts.push(srF.cat);
    if (srF.pay !== '*') parts.push(srF.pay);
    if (srF.min) parts.push(Store.compactYuan(srF.min) + ' 元以上');
    return parts.join(' · ');
  }

  function renderSearch() {
    const s = Store.settings();

    $('sr-time').innerHTML = SR_TIME.map(o =>
      '<button class="sr-chip' + (srTime.key === o.k ? ' on' : '') +
      '" data-time="' + o.k + '">' + o.t + '</button>').join('');
    $('sr-dates').classList.toggle('show', srTime.key === 'custom');
    // 日期按钮显示年份：跨年时「01/05」分不清 2025 还是 2026。
    const thisYear = Store.todayStr().slice(0, 4);
    const fmtDay = d => d.slice(0, 4) !== thisYear ? d.replace(/-/g, '/') : d.slice(5).replace('-', '/');
    $('sr-from').textContent = srTime.from ? fmtDay(srTime.from) : '起始日';
    $('sr-to').textContent = srTime.to ? fmtDay(srTime.to) : '结束日';
    $('sr-from').classList.toggle('set', !!srTime.from);
    $('sr-to').classList.toggle('set', !!srTime.to);

    $('sr-type').innerHTML = SR_TYPE.map(o =>
      '<button class="sr-chip' + (srF.type === o.k ? ' on' : '') +
      '" data-type="' + o.k + '">' + o.t + '</button>').join('');

    const cats = ['*'].concat(s.expenseCats);
    s.incomeCats.forEach(c => { if (cats.indexOf(c) < 0) cats.push(c); });
    $('sr-cat').innerHTML = cats.map(c =>
      '<button class="sr-chip' + (srF.cat === c ? ' on' : '') +
      '" data-cat="' + esc(c) + '">' + (c === '*' ? '全部' : esc(c)) + '</button>').join('');

    // 支付方式筛选（v1.7.0）：全部 + 当前账本的支付方式清单
    const pays = ['*'].concat(s.accounts || []);
    $('sr-pay').innerHTML = pays.map(p =>
      '<button class="sr-chip' + (srF.pay === p ? ' on' : '') +
      '" data-pay="' + esc(p) + '">' + (p === '*' ? '全部' : esc(p)) + '</button>').join('');

    $('sr-amt').innerHTML = SR_AMT.map(o =>
      '<button class="sr-chip' + (srF.min === o.k ? ' on' : '') +
      '" data-amt="' + o.k + '">' + o.t + '</button>').join('');

    $('sr-active').textContent = srSummary();

    // 绑事件
    $('sr-time').querySelectorAll('[data-time]').forEach(b => b.addEventListener('click', () => {
      srTime.key = b.dataset.time; renderSearch();
    }));
    $('sr-type').querySelectorAll('[data-type]').forEach(b => b.addEventListener('click', () => {
      srF.type = b.dataset.type; renderSearch();
    }));
    $('sr-cat').querySelectorAll('[data-cat]').forEach(b => b.addEventListener('click', () => {
      srF.cat = b.dataset.cat; renderSearch();
    }));
    $('sr-pay').querySelectorAll('[data-pay]').forEach(b => b.addEventListener('click', () => {
      srF.pay = b.dataset.pay; renderSearch();
    }));
    $('sr-amt').querySelectorAll('[data-amt]').forEach(b => b.addEventListener('click', () => {
      srF.min = parseInt(b.dataset.amt, 10) || 0; renderSearch();
    }));
    $('sr-from').onclick = () => openDatePicker(
      srTime.from || (Store.todayStr().slice(0, 8) + '01'),
      d => {
        srTime.from = d;
        // 起始日晚于结束日 → 静默 0 条会被当成「账本里没有」。清掉另一端并说一声。
        if (srTime.to && srTime.from > srTime.to) { srTime.to = ''; toast('起始日晚于结束日，已清掉结束日'); }
        renderSearch();
      });
    $('sr-to').onclick = () => openDatePicker(
      srTime.to || Store.todayStr(),
      d => {
        srTime.to = d;
        if (srTime.from && srTime.to < srTime.from) { srTime.from = ''; toast('结束日早于起始日，已清掉起始日'); }
        renderSearch();
      });

    syncResetBtn();
    renderResults();
  }

  function renderResults() {
    const r = srRange();
    const list = Store.search({
      q: $('sr-q').value, type: srF.type, cat: srF.cat, pay: srF.pay,
      min: srF.min, from: r.from, to: r.to
    });
    const s = Store.sum(list);

    // 合计行
    const bits = ['<b>' + list.length + '</b> 笔'];
    if (s.expense) bits.push('支出 <b>' + Store.fmtGroup(s.expense) + '</b>');
    if (s.income) bits.push('收入 <b>' + Store.fmtGroup(s.income) + '</b>');
    if (s.expense && s.income) bits.push('结余 <b>' + Store.fmtGroup(s.net) + '</b>');
    $('sr-sum').innerHTML = bits.join(' · ');

    if (!list.length) {
      const anyFilter = $('sr-q').value || srSummary();
      $('sr-results').innerHTML = '<div class="empty">' +
        (anyFilter ? '没有找到符合条件的记录' : '上面输个词，或者展开「筛选」') + '</div>';
      return;
    }

    // 结果列表要有上限。
    // 默认「全部时间 + 无关键词」时命中数就是全表 —— 上万条时拼 HTML 要几百毫秒、
    // 还要挂上万个监听器，是唯一一个会随数据量"突然卡到不能用"的地方。
    const CAP = 200;
    if (list.length > CAP) {
      $('sr-sum').innerHTML = bits.join(' · ') +
        '<br><span class="sr-cap">只画最近 ' + CAP + ' 条 · 再输个关键词能缩小范围</span>';
    }
    $('sr-results').innerHTML = list.slice(0, CAP).map(r2 => {
      const thisYear = Store.todayStr().slice(0, 4);
      const cls = r2.type === 'income' ? ' income' : (r2.type === 'void' ? ' void' : '');
      const sign = r2.type === 'income' ? '+' : '';
      // 跨年记录补年份：全部时间下 2025 和 2026 的同一天长得一模一样。
      const dstr = r2.date.slice(0, 4) !== thisYear
        ? r2.date.slice(2).replace(/-/g, '/')
        : r2.date.slice(5).replace('-', '/');
      return '<button class="sr-row" data-id="' + esc(r2.id) + '">' +
        '<span class="dt">' + dstr + '</span>' +
        '<span class="mid"><span class="cat">' + esc(r2.cat) + '</span>' +
        (r2.note ? '<span class="note">' + esc(r2.note) + '</span>' : '') + '</span>' +
        '<span class="amt' + cls + '">' + sign + Store.fmtGroup(r2.amount) + '</span></button>';
    }).join('');

    $('sr-results').querySelectorAll('.sr-row').forEach(el =>
      el.addEventListener('click', () => openEntry(el.dataset.id)));
  }

  $('sr-q').addEventListener('input', () => {
    syncResetBtn();                             // 一开始打字，按钮就该亮起来
    clearTimeout(srTimer);
    srTimer = setTimeout(renderResults, 160);   // 打字时不要每敲一下就全量搜
  });
  $('sr-toggle').addEventListener('click', () => {
    $('sr-panel').classList.toggle('open');
    $('sr-toggle').classList.toggle('open');
  });
  // 「清空筛选」按钮的可用状态。
  // 没有任何条件时点它，界面当然一点变化都没有 —— 真机上就被当成"按钮坏了"
  // （用户原话：「点击后也没有效果」）。所以没条件时直接**置灰**：
  // 一眼就知道「现在没东西可清」，而不是点一下发现没反应。
  function syncResetBtn() {
    $('sr-reset').disabled = !($('sr-q').value || srSummary());
  }

  $('sr-reset').addEventListener('click', () => {
    $('sr-q').value = '';
    srTime.key = 'all'; srTime.from = ''; srTime.to = '';
    srF.type = 'all'; srF.cat = '*'; srF.pay = '*'; srF.min = 0;
    renderSearch();          // 它内部会调 renderResults，也顺带刷新按钮状态
  });

  /* ---------------------------------------------------------
     设置页（用户偏好）
     这些是「口味问题」不是对错问题，所以交给你自己换，而不是写死。
     --------------------------------------------------------- */
  const PREFS = [
    // 长辈模式**自己绑定字号**，不再单独设一个「字号」项。
    // 上一版把两者拆开，结果是「开了长辈模式再关掉，字号还停在大号」——
    // 用户得手动再调一次，很别扭。
    // 现在三档就是三种完整状态：关闭 = 标准、大 = 1.25 倍、特大 = 1.45 倍。
    { key: 'elder', label: '长辈模式',
      opts: [['off', '关闭'], ['big', '大'], ['huge', '特大']] },
    { key: 'amountColor', label: '支出金额颜色',
      opts: [['seal', '印泥红'], ['ink', '墨色']] },
    { key: 'theme', label: '外观',
      opts: [['light', '浅色'], ['dark', '深色'], ['auto', '跟随系统']] },
    { key: 'weekStart', label: '一周从哪天算',
      opts: [[1, '周一'], [0, '周日']] },
    { key: 'defaultTab', label: '打开 App 停在',
      opts: [['ledger', '记账'], ['stats', '统计'], ['search', '搜索']] },
    { key: 'noteHints', label: '备注备选数量',
      opts: [[3, '3 个'], [5, '5 个'], [8, '8 个']] },
    // 记账页那行「已记账 X 天 · 连续 Y 天」显不显示 —— 口味问题，做成开关（v1.7.0）
    { key: 'streakLine', label: '记账天数',
      opts: [['on', '显示'], ['off', '隐藏']] },
    { key: 'backupDays', label: '备份提醒',
      opts: [[14, '14 天'], [30, '30 天'], [60, '60 天'], [0, '不提醒']] }
  ];

  let settingsHideTimer = null, manageHideTimer = null;
  function openSettings() {
    clearTimeout(settingsHideTimer);
    renderSettings();
    $('view-settings').classList.remove('hidden');
    requestAnimationFrame(() => $('view-settings').classList.add('open'));
  }
  function closeSettings() {
    $('view-settings').classList.remove('open');
    clearTimeout(settingsHideTimer);
    settingsHideTimer = setTimeout(() => $('view-settings').classList.add('hidden'), 230);
    applyPrefs();
    renderLedger();
  }
  $('btn-settings').addEventListener('click', openSettings);
  $('set-close').addEventListener('click', closeSettings);

  function renderSettings() {
    let html = '<div class="set-group">偏 好</div>';
    PREFS.forEach(p => {
      const cur = Store.pref(p.key);
      html += '<div class="set-row"><span class="k">' + p.label + '</span><span class="chips">' +
        p.opts.map(o => '<button class="set-chip' +
          (String(o[0]) === String(cur) ? ' on' : '') +
          '" data-k="' + p.key + '" data-v="' + o[0] + '">' + o[1] + '</button>').join('') +
        '</span></div>';
    });
    html += '<div class="set-group">管 理</div>' +
      '<button class="set-link" id="set-manage">分类与支付方式<span class="arrow">›</span></button>' +
      '<button class="set-link" id="set-backup">备份与恢复<span class="arrow">›</span></button>' +
      '<div class="set-foot">小资记账 v' + APP_VERSION + ' · 数据只存在这台手机里<br>' +
      '卸载 App 会连数据一起删掉，记得把备份发到微信</div>';
    $('set-body').innerHTML = html;

    $('set-body').querySelectorAll('.set-chip').forEach(b => b.addEventListener('click', () => {
      const k = b.dataset.k, raw = b.dataset.v;
      const def = PREFS.filter(p => p.key === k)[0];
      Store.setPref(k, typeof def.opts[0][0] === 'number' ? Number(raw) : raw);
      // 用户一旦自己动过长辈模式，就记下来：以后 start_url 的 ?elder=1
      // 不能再覆盖他的选择（第三轮审查 🟠 B17）。
      if (k === 'elder') Store.setPref('elderChosen', '1');
      applyPrefs();
      renderSettings();
      renderStats();
      buzz();
    }));
    $('set-manage').addEventListener('click', () => { closeSettings(); setTimeout(openManage, 220); });
    // 必须调 openBackup（它内部会先刷新"账目条数 / 上次备份"再把弹窗显示出来）。
    // 原来这里只写了 classList.add('show')，于是从设置页进来永远是 HTML 里那句
    // 「0 笔 / 从未备份」的初值 —— 而备份过一次之后，设置页就是唯一的入口。
    $('set-backup').addEventListener('click', openBackup);
  }

  // 把偏好真正作用到界面上
  function applyPrefs() {
    // 外观
    const t = Store.pref('theme');
    let dark = (t === 'dark');
    if (t === 'auto' && window.matchMedia) {
      dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    }
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    document.documentElement.setAttribute('data-amt', Store.pref('amountColor'));
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', dark ? '#17150F' : '#FAF7F0');
    // 安卓状态栏图标跟着亮暗（深底上要浅色图标）
    const SB = isNative && window.Capacitor.Plugins.SystemBars;
    if (SB && SB.setStyle) {
      try {
        const p = SB.setStyle({ style: dark ? 'DARK' : 'LIGHT' });
        if (p && typeof p.catch === 'function') p.catch(function () {});
      } catch (e) {}
    }

    // 字号由「长辈模式」直接决定，不再有单独的字号设置项。
    // 原因：拆成两项时，关掉长辈模式字号不会跟着回去，用户得手动再调一次。
    // 现在三档就是三种完整状态：关闭 = 标准、大 = 1.25、特大 = 1.45。
    // 倍率是实测定的：1.3 倍在 390px 宽（iPhone 13）下不溢出，所以 1.45 仍有安全余量。
    // 'on' 是上一版预览包的取值，留作别名，免得装过预览包的数据掉回标准字号。
    const ELDER_SCALE = { off: 1, on: 1.25, big: 1.25, huge: 1.45 };
    const elder = Store.pref('elder');
    document.documentElement.style.setProperty('--fs', String(ELDER_SCALE[elder] || 1));

    // 长辈模式还要把「写死高度/列宽」的地方也放大 ——
    // 那些不会跟着 --fs 变（数字键盘 50px、保存按钮 48px、明细行的 50/94px 列宽）。
    document.documentElement.setAttribute('data-elder',
      (!elder || elder === 'off') ? '0' : '1');

    // 「记账天数」那行的显示开关跟着偏好走（设置页里切换时立刻生效）
    renderStreak();
  }

  // 「跟随系统」时要能实时响应系统的切换
  if (window.matchMedia) {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onSys = () => { if (Store.pref('theme') === 'auto') applyPrefs(); };
    if (mq.addEventListener) mq.addEventListener('change', onSys);
    else if (mq.addListener) mq.addListener(onSys);
  }

  /* ---------------------------------------------------------
     分类与支付方式管理
     --------------------------------------------------------- */
  let mgList = 'expenseCats';
  let actName = null;
  const LIST_NAME = { expenseCats: '支出分类', incomeCats: '收入分类', accounts: '支付方式' };

  function openManage() {
    clearTimeout(manageHideTimer);
    renderManage();
    $('view-manage').classList.remove('hidden');
    requestAnimationFrame(() => $('view-manage').classList.add('open'));
  }
  function closeManage() {
    $('view-manage').classList.remove('open');
    clearTimeout(manageHideTimer);
    manageHideTimer = setTimeout(() => $('view-manage').classList.add('hidden'), 230);
    renderLedger();
  }
  $('mg-close').addEventListener('click', closeManage);

  document.querySelectorAll('#mg-seg button').forEach(b => b.addEventListener('click', () => {
    mgList = b.dataset.list;
    document.querySelectorAll('#mg-seg button').forEach(x => x.classList.toggle('on', x === b));
    renderManage();
  }));

  function renderManage() {
    const list = Store.listOf(mgList);
    let html = list.map(name => {
      const n = Store.usageOf(mgList, name);
      return '<button class="mgr-row" data-name="' + esc(name) + '">' +
        '<span class="nm">' + esc(name) + '</span>' +
        '<span class="use">' + (n ? n + ' 笔' : '未用过') + '</span>' +
        '<span class="arrow">›</span></button>';
    }).join('');
    html += '<div class="mgr-hint">点一项可以改名字、调顺序或删除。<br>' +
      '这里的顺序就是记账时格子里显示的顺序。</div>';
    $('mg-list').innerHTML = html;
    $('mg-list').querySelectorAll('.mgr-row').forEach(el =>
      el.addEventListener('click', () => openActions(el.dataset.name)));
  }

  function openActions(name) {
    actName = name;
    const n = Store.usageOf(mgList, name);
    $('mg-title').textContent = name;
    $('mg-usage').textContent = n ? n + ' 笔' : '还没有用过';
    $('mg-actions').classList.add('show');
  }
  $('mg-act-cancel').addEventListener('click', () => $('mg-actions').classList.remove('show'));

  $('mg-rename').addEventListener('click', () => {
    const old = actName;
    $('mg-actions').classList.remove('show');
    inputBox('把「' + old + '」改成', old, v => {
      const r = Store.renameEntry(mgList, old, v);
      if (!r.ok) return r.why;
      renderManage();
      toast(r.changed ? '已改名，' + r.changed + ' 笔记录也一起改了' : '已改名', 2600);
      return null;
    });
  });

  $('mg-up').addEventListener('click', () => {
    $('mg-actions').classList.remove('show');
    if (!Store.moveEntry(mgList, actName, -1).ok) toast('已经在最前面了');
    renderManage();
  });
  $('mg-down').addEventListener('click', () => {
    $('mg-actions').classList.remove('show');
    if (!Store.moveEntry(mgList, actName, 1).ok) toast('已经在最后面了');
    renderManage();
  });

  $('mg-del').addEventListener('click', () => {
    const name = actName;
    // 只剩一项时 removeEntry 会拒绝，但弹窗里"接管列表"是空的 ——
    // 用户只会看到一片空白，不知道该干嘛（第三轮审查 🟡 C19）。
    if (Store.listOf(mgList).length <= 1) {
      $('mg-actions').classList.remove('show');
      toast('至少要留一项，不能全删完');
      return;
    }
    $('mg-actions').classList.remove('show');
    const used = Store.usageOf(mgList, name);

    if (used === 0) {
      confirmBox('删除「' + name + '」？', '这一项还没有被任何记录用过，删除不影响账目。', '删除', () => {
        const r = Store.removeEntry(mgList, name);
        if (!r.ok) { toast(r.why); return; }
        renderManage(); toast('已删除');
      });
      return;
    }

    // 有记录在用：不能直接删，否则那些账目会指向一个不存在的分类
    const others = Store.listOf(mgList).filter(x => x !== name);
    $('rs-text').innerHTML = '「' + esc(name) + '」下面有 <b>' + used +
      '</b> 笔记录。<br>删除后，这些记录会改到你下面选的那一类。';
    $('rs-list').innerHTML = others.map(x => {
      const n = Store.usageOf(mgList, x);
      return '<button class="rs-item" data-pick="' + esc(x) + '">' + esc(x) +
        (n ? '<span class="use">' + n + ' 笔</span>' : '') + '</button>';
    }).join('');
    $('reassign-modal').classList.add('show');
    $('rs-list').querySelectorAll('.rs-item').forEach(el => el.addEventListener('click', () => {
      const pick = el.dataset.pick;
      $('reassign-modal').classList.remove('show');
      const r = Store.removeEntry(mgList, name, pick);
      if (!r.ok) { toast(r.why); return; }
      renderManage();
      toast('已删除，' + r.moved + ' 笔记录改到了「' + pick + '」', 3000);
    }));
  });
  $('rs-cancel').addEventListener('click', () => $('reassign-modal').classList.remove('show'));

  $('mg-add').addEventListener('click', () => {
    inputBox('新建' + LIST_NAME[mgList], '', v => {
      const r = Store.addEntry(mgList, v);
      if (!r.ok) return r.why;
      renderManage();
      toast('已新建');
      return null;
    });
  });

  // 通用确认框
  let cfAction = null;
  function confirmBox(title, text, okText, action) {
    $('cf-title').textContent = title;
    // textContent 而不是 innerHTML：调用方传的都是纯文本，没有理由留一个
    // 能把字符串当 HTML 解释的入口（第三轮审查 🟡 C40）。
    $('cf-text').textContent = text;
    $('cf-ok').textContent = okText || '确定';
    cfAction = action;
    $('confirm-modal').classList.add('show');
  }
  $('cf-ok').addEventListener('click', () => {
    $('confirm-modal').classList.remove('show');
    if (cfAction) { const f = cfAction; cfAction = null; f(); }
  });
  $('cf-cancel').addEventListener('click', () => {
    $('confirm-modal').classList.remove('show'); cfAction = null;
  });

  // 通用输入框。
  // 不用浏览器自带的 prompt()：它在安卓 WebView 里渲染坏了
  // （只显示标题、没有输入框、没有按钮），实测在小米 13 上完全没法用。
  let inAction = null;
  function inputBox(title, value, onOk) {
    $('in-title').textContent = title;
    $('in-field').value = value || '';
    $('in-err').textContent = '';
    inAction = onOk;
    $('input-modal').classList.add('show');
    setTimeout(() => {
      const f = $('in-field');
      try { f.focus(); f.setSelectionRange(0, f.value.length); } catch (e) { f.focus(); }
    }, 80);
  }
  function closeInput() {
    $('input-modal').classList.remove('show');
    $('in-field').blur();
    inAction = null;
  }
  // onOk 返回字符串 = 出错，保持弹窗打开并显示原因；返回 null = 成功关闭
  function submitInput() {
    if (!inAction) { closeInput(); return; }
    const msg = inAction($('in-field').value);
    if (msg) { $('in-err').textContent = msg; return; }
    closeInput();
  }
  $('in-ok').addEventListener('click', submitInput);
  $('in-cancel').addEventListener('click', closeInput);
  $('in-field').addEventListener('input', () => { $('in-err').textContent = ''; });
  $('in-field').addEventListener('keydown', e => { if (e.key === 'Enter') submitInput(); });

  /* ---------------------------------------------------------
     开发用：造一批示例数据（只在地址栏带 ?demo=1 且账本为空时生效）
     用途：图表要有数据才看得出对不对。App 里没有地址栏，所以碰不到这段。
     --------------------------------------------------------- */
  function seedDemo() {
    const cats = ['餐饮', '交通', '购物', '居住', '娱乐', '医疗', '人情', '学习'];
    const notes = ['午饭', '地铁', '超市采购', '咖啡', '打车', '外卖', '水果', '电影票', '话费'];
    const accts = ['微信', '支付宝', '现金', '银行卡'];
    const pick = a => a[Math.floor(Math.random() * a.length)];
    const today = new Date();
    let n = 0;
    for (let back = 2; back >= 0; back--) {
      const d = new Date(today.getFullYear(), today.getMonth() - back, 1);
      const year = d.getFullYear(), mon = d.getMonth();
      const days = new Date(year, mon + 1, 0).getDate();
      for (let day = 1; day <= days; day++) {
        if (back === 0 && day > today.getDate()) break;
        if (Math.random() < 0.3) continue;                 // 约三成的日子留白，正好看日历缺口
        const k = 1 + Math.floor(Math.random() * 3);
        for (let j = 0; j < k; j++) {
          const cat = pick(cats);
          const amount = cat === '居住' ? 220000 : (500 + Math.floor(Math.random() * 18000));
          Store.add({
            amount: amount, cat: cat, account: pick(accts), note: pick(notes),
            date: year + '-' + String(mon + 1).padStart(2, '0') + '-' + String(day).padStart(2, '0'),
            time: String(7 + Math.floor(Math.random() * 14)).padStart(2, '0') + ':' +
                  String(Math.floor(Math.random() * 60)).padStart(2, '0')
          });
          n++;
        }
      }
    }
    // 一个月一笔工资，让「结余」有东西可算
    for (let back = 2; back >= 0; back--) {
      const d = new Date(today.getFullYear(), today.getMonth() - back, 10);
      if (back === 0 && d.getDate() > today.getDate()) break;
      Store.add({
        amount: 1280000, cat: '工资', type: 'income', account: '银行卡', note: '月薪',
        date: Store.todayStr(d), time: '09:00'
      });
      n++;
    }
    return n;
  }

  /* ---------------------------------------------------------
     开发用：量宽度（地址栏带 ?probe=1）
     排查横向溢出用：把关键元素的真实宽度打出来，别靠肉眼估。
     App 里没有地址栏，碰不到这段。
     --------------------------------------------------------- */
  function runProbe() {
    // 用 async 是为了等 service worker 注册完再报告状态
    setTimeout(async () => {
      const w = sel => {
        const el = typeof sel === 'string' ? document.querySelector(sel) : sel;
        if (!el) return 'n/a';
        const r = el.getBoundingClientRect();
        return Math.round(r.width) + 'px' + (el.scrollWidth > Math.ceil(r.width) ? ' (内容 ' + el.scrollWidth + 'px)' : '');
      };
      const lines = [
        'innerWidth        = ' + window.innerWidth,
        '--fs              = ' + (getComputedStyle(document.documentElement)
          .getPropertyValue('--fs').trim() || '(未设置)'),
        '--cur (停在第几页) = ' + (getComputedStyle(document.documentElement)
          .getPropertyValue('--cur').trim() || '(未设置)'),
        'data-elder        = ' + (document.documentElement.getAttribute('data-elder') || '(未设置)'),
        'doc.clientWidth   = ' + document.documentElement.clientWidth,
        'body.scrollWidth  = ' + document.body.scrollWidth,
        'doc.scrollWidth   = ' + document.documentElement.scrollWidth,
        '--',
        '.view-stats       = ' + w('#view-stats'),
        '.stats-scroll     = ' + w('#stats-scroll'),
        '.sec-head         = ' + w('.sec-head'),
        '.sec-head .hint   = ' + w('.sec-head .hint'),
        '.cal              = ' + w('.cal'),
        '.cal-cell         = ' + w('.cal-cell'),
        '.bar              = ' + w('.bar'),
        '.cat-row          = ' + w('.cat-row'),
        '.cat-row .nm      = ' + w('.cat-row .nm'),
        '.cat-row .amt     = ' + w('.cat-row .amt'),
        '.trend            = ' + w('.trend'),
        '.tcol             = ' + w('.tcol'),
        '-- 右边缘超出视口的元素（全页面）--'
      ];
      // 原来这里只扫 #stats-scroll，但「窄屏被切掉右边」不一定发生在统计页。
      // 改成扫全页面：任何一个元素把 body 撑宽，.view 的 inset:0 就会跟着变宽，
      // 于是 space-between 那一类的右对齐元素全被推出视口 —— 从截图上看就是「右边被切了」。
      // headless 的虚拟时间不推进 CSS 过渡，直接读 transform 会读到动画**起点**
      // 的中间值（看着像位移算错了）。读之前先把过渡关掉，让三页立刻归位。
      TAB_ORDER.forEach(n => { $('view-' + n).style.transition = 'none'; });
      void document.body.offsetWidth;

      // ⚠️ 三个主标签页是横向并排的（切页要滑过去），所以「不在原位」的页面天生
      // 就在视口外 —— 那是设计如此，不是「页面被撑宽了」。整棵子树跳过。
      // 按位置判断而不是按 .on：动画进行中，当前页也可能还没归位。
      const offPages = Array.prototype.slice.call(
        document.querySelectorAll('.view.tabpage')).filter(p =>
          Math.abs(p.getBoundingClientRect().left) > 0.5);
      const bad = [];
      document.querySelectorAll('body *').forEach(el => {
        if (el.id === 'probe') return;
        if (offPages.some(p => p.contains(el))) return;
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return;      // 彻底不渲染的跳过
        if (r.right > window.innerWidth + 0.5) {
          bad.push('  ' + el.tagName.toLowerCase() +
            (el.id ? '#' + el.id : '') +
            (el.className && typeof el.className === 'string' && el.className
              ? '.' + el.className.split(' ')[0] : '') +
            '  右 ' + Math.round(r.right) + '  宽 ' + Math.round(r.width));
        }
      });
      lines.push(bad.length ? bad.slice(0, 40).join('\n') : '  （没有，页面没被撑宽）');
      if (bad.length > 40) lines.push('  …还有 ' + (bad.length - 40) + ' 条');

      // 三个主标签页是横向并排的，所以 documentElement 的 scrollWidth 天生就是
      // 视口的三倍 —— 那本身正常（另外两页本来就该在屏幕外）。真正要确认的是
      // **视口会不会被横向滚走**（那会让两页拼在一起显示，看着就是界面坏了）。
      // 注意 scrollTo 测的是「程序化滚动」：overflow:hidden 挡不住它，只有
      // overflow:clip 能。所以两个值一起报，别把 hidden 当成修好了。
      const sx0 = window.scrollX;
      window.scrollTo(200, 0);
      const sx1 = window.scrollX;
      window.scrollTo(sx0, 0);
      const ovx = getComputedStyle(document.documentElement).overflowX;
      lines.push('-- 横向会不会被滚走 --');
      lines.push('  html overflow-x    = ' + ovx);
      lines.push('  scrollTo(200) 之后 = ' + sx1 +
        (sx1 === 0 ? '   （彻底滚不动，正确）'
          : (ovx === 'hidden' ? '   （程序化能滚；手势被 hidden 挡住，但没到 clip）'
            : '   ⚠️ 没挡住，得修')));

      // 三个主标签页的位移和可见性。
      // 动画本身在静态截图里看不见，但「谁在第几位、谁可见」是可以量的 ——
      // 位移算错（比如 --page 写反）时，这里一眼就能看出来。
      lines.push('-- 三个主标签页 --');
      TAB_ORDER.forEach(n => {
        const el = $('view-' + n);
        const cs = getComputedStyle(el);
        lines.push('  ' + (n + '      ').slice(0, 7) +
          ' transform=' + cs.transform + '  visibility=' + cs.visibility);
      });

      // PWA 状态：service worker 只在浏览器里才有，原生 App 里不该注册。
      // 在电脑上验 PWA 时，这几行就是「装得上装不上」的直接证据。
      lines.push('-- PWA --');
      if ('serviceWorker' in navigator) {
        try {
          const regs = await navigator.serviceWorker.getRegistrations();
          lines.push('  SW 注册数        = ' + regs.length +
            (regs[0] ? '   scope=' + regs[0].scope : ''));
          lines.push('  当前是否被 SW 接管 = ' +
            (navigator.serviceWorker.controller ? '是' : '否（首次加载这样是正常的）'));
        } catch (e) {
          lines.push('  SW 查询失败      = ' + e.message);
        }
      } else {
        lines.push('  serviceWorker    = 不支持');
      }
      const mf = document.querySelector('link[rel="manifest"]');
      lines.push('  manifest link    = ' + (mf ? mf.getAttribute('href') : '（没有！）'));
      const ati = document.querySelector('link[rel="apple-touch-icon"]');
      lines.push('  apple-touch-icon = ' + (ati ? ati.getAttribute('href') : '（没有！）'));

      document.body.innerHTML = '<pre id="probe" style="font:11px/1.6 monospace;' +
        'white-space:pre-wrap;word-break:break-all;padding:8px;background:#fff;color:#000">' +
        lines.join('\n') + '</pre>';
    }, 1200);
  }

  /* ---------------------------------------------------------
     启动
     --------------------------------------------------------- */
  (async function boot() {
    // 调试参数只在「本机地址」或显式 ?debug=1 时生效。
    // 以前 PWA 也能用：一个带 ?theme=dark 的链接会把妈妈的界面永久改深色，
    // ?demo=1 甚至会往空账本里写 99 条假账（第三轮审查 🟡 C37）。
    const DEBUG = (function () {
      try {
        return location.hostname === '127.0.0.1' || location.hostname === 'localhost' ||
          /[?&]debug=1/.test(location.search);
      } catch (e) { return false; }
    })();
    // 调试用：?w=390 把页面宽度钉死成 390px，用来在电脑上预览窄屏（iPhone 13 是 390）。
    // 为什么非要有这个开关：Chrome headless 在 Windows 上有最小窗口宽度（实测 491px），
    // --window-size=390 拿到的视口其实是 491 —— 页面按 491 排版，截图却只有 390 宽，
    // 右边被裁掉，看着像「页面横向溢出」，其实是量错了。
    // 钉住宽度之后，flex/grid 都会按 390 排，看到的才是真窄屏效果。
    // （副作用：position:fixed 的元素仍按真实视口定位，所以它验证不了 .undo / .toast 的位置。）
    const wm = DEBUG ? location.search.match(/[?&]w=(\d{3,4})/) : null;
    if (wm) {
      const w = Number(wm[1]);
      document.documentElement.style.width = w + 'px';
      document.documentElement.style.margin = '0 auto';
      document.body.style.width = w + 'px';
      // 必须给 body 定位：.view 是 position:absolute;inset:0，
      // 不给 body 定位的话它的包含块是视口（还是 491），钉宽度就白钉了。
      document.body.style.position = 'relative';
      document.body.style.overflowX = 'hidden';
    }

    // 调试用：?safe=47,34 模拟 iPhone 刘海屏的安全区（顶部,底部）。
    // 为什么必须有：PWA 里没有 Capacitor 的 SystemBars 注入 --safe-area-inset-*，
    // 靠的是 env() 回退值；而电脑浏览器里 env() 恒为 0 ——
    // 不模拟的话，在电脑上看到的顶部留白永远是错的（真机会被状态栏压住）。
    // iPhone 13 实测值约 47 / 34。
    const sm = DEBUG ? location.search.match(/[?&]safe=(\d{1,3}),(\d{1,3})/) : null;
    if (sm) {
      document.documentElement.style.setProperty('--safe-area-inset-top', sm[1] + 'px');
      document.documentElement.style.setProperty('--safe-area-inset-bottom', sm[2] + 'px');
    }

    // 开机自检：界面元素对不上就当场说出来，别让按钮点了没反应
    const need = ['view-ledger', 'view-stats', 'view-entry', 'btn-month', 'mo-label',
      'mopick', 'mo-prev', 'mo-next', 'mo-today', 'mo-done', 'total', 'sum-income', 'sum-net',
      'delta', 'streakline', 'breakdown', 'bar', 'legend', 'btn-add', 'list', 'stats-scroll',
      'st-seg', 'st-prev', 'st-next', 'st-label',
      'seg', 'entry-title', 'expr', 'amount', 'cat-grid', 'date-chips', 'chip-cal',
      'dp-grid', 'dp-label', 'dp-prev', 'dp-next', 'dp-cancel', 'date-modal',
      'acct-chips', 'note', 'pad', 'btn-save', 'btn-save-top', 'btn-cancel', 'btn-delete',
      'undo', 'undo-text', 'undo-btn', 'toast',
      'btn-settings', 'view-settings', 'set-body', 'set-close', 'backup-hint', 'backup-modal', 'bk-count', 'bk-when',      'bk-export', 'bk-csv', 'bk-import', 'bk-mark', 'bk-close', 'import-file',
      'view-manage', 'mg-close', 'mg-seg', 'mg-list', 'mg-add',
      'mg-actions', 'mg-title', 'mg-usage', 'mg-rename', 'mg-up', 'mg-down', 'mg-del',
      'mg-act-cancel', 'reassign-modal', 'rs-text', 'rs-list', 'rs-cancel',
      'confirm-modal', 'cf-title', 'cf-text', 'cf-ok', 'cf-cancel',
      'input-modal', 'in-title', 'in-field', 'in-err', 'in-ok', 'in-cancel',
      'view-search', 'sr-q', 'sr-toggle', 'sr-panel', 'sr-active', 'sr-reset',      'sr-time', 'sr-dates', 'sr-from', 'sr-to', 'sr-type', 'sr-cat', 'sr-amt',
      'sr-sum', 'sr-results', 'sr-pay'];
    const missing = need.filter(id => !document.getElementById(id));
    if (missing.length) {
      // 不用 alert()：和 prompt() 同类，在安卓 WebView 里的行为不由我们控制。
      // 改成往页面上写一条显眼的错误条，保证一定看得见。
      console.error('界面元素缺失：' + missing.join('、'));
      const bar = document.createElement('div');
      bar.style.cssText = 'position:fixed;left:0;right:0;top:0;z-index:300;background:#A8342A;' +
        'color:#fff;font-size:12px;padding:8px 12px;text-align:center;line-height:1.6';
      bar.textContent = '界面元素缺失，请截图告诉开发者：' + missing.join('、');
      document.body.appendChild(bar);
    }

    const r = await Store.init();
    if (!r.ok) {
      // 数据读不出来：**不要往下走**。db 还是 null，applyPrefs 会抛 TypeError，
      // 把 init 精心写的那段中文说明淹没成一条 JS 错误、页面只剩骨架（🟠 B2）。
      showFatal(r.warn || '数据文件读不出来，请重启 App 再试。');
      return;
    }
    if (readyResolve) readyResolve();   // 放行「用其他应用打开」那条导入路径（它要等 init 完成）

    // 长辈模式：妈妈那份 PWA 的 start_url 带 ?elder=1。
    // 用户**自己动过**长辈模式（elderChosen）之前，这个参数一直有效 ——
    // iOS 的常规路径是「Safari 先打开看看 → 再添加到主屏幕」，那时账本已经建好，
    // 只认 source==='new' 就永远套不上（第三轮审查 🟠 B17）。
    if (location.search.indexOf('elder=1') >= 0 && Store.pref('elderChosen') !== '1') {
      Store.setPref('elder', 'big');
    }
    // 调试用：?elder=off|big|huge 直接指定档位（只在本机调试地址生效）
    const em = DEBUG ? location.search.match(/elder=(off|big|huge|on)/) : null;
    if (em) { Store.setPref('elder', em[1]); Store.setPref('elderChosen', '1'); }

    // 构成维度的口味偏好在这里恢复（db 已就绪）：切过「按支付方式」就记住
    if (Store.pref('bdDim') === 'pay') stBd = 'pay';

    // 偏好要在第一次渲染之前生效，否则打开时会闪一下浅色
    applyPrefs();
    if (DEBUG && location.search.indexOf('theme=dark') >= 0) {
      // 调试用：只改这一回合的 DOM，不写偏好（以前会永久写进数据）
      document.documentElement.setAttribute('data-theme', 'dark');
    }
    if (DEBUG && location.search.indexOf('demo=1') >= 0 && Store.all().length === 0) {
      const n = seedDemo();
      await Store.flush();
      console.log('已生成 ' + n + ' 条示例数据');
    }
    $('btn-month').textContent = monthLabel(month);
    // 三个主标签页的定位变量先落到初始状态（记账页 = 第 0 页）。
    setCur(TAB_ORDER.indexOf(curTab));
    renderLedger();
    renderStats();
    // 调试用：?period=week|year 指定周期，?kind=income 看收入占比
    const pm = DEBUG ? location.search.match(/period=(week|month|year)/) : null;
    if (pm) { stPeriod = pm[1]; syncSeg(); }
    if (DEBUG && location.search.indexOf('kind=income') >= 0) stKind = 'income';
    // 调试用：?bd=pay 直接看「按支付方式」构成（只改内存态，不写偏好）
    if (DEBUG && location.search.indexOf('bd=pay') >= 0) stBd = 'pay';
    // 方便调试/截图：地址栏加 #stats 进统计页，加 #search 进搜索页，加 #manage 进分类管理
    // （用 NoAnim 版：这几个都是「开机就停在这一页」，不该播切页动画）
    if (location.hash === '#stats') switchTabNoAnim('stats');
    if (location.hash === '#search') switchTabNoAnim('search');
    if (location.hash === '#manage') openManage();
    if (location.hash === '#settings') openSettings();
    // 录入页也要能直接打开 —— 它是记账的核心页面，
    // 而数字键盘的高度是长辈模式重点调整的地方，截图时必须看得到。
    if (location.hash === '#entry') openEntry(null);
    if (location.hash === '#datepick') { openEntry(null); setTimeout(openDatePicker, 400); }
    // 没指定 hash 时，按偏好决定停在哪个标签
    if (!location.hash) {
      const dt = Store.pref('defaultTab');
      if (dt && dt !== 'ledger') switchTabNoAnim(dt);
    }
    // Service Worker：只在浏览器 / PWA 里注册。
    // 原生 App（Capacitor）里**不能**注册 —— 它会把 index.html 缓存住，
    // 导致 App 更新之后界面还是旧的，而且很难排查（界面看着一切正常，就是不更新）。
    // file:// 下浏览器本来也不允许注册（本地双击打开调试时用不到）。
    // 注册失败不影响任何功能，最坏的结果只是「没网时打不开」。
    if (!isNative && 'serviceWorker' in navigator && location.protocol !== 'file:') {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js').catch(() => {});
      });
    }

    if (DEBUG && location.search.indexOf('probe=1') >= 0) runProbe();
    // 文件损坏是有分量的事，不能只给一句 3 秒的浮层：
    //   backup  = 主文件读不出来，从备份恢复了 → 可能已经丢了一部分记录
    //   rebuilt = 两个都坏，账本被重建成空的 → 看起来就是"数据全没了"
    //   newer   = 数据来自更新版本的 App，只读打开（不覆盖）
    // 这些都需要你立刻知道，并且知道坏文件叫什么名字、下一步该干什么。
    if (r.source === 'newer') {
      showFatal(r.warn);
    } else if (r.source === 'backup' || r.source === 'rebuilt') {
      // 只有真的写了留档才说「另存了」—— 主文件「不存在」而从 .bak 恢复那条路
      // 没有坏文件可留，以前的文案在这里是假的（第三轮审查 🟡 C13）。
      const kept = r.corruptFile ? ' 坏文件另存成了 xiaozi-data.corrupt-<时间戳>.json。' : '';
      showFatal((r.source === 'backup'
        ? '主文件读不出来，已从备份恢复 —— 可能丢了一部分记录。'
        : '数据文件损坏，账本已被重建成空的 —— 先别再记账。') +
        kept +
        (r.source === 'backup'
          ? '建议先导出当前数据，再核对最近几天的记录。（点这条可关掉）'
          : '去「设置 → 备份与恢复」把最近的备份导进来。（点这条可关掉）'));
    } else if (r.warn) {
      toast(r.warn, 3200);
    }

    // PWA 多标签页：另一个标签写了盘，这一份就过期了。
    // 没有合并机制，至少提示刷新 —— 总比静默丢一笔好（第三轮审查 🟠 B13）。
    window.addEventListener('xiaozi:external-change', function () {
      toast('另一个窗口更新了账本，请刷新页面后再操作', 5000);
    });
    if (!isNative) {
      // 电脑浏览器里调试：顶部挂个提示条，避免把调试数据当成真数据
      const b = document.createElement('div');
      b.textContent = '浏览器调试模式（数据存在浏览器里，不进手机）';
      b.style.cssText = 'position:fixed;bottom:0;left:0;right:0;background:#23201B;color:#FAF7F0;' +
        'font-size:10px;text-align:center;padding:3px;z-index:99;letter-spacing:.05em';
      document.body.appendChild(b);
    }
  })();
})();
