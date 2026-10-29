/* ===========================================================================
 * 面试专家 · 定制生成（纯静态版）
 * ---------------------------------------------------------------------------
 * 用在 GitHub Pages 这种没有后端的地方：直接在浏览器里调模型。
 *   · 浏览器直连大模型 api.deepseek.com 会被 CORS 拦 → 走公共 CORS 代理
 *   · API Key 不写明文 → 读 config.enc.js 的密文，用固定种子派生密钥解出来，只在内存里用
 *   · 画像存 localStorage，不上传任何服务器（除了发给模型本身）
 *
 * 和服务器版的差别：没有画像数据库、没有跨设备缓存、没有历史记录。
 * 换来的是：打开网页就能改、就能出稿，不依赖沙箱是否醒着。
 * =========================================================================== */
(function () {
  'use strict';

  var K = 'linziyang-ivp-2026-10-29-v1';
  var PROXY = [
    'https://corsproxy.io/?',
    'https://api.allorigins.win/raw?url='
  ];
  var LS_PROFILE = 'ivpStaticProfile';
  var LS_ITEMS = 'ivpStaticItems';

  /* ---------------- 配置解密 ---------------- */
  var CFG = null;
  function b64d(s) {
    s = s.replace(/-/g, '+').replace(/_/g, '/');
    var pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : '';
    var bin = atob(s + pad);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /** 用种子派生 AES-CBC 密钥（复刻 Python Fernet 的取法：SHA256(seed) → base64url） */
  async function decodeCfg() {
    if (CFG) return CFG;
    var token = window.IVP_CFG;
    if (!token) throw new Error('缺少 config.enc.js，先跑 build_secure_config.py 并上传');

    var seedBuf = new TextEncoder().encode(K);
    var hash = await crypto.subtle.digest('SHA-256', seedBuf);
    var rawKey = new Uint8Array(hash);                    // Fernet 的签名密钥
    var encKey = rawKey.slice(16, 32);                    // 后 16 字节就是 AES key
    var mac = rawKey.slice(0, 16);

    var blob = b64d(token);                               // version(1)+ts(8)+iv(16)+ct+hmac(32)
    var iv = blob.slice(9, 25);
    var ct = blob.slice(25, blob.length - 32);

    var key = await crypto.subtle.importKey('raw', encKey, { name: 'AES-CBC' }, false, ['decrypt']);
    var plain = await crypto.subtle.decrypt({ name: 'AES-CBC', iv: iv }, key, ct);
    CFG = JSON.parse(new TextDecoder().decode(plain));
    return CFG;
  }

  /* ---------------- 模型调用 ----------------
   * 实测 api.deepseek.com 自己就回 CORS 头（allow-origin 回显 + 预检放行 authorization），
   * 所以优先直连：不经过任何第三方，Key 不落到别人服务器上，也快。
   * 直连失败（公司网络/浏览器插件拦）再退到公共代理。 */
  async function chat(messages, opt) {
    opt = opt || {};
    var cfg = await decodeCfg();
    var endpoint = cfg.base_url.replace(/\/+$/, '') + '/chat/completions';
    var body = {
      model: cfg.model,
      messages: messages,
      temperature: opt.temp == null ? 0.6 : opt.temp,
      max_tokens: opt.max || 1800,
      stream: false
    };
    // deepseek-flash 默认会先"思考"，长 prompt 下思考token能把 max_tokens 吃光，
    // 导致 content 为空或 JSON 半截。这类"照简历改写"的活不需要思考，直接关掉。
    if (/flash/.test(cfg.model)) body.thinking = { type: 'disabled' };
    var targets = [endpoint];                       // ① 直连
    PROXY.forEach(function (p) { targets.push(p + encodeURIComponent(endpoint)); });  // ② 代理兜底

    var errs = [];
    for (var i = 0; i < targets.length; i++) {
      try {
        var r = await fetch(targets[i], {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + cfg.api_key
          },
          body: JSON.stringify(body)
        });
        if (!r.ok) {
          var detail = '';
          try { detail = (await r.text()).slice(0, 120); } catch (e2) {}
          errs.push('HTTP ' + r.status + (detail ? ' ' + detail : ''));
          continue;
        }
        var j = await r.json();
        var c = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
        if (c) return c;
        errs.push('空内容');
      } catch (e) { errs.push(e.message || '网络错误'); }
    }
    throw new Error('模型调用失败（' + errs.join(' / ') + '）');
  }

  function parseJson(raw) {
    if (!raw) return null;
    var s = raw.replace(/```(json)?/g, '').trim();
    var a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a >= 0 && b > a) s = s.slice(a, b + 1);
    try { return JSON.parse(s); } catch (e) { return null; }
  }

  /* ---------------- 画像 & 缺口（纯前端算，不花 token） ---------------- */
  function splitLines(t) {
    return (t || '').split('\n').map(function (x) { return x.trim().replace(/^[·•\-—\t]+/, ''); })
      .filter(Boolean);
  }

  /** ① 本地即时判定：不联网，改一个字就重算（只管数字够不够、行长不长、关键词字面在不在） */
  function localGap(p, points, alias) {
    var flat = (p.resume || '').replace(/\s+/g, '').toLowerCase();
    var has = function (w) {
      w = String(w).replace(/\s+/g, '').toLowerCase();
      if (!w) return false;
      if (flat.indexOf(w) >= 0) return true;
      var grams = [], n = Math.max(1, w.length - 1);
      for (var i = 0; i < n; i++) grams.push(w.slice(i, i + 2));
      var sc = grams.filter(function (g) { return flat.indexOf(g) >= 0; }).length / grams.length;
      return sc >= 0.5;
    };
    var hit = [], miss = [];
    (points || []).forEach(function (k) {
      k = String(k).replace(/\s+/g, '');
      if (!k) return;
      var as = (alias && alias[k]) || [];
      if (has(k) || as.some(has)) hit.push({ k: k, ev: '' }); else miss.push(k);
    });
    var qty = ((p.resume || '').match(/\d+(?:\.\d+)?%|\d{2,}/g) || []).length;
    var lines = splitLines(p.resume);
    var probs = [];
    if (qty < 3) probs.push('简历里只有 ' + qty + ' 处数字，现场容易被追问「具体多少」');
    if (lines.length > 14) probs.push('简历要点 ' + lines.length + ' 行，太长，60 秒讲不完；压到 6~8 行');
    if (!p.jd) probs.push('还没填 JD，缺口算不出来');
    return { hit: hit, miss: miss, numbers: qty, lines: lines.length, problems: probs, local: true };
  }

  /** ② 模型判定：字面匹配太笨（"覆盖率79.6%"其实证明了"数据分析"），
   *  让模型看一遍简历，给每个能力项找原文证据；找不到才判缺。 */
  async function judgeGap(p, points) {
    if (!points.length || !p.resume) return false;
    var ask = '判断这份简历有没有覆盖 JD 要求的能力项。\n\n' +
      '【JD 能力项】' + points.join('、') + '\n\n' +
      '【简历原文】\n' + (p.resume || '').slice(0, 1500) + '\n\n' +
      '规则：\n' +
      '1) 找到"等价证据"就算覆盖，不要求用同一个词（例：简历写"覆盖率79.6%"，可算覆盖"数据分析"）；\n' +
      '2) 证据必须是简历原文里的片段，8~14 字，照抄，不许编造；\n' +
      '3) 找不到就放进 miss，不许为了好看硬凑；\n' +
      '4) 只能从上面能力项里选，不要新增。\n' +
      '只输出 JSON：{"hit":[{"k":"数据分析","ev":"覆盖率79.6%"}],"miss":["RAG"]}';
    var raw = await chat([{ role: 'system', content: '只输出 JSON，不要解释。' }, { role: 'user', content: ask }],
      { temp: 0.1, max: 600 });
    var j = parseJson(raw);
    if (!j) return false;
    var set = {}; points.forEach(function (k) { set[k] = 1; });
    var hit = [], seen = {};
    (j.hit || []).forEach(function (x) {
      var k = String(typeof x === 'string' ? x : (x.k || '')).replace(/\s+/g, '');
      if (!set[k] || seen[k]) return;
      seen[k] = 1;
      hit.push({ k: k, ev: String((x && x.ev) || '').replace(/\s+/g, '').slice(0, 16) });
    });
    var miss = (j.miss || []).map(function (x) { return String(x).replace(/\s+/g, ''); })
      .filter(function (k) { return set[k] && !seen[k]; });
    points.forEach(function (k) { if (!seen[k] && miss.indexOf(k) < 0) miss.push(k); });
    ST.judge = { key: judgeKey(p), hit: hit, miss: miss };
    saveLocal(); paintGap();
    return true;
  }

  function judgeKey(p) { return hashStr((p.jd || '') + '||' + (p.resume || '')); }

  /** 没有模型时的关键词兜底：从 JD 里挖能力词 */
  var STOP = /^(负责|参与|协助|要求|熟悉|具备|良好|优先|相关|工作|进行|完成|支持|推动|能力|经验|以上|有关)$/;
  function fallbackPoints(jd) {
    var out = [], seen = {};
    (jd || '').split(/[，,。；;、/\n]/).forEach(function (seg) {
      seg.split(/与|和|及/).forEach(function (w) {
        w = w.replace(/^(负责|要求|熟悉|具备|有|能|会|了解|掌握)+/, '')
             .replace(/(者优先|优先|能力|经验|相关)$/, '').replace(/\s+/g, '').trim();
        if (w.length >= 2 && w.length <= 6 && !STOP.test(w) && !seen[w]) { seen[w] = 1; out.push(w); }
      });
    });
    return out.slice(0, 6);
  }

  /* ---------------- DOM ---------------- */
  var $ = function (s) { return document.querySelector(s); };
  var FIELD_MAP = { cCompany: 'company', cRole: 'role', cScale: 'scale', cName: 'name', cSchool: 'school', cJd: 'jd', cResume: 'resume' };

  function readForm() {
    var p = {};
    Object.keys(FIELD_MAP).forEach(function (id) { p[FIELD_MAP[id]] = ($('#' + id) || {}).value || ''; });
    return p;
  }
  function writeForm(p) {
    Object.keys(FIELD_MAP).forEach(function (id) {
      var el = $('#' + id);
      if (el && p[FIELD_MAP[id]]) el.value = p[FIELD_MAP[id]];
    });
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /* ---------------- 状态 ---------------- */
  var ST = {
    points: [],           // 当前 JD 关键词
    alias: {},            // 每个关键词的"简历里可能怎么写"证据词
    judge: null,          // {key, hit:[{k,ev}], miss:[]} 模型看简历后的判定
    pointsFor: '',        // 这批关键词对应哪段 JD（hash），变了才重新提炼
    gap: null,
    items: [],            // 已生成的稿件
    dirty: false,
    saveTimer: null,
    busy: false
  };

  function loadLocal() {
    try {
      var p = JSON.parse(localStorage.getItem(LS_PROFILE) || '{}');
      if (p && p.company) writeForm(p);
      ST.points = p.points || [];
      ST.alias = p.alias || {};
      ST.judge = p.judge || null;
      ST.pointsFor = p.pointsFor || '';
      ST.items = JSON.parse(localStorage.getItem(LS_ITEMS) || '[]');
    } catch (e) {}
  }

  function saveLocal() {
    var p = readForm();
    p.points = ST.points;
    p.alias = ST.alias || {};
    p.judge = ST.judge || null;
    p.pointsFor = ST.pointsFor || '';
    p.version = hashOf(p);
    p.updated_at = new Date().toISOString().slice(0, 16).replace('T', ' ');
    localStorage.setItem(LS_PROFILE, JSON.stringify(p));
    localStorage.setItem(LS_ITEMS, JSON.stringify(ST.items.slice(0, 40)));
    return p;
  }

  function hashOf(p) {
    var flat = [p.company, p.role, p.scale, p.name, p.school, p.jd, p.resume]
      .map(function (x) { return (x || '').replace(/\s+/g, ' ').trim(); }).join('|');
    var h = 5381;
    for (var i = 0; i < flat.length; i++) h = ((h << 5) + h + flat.charCodeAt(i)) >>> 0;
    return ('0000000' + h.toString(16)).slice(-8) + flat.length.toString(16);
  }

  /* ---------------- 渲染 ---------------- */
  function paintBar() {
    var p = readForm();
    var bar = $('#liveBar'); if (!bar) return;
    var prof = null;
    try { prof = JSON.parse(localStorage.getItem(LS_PROFILE) || 'null'); } catch (e) {}
    var ver = prof && prof.version ? prof.version : '未保存';
    bar.style.display = 'flex';
    $('#liveDot').className = 'dot' + (ST.dirty ? ' dirty' : '');
    if (!p.company && !p.role) {
      $('#liveTxt').innerHTML = '还没填画像 · 填完公司/岗位/JD 会自动保存到这台设备';
      return;
    }
    $('#liveTxt').innerHTML = ST.dirty
      ? '<b style="color:#b45309">有改动</b> · 停手 1 秒自动保存，已生成的稿子会标成旧版本'
      : '画像 <b>' + esc(p.company) + ' · ' + esc(p.role) + '</b> 已存本机 · 版本 ' + esc(ver) +
        ' · 稿件 ' + (ST.items.length ? ST.items.length + ' 题' : '未生成');
  }

  function paintGap() {
    var p = readForm();
    var local = localGap(p, ST.points, ST.alias);
    var J = (ST.judge && ST.judge.key === judgeKey(p)) ? ST.judge : null;
    var hit = J ? J.hit : local.hit;
    var miss = J ? J.miss : local.miss;
    var total = hit.length + miss.length;
    ST.gap = {
      hit: hit.map(function (x) { return x.k; }), miss: miss,
      coverage: total ? Math.round(hit.length / total * 100) : 0,
      numbers: local.numbers, lines: local.lines, problems: local.problems.slice(),
      judged: !!J
    };
    var g = ST.gap;
    $('#gapBox').style.display = 'block';
    $('#gapCov').textContent = g.coverage + '%';
    $('#gapFill').style.width = g.coverage + '%';

    var status = $('#gapStat');
    if (status) {
      if (!ST.points.length) status.textContent = '还没提炼 JD 关键词';
      else if (!J) status.textContent = '判定中…（先按字面粗算）';
      else status.textContent = '模型读过简历';
    }

    $('#gapKws').innerHTML = hit.map(function (x) {
      var ev = x.ev ? '<i> · ' + esc(x.ev) + '</i>' : '';
      return '<span class="kw ok">✓ ' + esc(x.k) + ev + '</span>';
    }).join('') + miss.map(function (k) {
      var a = (ST.alias && ST.alias[k]) || [];
      var tip = a.length ? '　写上「' + a.slice(0, 3).join('/') + '」任一' : '　简历没提';
      return '<span class="kw no" title="' + esc(tip.trim()) + '">✗ ' + esc(k) + tip + '</span>';
    }).join('');

    var probs = local.problems.slice();
    if (miss.length && J) probs.unshift('JD 里有 ' + miss.length + ' 个能力项简历确实没有：' + miss.slice(0, 5).join('、') + '（现场别硬编，讲可迁移或标待补）');
    $('#gapProblems').innerHTML = probs.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('');
  }

  function paintQuestions() {
    var box = $('#qList'); if (!box) return;
    var byJd = ST.points.slice(0, 2).map(function (k) {
      return { type: '面试题', q: '你在「' + k + '」这件事上，具体做出过什么结果？' };
    });
    if (!byJd.length) byJd = [{ type: '面试题', q: '你为什么选这个岗位' }];
    var sets = [
      { title: '个人陈述（群面 60 秒）', items: [
        { type: '个人陈述', q: '设计一个提升校招面试体验的产品（60 秒个人陈述）' },
        { type: '个人陈述', q: '如何用 AI 把校招流程周期缩短 30%（60 秒个人陈述）' }
      ] },
      { title: '自我介绍 / 开场', items: [
        { type: '自我介绍', q: '30 秒自我介绍' },
        { type: '开场观点', q: '群面第一轮发言，给出你这道题的框架' }
      ] },
      { title: '按 JD 生成（随画像变）', items: byJd },
      { title: '通用（不依赖画像）', items: [
        { type: '面试题', q: '用一句话介绍自己' },
        { type: '面试题', q: '这个岗位为什么选你，不选别人' }
      ] }
    ];
    box.innerHTML = sets.map(function (st, si) {
      return '<div class="qset"><div class="qt">' + esc(st.title) + '</div>' + st.items.map(function (it, ii) {
        var id = 'q_' + si + '_' + ii;
        return '<div class="qi"><input type="checkbox" id="' + id + '" data-type="' + esc(it.type) + '" value="' + esc(it.q) + '">' +
          '<label for="' + id + '" style="flex:1;cursor:pointer">' + esc(it.q) + '</label>' +
          '<span class="cp" data-q="' + esc(it.q) + '">填到下面</span></div>';
      }).join('') + '</div>';
    }).join('') +
      '<div class="fld" style="margin-top:4px"><label>或自己贴一道题</label>' +
      '<textarea id="qOwn" style="min-height:56px" placeholder="把群面题/单面题原文贴进来"></textarea></div>';
    box.querySelectorAll('.cp').forEach(function (b) {
      b.onclick = function () {
        var a = $('#qOwn'); if (a) { a.value = b.dataset.q; a.focus(); }
      };
    });
  }

  /** 渲染稿件；旧版本稿子打灰并标注 */
  function paintItems() {
    var res = $('#cResult'); if (!res) return;
    var curVer = hashOf(readForm());
    if (!ST.items.length) {
      res.innerHTML = '<div class="empty">① 左边填简历和 JD（自动存本机）→ ② 勾题 → ③「生成 / 更新已勾选的题」<br>' +
        '生成要 20~60 秒（浏览器直连模型，走代理）。改简历后旧稿子会标「待更新」。</div>';
      return;
    }
    var h = '<h4>本机稿件 · 共 ' + ST.items.length + ' 题</h4>';
    ST.items.forEach(function (it, i) {
      var stale = it.ver && it.ver !== curVer;
      h += '<div class="tl-item' + (stale ? ' stale' : '') + '" data-i="' + i + '">' +
        '<div class="qh"><b>' + esc(it.q) + '</b>' +
        (stale ? '<span class="badge2 warn2">画像已改，待更新</span>' : '') +
        '<span class="badge2">' + esc(it.type || '') + '</span></div>' +
        '<div class="txt">' +
        '<p><b>开场</b>：' + esc(it.opening || '') + '</p>' +
        (it.points || []).map(function (x) { return '<p>· ' + esc(x) + '</p>'; }).join('') +
        '<p><b>收口</b>：' + esc(it.closing || '') + '</p>' +
        (it.metric ? '<p><b>指标</b>：' + esc(it.metric) + '</p>' : '') + '</div>' +
        (it.gapNote && it.gapNote !== '无' ? '<div class="meta2"><b>这题上的缺口</b>：' + esc(it.gapNote) + '</div>' : '') +
        (it.risk ? '<div class="meta2"><b>风险与兜底</b>：' + esc(it.risk) + '</div>' : '') +
        '<div class="ops"><button data-act="copy" data-i="' + i + '">复制</button>' +
        '<button data-act="print" data-i="' + i + '">单题打印</button>' +
        '<button data-act="del" data-i="' + i + '">删掉</button></div></div>';
    });
    h += '<div class="dlrow"><button id="btnDlAll">下载全部稿件（HTML）</button>' +
         '<button id="btnClearAll">清空本机稿件</button></div>';
    res.innerHTML = h;
    res.querySelectorAll('[data-act]').forEach(function (b) {
      b.onclick = function () {
        var it = ST.items[+b.dataset.i];
        if (b.dataset.act === 'copy') {
          var t = '【' + it.q + '】\n开场：' + it.opening + '\n' +
            (it.points || []).map(function (x) { return '· ' + x; }).join('\n') +
            '\n收口：' + it.closing + '\n指标：' + (it.metric || '');
          if (navigator.clipboard) navigator.clipboard.writeText(t).then(function () { b.textContent = '已复制'; });
          else alert('请手动选中复制');
        } else if (b.dataset.act === 'print') {
          printOne(it);
        } else {
          ST.items.splice(+b.dataset.i, 1); saveLocal(); paintItems(); paintBar();
        }
      };
    });
    if ($('#btnDlAll')) $('#btnDlAll').onclick = dlAll;
    if ($('#btnClearAll')) $('#btnClearAll').onclick = function () {
      if (confirm('清空本机所有稿件？（简历和 JD 保留）')) { ST.items = []; saveLocal(); paintItems(); paintBar(); }
    };
  }

  function printOne(it) {
    var w = window.open('', '_blank');
    w.document.write('<!DOCTYPE html><meta charset="utf-8"><title>' + esc(it.q) + '</title>' +
      '<body style="font-family:PingFang SC,Microsoft YaHei;max-width:720px;margin:38px auto;line-height:1.9;font-size:15px;color:#111">' +
      '<h2 style="font-size:18px;border-bottom:2px solid #111;padding-bottom:8px">' + esc(it.q) + '</h2>' +
      '<p><b>开场</b>：' + esc(it.opening) + '</p>' +
      (it.points || []).map(function (x) { return '<p>· ' + esc(x) + '</p>'; }).join('') +
      '<p><b>收口</b>：' + esc(it.closing) + '</p><p><b>指标</b>：' + esc(it.metric || '') + '</p>' +
      '<p style="color:#666;font-size:12px">' + esc(it.risk || '') + '</p></body>');
    w.document.close();
    setTimeout(function () { w.print(); }, 400);
  }

  function dlAll() {
    var p = readForm();
    var h = '<!DOCTYPE html><html lang="zh-CN"><meta charset="utf-8"><title>定制稿件</title>' +
      '<body style="font-family:PingFang SC,Microsoft YaHei;max-width:820px;margin:40px auto;padding:0 20px;line-height:1.85;color:#111827">' +
      '<h1 style="font-size:22px">定制面试稿 · ' + esc(p.company) + ' ' + esc(p.role) + '</h1>' +
      '<p style="color:#6b7280;font-size:13px">' + esc(p.name) + ' ' + esc(p.school) + ' · 生成于 ' +
      new Date().toLocaleString('zh-CN') + '</p>' +
      ST.items.map(function (it) {
        return '<div style="border:1px solid #e5e7eb;border-radius:10px;padding:12px 15px;margin:14px 0">' +
          '<b>' + esc(it.q) + '</b><p><b>开场</b>：' + esc(it.opening) + '</p>' +
          (it.points || []).map(function (x) { return '<p>· ' + esc(x) + '</p>'; }).join('') +
          '<p><b>收口</b>：' + esc(it.closing) + '</p><p><b>指标</b>：' + esc(it.metric || '') + '</p>' +
          (it.risk ? '<p style="color:#b45309;font-size:12.5px">' + esc(it.risk) + '</p>' : '') + '</div>';
      }).join('') + '</body></html>';
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([h], { type: 'text/html;charset=utf-8' }));
    a.download = '定制稿件_' + (p.company || '') + '.html';
    a.click();
  }

  /* ---------------- 生成 ---------------- */
  var SYS = '你是校招面试教练。按候选人简历与目标岗位，把一道面试题写成能直接念的回答稿。\n' +
    '铁律：只用简历里出现过的数字与事实，禁止编造新数字、新公司、新奖项；每段≤90字，口语；' +
    '简历里没有的 JD 关键词不要硬编经历，改成"可迁移"或直接标"待补"。\n' +
    '只输出 JSON：{"opening":"开场1句≤50字","points":["展开点1≤90字","点2","点3"],' +
    '"closing":"收口1句≤50字","metric":"指标，含分子分母","risk":"最大风险+兜底","gapNote":"这题最缺什么（没有写无）"}';

  function userPrompt(p, q, type) {
    var hint = type === '个人陈述' ? '群面 60 秒个人陈述：先给判断，再两三个支撑点，最后落到指标。'
      : type === '自我介绍' ? '30~60 秒自我介绍：问好→两三段经历→挑最相关一段讲透→收住，不报人数。'
      : type === '开场观点' ? '群面第一轮发言：15 秒内给出拆题框架。'
      : '针对具体题目的回答稿：先破题一句，再给三块结构。';
    return '【公司/岗位】' + p.company + ' · ' + p.role + (p.scale ? '（' + p.scale + '）' : '') + '\n' +
      '【候选人】' + (p.name || '候选人') + (p.school ? '，' + p.school : '') + '\n' +
      '【JD 关键词】' + (ST.points.join('、') || '未提取') + '\n' +
      '【JD 原文】' + (p.jd || '').slice(0, 1200) + '\n' +
      '【简历（只可引用，不可扩写）】\n' + (p.resume || '').slice(0, 2000) + '\n' +
      '【题目】' + q + '\n【形式】' + hint;
  }

  async function genOne(p, q, type) {
    var lastErr = null;
    for (var attempt = 0; attempt < 2; attempt++) {
      var raw = await chat(
        [{ role: 'system', content: SYS }, { role: 'user', content: userPrompt(p, q, type) }],
        { temp: attempt ? 0.4 : 0.65, max: attempt ? 2600 : 1600 }
      );
      var j = parseJson(raw);
      if (j && (j.points || []).length) {
        j.q = q; j.type = type; j.ver = hashOf(p); j.t = Date.now();
        return j;
      }
      lastErr = new Error('模型返回的不是完整 JSON（可能是输出被截断）');
    }
    throw lastErr;
  }

  async function genSelected() {
    if (ST.busy) return;
    var p = readForm();
    if (!p.company || !p.role || !p.jd) { alert('公司、岗位、JD 三样要填齐'); return; }
    var picked = [];
    document.querySelectorAll('#qList input[type=checkbox]:checked').forEach(function (c) {
      picked.push({ q: c.value, type: c.dataset.type });
    });
    var own = ($('#qOwn') || {}).value || '';
    if (own.trim().length >= 4) picked.push({ q: own.trim(), type: '面试题' });
    if (!picked.length) { alert('先勾至少一道题，或在下面贴一道题'); return; }

    ST.busy = true;
    var btn = $('#btnRecalc'), old = btn.textContent;
    btn.disabled = true;
    var res = $('#cResult');
    var done = [], failed = [];
    try {
      // 先确定 JD 关键词，缺口和题目才会准
      if (!ST.points.length) { ST.points = fallbackPoints(p.jd); ST.alias = {}; } ST.alias = {};
      saveLocal(); paintGap();
      if (ST.pointsFor !== hashStr(p.jd || '')) {          // 出稿前顺手把词换准（失败不影响）
        try { await extractPoints(p.jd); saveLocal(); } catch (e) {}
      }
      if (ST.points.length && (!ST.judge || ST.judge.key !== judgeKey(p))) {
        try { await judgeGap(p, ST.points); } catch (e) {}
      }

      for (var i = 0; i < picked.length; i++) {
        btn.textContent = '生成中 ' + (i + 1) + '/' + picked.length + '…';
        res.innerHTML = '<div class="empty">正在生成第 ' + (i + 1) + ' 题（共 ' + picked.length + ' 题）…<br>' +
          '浏览器直连模型，走公共代理，约 20~40 秒一题。别关页面。</div>';
        try {
          var it = await genOne(p, picked[i].q, picked[i].type);
          var idx = ST.items.findIndex(function (x) { return x.q === it.q; });
          if (idx >= 0) ST.items[idx] = it; else ST.items.unshift(it);
          done.push(it.q);
          saveLocal(); paintItems();
        } catch (e) {
          failed.push(picked[i].q.slice(0, 12) + '：' + e.message);
        }
      }
    } finally {
      ST.busy = false; btn.disabled = false; btn.textContent = old;
      paintItems(); paintBar();
      if (failed.length) {
        res.insertAdjacentHTML('afterbegin', '<div class="gapbox" style="border-color:#fecaca;background:#fef2f2">' +
          '<h4 style="color:#b91c1c">有 ' + failed.length + ' 题没成功</h4><ul>' +
          failed.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>' +
          '<p style="font-size:12.5px;color:#7f1d1d;margin:6px 0 0">多半是公共 CORS 代理被限流。' +
          '等 1~2 分钟再点一次；还不行就用云端版（有后端，不走代理）。</p></div>');
      }
    }
  }

  /* ---------------- 事件 ---------------- */
  function bind() {                          // 保留：手动测试时可直接调
    loadLocal();
    bindIfExists();
    paintQuestions();
    paintGap();
    paintBar();
    paintItems();

    Object.keys(FIELD_MAP).forEach(function (id) {
      var el = $('#' + id); if (!el) return;
      el.addEventListener('input', function () {
        ST.dirty = true; paintBar();
        clearTimeout(ST.saveTimer);
        ST.saveTimer = setTimeout(function () {
          var p = readForm();
          if (!ST.points.length || ST.points.join('') === fallbackPoints(prevJd).join('')) {
            ST.points = fallbackPoints(p.jd); ST.alias = {};
          }
          prevJd = p.jd || '';
          ST.dirty = false;
          saveLocal(); paintGap(); paintQuestions(); paintBar(); paintItems();
          autoPoints();
        }, 1000);
      });
    });

    var b1 = $('#btnSaveProf');
    if (b1) b1.onclick = function () {
      var p = readForm();
      ST.points = ST.points.length ? ST.points : fallbackPoints(p.jd);
      ST.dirty = false; saveLocal(); paintGap(); paintQuestions(); paintBar(); paintItems();
      var t = $('#liveTxt'); if (t) t.innerHTML += ' <span style="color:#065f46">· 已保存到本机</span>';
    };
    var b2 = $('#btnRecalc');
    if (b2) b2.onclick = genSelected;
    var b3 = $('#btnGen');
    if (b3) b3.onclick = genSelected;
    var b4 = $('#btnRefreshPoints');
    if (b4) b4.onclick = refreshPoints;
  }

  var prevJd = '';

  /** 用模型把 JD 提炼成 4~6 个能力关键词（花一次 token，之后缓存） */
  async function refreshPoints() {
    var p = readForm();
    if (!p.jd) { alert('先填 JD'); return; }
    var btn = $('#btnRefreshPoints'), old = btn.textContent;
    btn.disabled = true; btn.textContent = '提炼中…';
    try {
      var ok = await extractPoints(p.jd);
      if (!ok) throw new Error('返回格式不对');
    } catch (e) {
      ST.points = fallbackPoints(p.jd); ST.alias = {}; saveLocal(); paintGap(); paintQuestions();
      alert('模型提炼失败（' + e.message + '），已改用本地关键词规则，缺口照样能算。');
    } finally { btn.disabled = false; btn.textContent = old; }
  }

  /** 真正干活的提炼；成功返回 true */
  async function extractPoints(jd) {
    var ask = '从下面 JD 提炼这个岗位真正要考的能力项，5~6 个。\n' +
      '要求：名词短语、2~5 个字、不要动词、不要整句（例：数据分析 / B端产品 / 项目管理 / 用户研究）。\n' +
      '每个能力项再给 2~4 个"简历里可能怎么写"的证据词（同义词、工具名、动作词），用来判断候选人简历到底有没有这一项。\n' +
      '只输出 JSON：{"jdPoints":[{"k":"数据分析","a":["指标","报表","看板","SQL"]}]}\n\n' + (jd || '').slice(0, 2500);
    var raw = await chat([{ role: 'system', content: '只输出 JSON，不要解释。' }, { role: 'user', content: ask }],
      { temp: 0.2, max: 700 });
    var j = parseJson(raw);
    var list = (j && j.jdPoints) || [];
    if (!list.length) return false;

    var pts = [], alias = {};
    list.slice(0, 6).forEach(function (it) {
      var k = String(typeof it === 'string' ? it : (it.k || it.key || '')).replace(/\s+/g, '');
      if (!k) return;
      pts.push(k);
      var a = (it && it.a) || (it && it.alias) || [];
      alias[k] = (Array.isArray(a) ? a : [a]).map(function (x) { return String(x).replace(/\s+/g, ''); })
        .filter(function (x) { return x && x !== k; }).slice(0, 4);
    });
    if (!pts.length) return false;
    ST.points = pts; ST.alias = alias;
    ST.pointsFor = hashStr(jd || '');
    saveLocal(); paintGap(); paintQuestions();
    return true;
  }

  /** 改完画像后静默重算：本地先上屏 → 提炼关键词 → 判定缺口。任一步失败都不打扰用户。 */
  var autoTimer = null, autoBusy = false;
  function autoPoints() {
    clearTimeout(autoTimer);
    autoTimer = setTimeout(runRefresh, 1200);
  }

  async function runRefresh() {
    if (autoBusy) return;
    autoBusy = true;
    try {
      var p = readForm();
      if (!p.jd) { paintGap(); return; }
      if (ST.pointsFor !== hashStr(p.jd)) {
        var ok = false;
        try { ok = await extractPoints(p.jd); } catch (e) {}
        if (!ok) { ST.points = fallbackPoints(p.jd); ST.alias = {}; ST.pointsFor = hashStr(p.jd); paintGap(); }
      }
      if (ST.points.length && (!ST.judge || ST.judge.key !== judgeKey(p))) {
        try { await judgeGap(p, ST.points); } catch (e) {}
      }
    } finally {
      autoBusy = false;
      saveLocal(); paintGap(); paintQuestions(); paintBar();
    }
  }

  function hashStr(s) {
    var h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    return h.toString(16) + s.length;
  }

  /* --------- 和服务器版共用同一套 DOM：缺的元素按需补 --------- */
  function bindIfExists() {
    if (!$('#gapBox')) return;
  }

  document.addEventListener('DOMContentLoaded', function () {
    if (!$('#tab-custom')) return;                 // 不在定制页，什么都不做
    var localTest = /[?&]static=1/.test(location.search);          // 本地调试用 ?static=1
    if (!/github\.io$/.test(location.hostname) && !window.IVP_FORCE_STATIC && !localTest) return;  // 服务器版走服务端接口
    window.IVP_STATIC_MODE = true;
    // 服务器版的 bind 已在 portal.html 里执行过，这里只接管关键按钮
    var oldRecalc = $('#btnRecalc');
    if (oldRecalc) oldRecalc.onclick = null;
    bindStaticOverrides();
  });

  function bindStaticOverrides() {
    try { loadLocal(); } catch (e) {}
    paintQuestions(); paintGap(); paintBar(); paintItems();
    var b = $('#btnRecalc'); if (b) b.onclick = genSelected;
    var c = $('#btnGen'); if (c) c.onclick = genSelected;
    var s = $('#btnSaveProf');
    if (s) s.onclick = function () {
      var p = readForm();
      ST.points = ST.points.length ? ST.points : fallbackPoints(p.jd);
      ST.dirty = false; saveLocal(); paintGap(); paintQuestions(); paintBar(); paintItems();
      var t = $('#liveTxt'); if (t) t.innerHTML += ' <span style="color:#065f46">· 已保存到本机</span>';
    };
    var rp = $('#btnRefreshPoints');
    if (rp) rp.onclick = refreshPoints;
    prevJd = (readForm().jd || '');
    Object.keys(FIELD_MAP).forEach(function (id) {
      var el = $('#' + id); if (!el) return;
      el.addEventListener('input', function () {
        ST.dirty = true; paintBar();
        clearTimeout(ST.saveTimer);
        ST.saveTimer = setTimeout(function () {
          var f = readForm();
          if (f.jd !== prevJd) {          // JD 变了：先本地粗算顶上，再让模型换准
            ST.points = fallbackPoints(f.jd); ST.alias = {}; ST.pointsFor = ''; ST.judge = null;
            prevJd = f.jd;
          }
          ST.dirty = false; saveLocal(); paintGap(); paintQuestions(); paintBar(); paintItems();
          autoPoints();                   // JD 或简历变了都会触发（内部自己判要不要重算）
        }, 1000);
      });
    });
  }

  window.IVP_TAILOR = { gen: genSelected, refreshPoints: refreshPoints, cfg: decodeCfg };
})();
