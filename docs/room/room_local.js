/* ===========================================================================
 * 模拟考场 · 纯静态本地引擎
 * ---------------------------------------------------------------------------
 * GitHub Pages 没有后端，所以把 room_app.py 的 9 个接口在浏览器里重写了一遍：
 *   /api/meta           → 读同目录 meta.json
 *   /api/session        → 单面开场（调模型，失败用本地开场白）
 *   /api/chat           → 面试官接话
 *   /api/finish         → 五维评分 + 8 条清单
 *   /api/group/start    → 群面开场
 *   /api/group/speak    → 你发言后 AI 考生回应
 *   /api/group/auto     → AI 考生之间自己聊
 *   /api/group/next     → 推进环节
 *   /api/group/review   → 复盘报告 + 对照清单
 *
 * 和服务器版的差别：
 *   · 会话只存在内存里（刷新页面这场就没了，刷新前先看完复盘）
 *   · 模型 Key 用和定制页同一套口令解密（config.enc.js），浏览器直连
 *   · 模型不可用时自动退回本地剧本，流程仍能走完（和服务器版同款降级）
 * =========================================================================== */
(function () {
  'use strict';

  var P = null;            // prompts.js 注入的配置
  var META = {};           // meta.json
  var CFG = null;
  var SALT = 'ivp-2026-10-29|v2', ITER = 200000, LS_PASS = 'ivpPass';
  var sessions = {};       // 内存里的会话表

  /* ===================== 口令模式（要改就改这两行） =====================
   * 'auto' → 打开页面就用下面的口令直连模型，不弹框。换句话说：一进考场就在花你的额度。
   * 'ask'  → 每次打开都手动输口令，不输只用固定剧本、零消耗。
   * 觉得消耗快，把 PASS_MODE 改成 'ask' 重新上传本文件即可。
   * ==================================================================== */
  var PASS_MODE = 'auto';
  var DEFAULT_PASS = 'ziyang-1029';
  var readyResolve;
  var READY_P = new Promise(function (r) { readyResolve = r; });

  /* ---------------- 配置解密（与 tailor_static.js 一致） ---------------- */
  function b64d(s) {
    s = s.replace(/-/g, '+').replace(/_/g, '/');
    var pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : '';
    var bin = atob(s + pad), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  async function deriveRaw(pass) {
    var base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass),
      { name: 'PBKDF2' }, false, ['deriveBits']);
    var bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt: new TextEncoder().encode(SALT), iterations: ITER, hash: 'SHA-256' },
      base, 256);
    return new Uint8Array(bits);
  }
  async function fernetOpen(token, raw) {
    var blob = b64d(token);
    var body = blob.slice(0, blob.length - 32), sig = blob.slice(blob.length - 32);
    var iv = blob.slice(9, 25), ct = blob.slice(25, blob.length - 32);
    var macKey = await crypto.subtle.importKey('raw', raw.slice(0, 16),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    if (!(await crypto.subtle.verify('HMAC', macKey, sig, body))) {
      var e = new Error('口令不对'); e.code = 'PASS'; throw e;
    }
    var key = await crypto.subtle.importKey('raw', raw.slice(16, 32), { name: 'AES-CBC' }, false, ['decrypt']);
    var plain = await crypto.subtle.decrypt({ name: 'AES-CBC', iv: iv }, key, ct);
    return JSON.parse(new TextDecoder().decode(plain));
  }
  async function decodeCfg(pass) {
    if (CFG) return CFG;
    var token = window.IVP_CFG;
    if (!token) throw new Error('缺少 config.enc.js');
    pass = pass || sessionStorage.getItem(LS_PASS) || localStorage.getItem(LS_PASS) || '';
    if (!pass && PASS_MODE === 'auto') pass = DEFAULT_PASS;      // 自动模式：不需要用户输
    if (!pass) { var e0 = new Error('还没输口令'); e0.code = 'PASS'; throw e0; }
    CFG = await fernetOpen(token, await deriveRaw(pass));
    return CFG;
  }

  /* ---------------- 模型调用 ---------------- */
  var PROXY = ['https://corsproxy.io/?', 'https://api.allorigins.win/raw?url='];

  async function llm(messages, opt) {
    opt = opt || {};
    var cfg;
    try { cfg = await decodeCfg(); } catch (e) { return null; }   // 没口令 → 走本地剧本
    var endpoint = cfg.base_url.replace(/\/+$/, '') + '/chat/completions';
    var body = {
      model: opt.model || cfg.model,
      messages: messages,
      temperature: opt.temp == null ? 0.9 : opt.temp,
      max_tokens: opt.max || 1200
    };
    if (/flash/.test(body.model)) body.thinking = { type: 'disabled' };
    var targets = [endpoint].concat(PROXY.map(function (p) {
      return p + encodeURIComponent(endpoint);
    }));
    for (var i = 0; i < targets.length; i++) {
      try {
        var r = await fetch(targets[i], {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.api_key },
          body: JSON.stringify(body)
        });
        if (!r.ok) continue;
        var j = await r.json();
        var c = j && j.choices && j.choices[0] && j.choices[0].message &&
                (j.choices[0].message.content || '').trim();
        if (c) return c;
      } catch (e) { /* 试下一个通道 */ }
    }
    return null;
  }

  function parseJson(raw) {
    if (!raw) return null;
    var s = String(raw).replace(/```(json)?/g, '').trim();
    var a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a >= 0 && b > a) s = s.slice(a, b + 1);
    try { return JSON.parse(s); } catch (e) { return null; }
  }

  /* ---------------- 小工具（对应 Python 那套） ---------------- */
  function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
  function hhmm() {
    var d = new Date();
    return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  }
  function sid() { return Math.random().toString(36).slice(2, 14); }
  function topicOf(id) {
    var ts = META.topics || [];
    for (var i = 0; i < ts.length; i++) if (ts[i].id === id) return ts[i];
    return ts[0];
  }
  function personaOf(id) {
    var ps = (P && P.interviewerPersonas) || [];
    for (var i = 0; i < ps.length; i++) if (ps[i].id === id) return ps[i];
    return ps[0];
  }
  function groupPersona(id) {
    var ps = META.personas || [];
    for (var i = 0; i < ps.length; i++) if (ps[i].id === id) return ps[i];
    return null;
  }

  /* ---------------- 单面：面试官系统提示 ---------------- */
  function buildInterviewerSys(minutes, ipid) {
    var qs = ['1. 先用 30 秒介绍一下你自己（这一题完整听完，不要中途打断）'];
    var n = 2, bank = META.questions || {};
    Object.keys(bank).forEach(function (g) {
      (bank[g] || []).forEach(function (q) {
        if (qs[0].indexOf(q) >= 0) return;
        qs.push(n + '. ' + q);
        n++;
      });
    });
    var ip = personaOf(ipid);
    var tpl = (P && P.sys && P.sys.interviewer) || '';
    return tpl
      .replace(/\{\{MINUTES\}\}/g, minutes)
      .replace(/\{\{PERSONA\}\}/g, ip.name)
      .replace(/\{\{STYLE\}\}/g, ip.style || '')
      .replace(/\{\{QUESTIONS\}\}/g, qs.join('\n'))
      .replace(/\{\{TRAPS\}\}/g, (ip.traps || []).join('\n'));
  }

  function mockInterviewer(turns) {
    var qs = ['先用 30 秒介绍一下你自己'];
    var bank = META.questions || {};
    Object.keys(bank).forEach(function (g) {
      (bank[g] || []).forEach(function (q) { if (qs.indexOf(q) < 0) qs.push(q); });
    });
    if (turns === 0) return '我们直接开始。' + qs[0];
    if (turns < qs.length) return ['好的。', '明白。', '嗯。'][turns % 3] + qs[turns];
    return '好，今天到这里。';
  }

  /* ---------------- 单面：本地评分兜底（字段与 SCORER_SYS 一致） ---------------- */
  function demoScore(transcript) {
    var mine = transcript.filter(function (t) { return t.role === 'me'; });
    var joined = mine.map(function (t) { return t.text; }).join('');
    var nums = (joined.match(/\d+(?:\.\d+)?%?|\d{2,}/g) || []).length;
    var avg = mine.length ? joined.length / mine.length : 0;
    function b(v) { return Math.max(6, Math.min(19, Math.round(v))); }
    var dims = [
      { name: '结论密度', score: b(9 + (mine.length ? 3 : 0)), evidence: '',
        fix: '开口第一句先给结论，再铺背景' },
      { name: '证据具体性', score: b(6 + Math.min(8, nums * 2)), evidence: '',
        fix: '每个成果后面补一个数字（规模 / 比例 / 时间）' },
      { name: '追问抗压', score: b(11), evidence: '', fix: '被追问时补新信息，不要重复上一句' },
      { name: '结构清晰', score: b(9 + (mine.length >= 3 ? 3 : 0)), evidence: '',
        fix: '把回答压成"三点"，对方能复述' },
      { name: '岗位匹配', score: b(10), evidence: '', fix: '把经历翻译成岗位语言，而不只是讲做了什么' }
    ];
    var total = Math.round(dims.reduce(function (a, x) { return a + x.score; }, 0) * 100 / 95);
    return {
      total: Math.min(100, total), dims: dims,
      best_answer: nums ? '带了具体数字的那次回答最扎实。' : '回答完整，但缺可验证的数字。',
      worst_answer: '表现最弱的一题：没有给出结构，听完记不住重点。',
      rewrite: '结论先行："这件事我的判断是 X，因为 A 和 B 两个原因，其中 B 最关键。"',
      one_line: '能沟通，但还不够"有结论"',
      demo: true
    };
  }

  var HEUR_WORDS = {
    judgement: ['因为', '当时考虑', '之所以', '权衡', '对比了', '决定不', '优先'],
    redo: ['重来', '如果再来', '下次会', '回头想', '现在看'],
    own_part: ['我负责', '我自己', '我牵头', '我主导', '我做的是', '我拉', '我跑'],
    team: ['团队', '同事', '合作', '一起']
  };

  function soloChecks(transcript) {
    var mine = transcript.filter(function (t) { return t.role === 'me'; }).map(function (t) { return t.text; });
    var joined = mine.join('');
    var n = Math.max(1, mine.length);
    var numTurns = mine.filter(function (x) { return /\d/.test(x); }).length;
    // 前端按数组遍历（checks.filter），不能给对象
    var out = ((P && P.soloChecks) || []).map(function (c) {
      return { key: c.key, label: c.label, hint: c.hint, done: null, evidence: '' };
    });
    var by = {};
    out.forEach(function (c) { by[c.key] = c; });
    if (by.number) {
      by.number.done = numTurns >= Math.max(1, Math.floor(n / 2));
      by.number.evidence = numTurns + '/' + n + ' 次回答里出现了数字';
    }
    if (by.length) {
      var avg = joined.length / n;
      by.length.done = avg <= 260;
      by.length.evidence = '平均每次回答 ' + Math.round(avg) + ' 字';
    }
    if (by.ask && mine.length) {
      var lastq = /[?？]|请问|想问|了解一下/.test(mine[mine.length - 1]);
      by.ask.done = lastq;
      by.ask.evidence = lastq ? '最后一次发言里有提问' : '';
    }
    ['judgement', 'redo', 'own_part'].forEach(function (k) {
      if (!by[k]) return;
      var hit = HEUR_WORDS[k].some(function (w) { return joined.indexOf(w) >= 0; });
      if (hit) by[k].done = true;
      if (k === 'own_part' && hit) {
        var team = HEUR_WORDS.team.some(function (w) { return joined.indexOf(w) >= 0; });
        if (team) by.own_part.done = true;
      }
    });
    return out;
  }

  /* ---------------- 群面：本地台词 ---------------- */
  function localLine(p, stageName, transcript, extraUser) {
    var L = (P && P.local) || {};
    var prefix = (L.prefix || {})[p.id] || '';
    var pool = (extraUser ? (L.reply || {})[stageName] : (L.lines || {})[stageName]) ||
               (L.lines || {})['自由讨论'] || ['我先说说我的想法。'];
    var line = pick(pool);
    var lastWord = '刚才那个';
    for (var i = transcript.length - 1; i >= 0; i--) {
      var m = transcript[i];
      if (m.role === 'me' && m.text) {
        lastWord = m.text.length > 10 ? m.text.slice(0, 10) + '…' : m.text;
        break;
      }
    }
    return prefix + line.replace(/\{name\}/g, p.name)
      .replace(/\{bg\}/g, p.bg || '')
      .replace(/\{last_word\}/g, lastWord);
  }

  function recentText(transcript, n) {
    return transcript.slice(-(n || 8)).map(function (m) {
      var who = m.role === 'host' ? '主持人' : m.role === 'me' ? '用户考生' : m.name;
      return who + '：' + (m.text || '');
    }).join('\n');
  }

  function personaSystem(p, stageName, topic) {
    var tpl = (P && P.sys && P.sys.persona) || '';
    var guide = ((P && P.stageGuide) || {})[stageName] || '';
    var len = ((P && P.stageLen) || {})[stageName] || '';
    return tpl
      .replace(/\{\{NAME\}\}/g, p.name || '')
      .replace(/\{\{BG\}\}/g, p.bg || '')
      .replace(/\{\{STYLE\}\}/g, p.style || '')
      .replace(/\{\{AGGRESSION\}\}/g, String(p.aggression || 0))
      .replace(/\{\{STRATEGY\}\}/g, p.strategy || '')
      .replace(/\{\{WEAKNESS\}\}/g, p.weakness || '')
      .replace(/\{\{STAGE\}\}/g, stageName)
      .replace(/\{\{GUIDE\}\}/g, guide)
      .replace(/\{\{LEN\}\}/g, len)
      .replace(/\{\{TOPIC\}\}/g, topic ? topic.title : '');
  }

  async function aiSpeak(state, p, stageName, extraUser, mode) {
    var topic = topicOf(state.topic_id);
    var parts = [];
    if (stageName !== '自我介绍') {
      parts.push('【题目】《' + topic.title + '》：' + topic.desc);
      parts.push('【这题的常见陷阱】' + (topic.seed || ''));
    }
    parts.push('【最近发言（按时间顺序）】\n' + recentText(state.transcript));
    if (extraUser) {
      var hint = mode === 'grab' ? '（用户刚刚抢话打断了别人，你可以顺势接住或回击）'
        : mode === 'challenge' ? '（用户刚刚质疑了别人，你可以站队或反对）' : '';
      parts.push('【用户考生刚才说】' + extraUser + hint + '——你的发言要优先对它做出反应。');
    }
    parts.push('现在轮到你（' + p.name + '）发言，只输出发言内容：');

    var raw = await llm([{ role: 'system', content: personaSystem(p, stageName, topic) },
                         { role: 'user', content: parts.join('\n\n') }],
                        { temp: 0.9, max: 1000 });
    var text = (raw || localLine(p, stageName, state.transcript, extraUser)).trim().replace(/^["“]|["”]$/g, '');
    var lines = text.split('\n');
    if (lines.length > 1 && lines[0].length > 20) text = lines[0].trim();
    return { role: 'ai', pid: p.id, name: p.name, color: p.color, badge: p.badge,
             text: text.slice(0, 300), ts: hhmm() };
  }

  /* ---------------- 路由表 ---------------- */
  var ROUTES = {

    '/api/meta': function () {
      return {
        job: META.job, doc: META.doc, topics: META.topics, personas: META.personas,
        dims: META.dims, checks: META.checks, questions: META.questions,
        interviewers: META.interviewers || (P && P.interviewerPersonas) || [],
        soloChecks: META.soloChecks || (P && P.soloChecks) || [],
        mode: CFG ? 'live' : 'static',
        model: CFG ? ((CFG && CFG.model) || 'AI') : '固定剧本'
      };
    },

    '/api/session': async function (body) {
      var minutes = parseInt(body.minutes || 30, 10);
      var ipid = body.ipid || (((P && P.interviewerPersonas) || [])[0] || {}).id;
      var ip = personaOf(ipid);
      var system = buildInterviewerSys(minutes, ipid);
      var opening = await llm([{ role: 'system', content: system },
                               { role: 'user', content: '（面试开始）' }], { temp: 0.9, max: 700 });
      if (!opening) opening = ip.first || '我们开始吧，先简单介绍一下你自己。';
      var id = sid();
      sessions[id] = { kind: 'single', ipid: ipid, minutes: minutes, turns: 0,
                       transcript: [{ role: 'interviewer', text: opening }], system: system };
      return { session_id: id, opening: opening, persona: ip,
               mode: CFG ? 'live' : 'demo', system: system };
    },

    '/api/chat': async function (body) {
      var s = sessions[body.session_id];
      if (!s) return { error: '会话不存在' };
      var message = (body.message || '').trim();
      if (!message) return { error: '内容为空' };
      s.transcript.push({ role: 'me', text: message });
      s.turns++;
      var msgs = [{ role: 'system', content: body.system || s.system }];
      s.transcript.forEach(function (t) {
        msgs.push({ role: t.role === 'me' ? 'user' : 'assistant', content: t.text });
      });
      var reply = await llm(msgs, { temp: 0.9, max: 1000 });
      if (!reply) reply = mockInterviewer(s.turns);
      s.transcript.push({ role: 'interviewer', text: reply });
      return { reply: reply, turns: s.turns };
    },

    '/api/finish': async function (body) {
      var s = sessions[body.session_id];
      if (!s) return { error: '会话不存在' };
      var dialog = s.transcript.map(function (t) {
        return (t.role === 'me' ? '我' : '面试官') + '：' + t.text;
      }).join('\n');
      var raw = await llm([{ role: 'system', content: (P.sys || {}).scorer || '' },
                           { role: 'user', content: '岗位：' + ((META.job || {}).role || '') +
                             '\n时长：' + s.minutes + ' 分钟\n\n对话记录：\n' + dialog }],
                          { temp: 0.2, max: 4000 });
      var score = parseJson(raw) || demoScore(s.transcript);
      score.checks = soloChecks(s.transcript);
      return { score: score, transcript: s.transcript, persona: personaOf(s.ipid) };
    },

    '/api/group/start': function (body) {
      var topicId = body.topic_id || ((META.topics || [])[0] || {}).id;
      var pids = body.personas || (META.personas || []).slice(0, 4).map(function (p) { return p.id; });
      var topic = topicOf(topicId);
      var personas = pids.map(groupPersona).filter(Boolean);
      var id = sid();
      var host = { role: 'host', name: '主持人', text: (P.hostLines || {})['0'] || '', ts: hhmm() };
      sessions[id] = { kind: 'group', topic_id: topicId, personas: pids,
                       stage: 0, transcript: [host] };
      return { session_id: id, stage: 0, stage_name: (P.stageNames || [])[0],
               topic: topic, personas: personas, messages: [host],
               mode: CFG ? 'live' : 'demo' };
    },

    '/api/group/speak': async function (body) {
      var s = sessions[body.sid];
      if (!s) return { error: '场次不存在' };
      var text = (body.text || '').trim();
      if (!text) return { error: '内容为空' };
      var kind = body.kind || 'normal';
      var stageName = (P.stageNames || [])[s.stage];
      var userMsg = { role: 'me', name: '你', text: text, kind: kind, ts: hhmm() };
      s.transcript.push(userMsg);
      var out = [userMsg];

      var ps = s.personas.map(groupPersona).filter(Boolean);
      ps.sort(function (a, b) { return (b.aggression || 0) - (a.aggression || 0); });
      var responders;
      if (kind === 'grab') responders = ps.slice(0, 1);
      else if (s.stage >= 3) {
        var e = ps.filter(function (p) { return p.id === 'E'; });
        responders = e.length ? e.slice(0, 1) : ps.slice(0, 1);
      } else if (ps.length === 1) responders = [ps[0]];
      else responders = [ps[Math.floor(Math.random() * Math.min(2, ps.length))], ps[0]];
      var seen = {}, uniq = [];
      responders.forEach(function (p) { if (p && !seen[p.id]) { seen[p.id] = 1; uniq.push(p); } });

      for (var i = 0; i < uniq.length; i++) {
        var msg = await aiSpeak(s, uniq[i], stageName, i === 0 ? text : null, kind);
        s.transcript.push(msg);
        out.push(msg);
      }
      return { messages: out, stage: s.stage, stage_name: stageName };
    },

    '/api/group/auto': async function (body) {
      var s = sessions[body.sid];
      if (!s) return { error: '场次不存在' };
      var ps = s.personas.map(groupPersona).filter(Boolean);
      var picked = ps.slice().sort(function () { return Math.random() - 0.5; }).slice(0, Math.min(2, ps.length));
      var out = [];
      var stageName = (P.stageNames || [])[s.stage];
      for (var i = 0; i < picked.length; i++) {
        var msg = await aiSpeak(s, picked[i], stageName, null, 'normal');
        s.transcript.push(msg);
        out.push(msg);
      }
      return { messages: out };
    },

    '/api/group/next': function (body) {
      var s = sessions[body.sid];
      if (!s) return { error: '场次不存在' };
      if (s.stage >= 4) return { error: '已到复盘' };
      var topic = topicOf(s.topic_id);
      var nxt = s.stage + 1, HL = P.hostLines || {};
      var text;
      if (nxt === 1) text = (HL['1'] || '').replace('{title}', topic.title).replace('{desc}', topic.desc);
      else if (nxt >= 4) text = '总结陈词结束。本场讨论到此结束，现在生成复盘报告。';
      else text = HL[String(nxt)] || '继续。';
      var msg = { role: 'host', name: '主持人', text: text, ts: hhmm() };
      s.transcript.push(msg);
      s.stage = nxt;
      return { stage: nxt, stage_name: (P.stageNames || [])[nxt], messages: [msg] };
    },

    '/api/group/review': async function (body) {
      var s = sessions[body.sid];
      if (!s) return { error: '场次不存在' };
      var topic = topicOf(s.topic_id);
      var mine = s.transcript.filter(function (m) { return m.role === 'me'; });
      var nonHost = s.transcript.filter(function (m) { return m.role !== 'host'; }).length || 1;
      var stats = { turns: mine.length, share: Math.round(mine.length / nonHost * 100),
        mine: mine.map(function (m) { return m.text || ''; }) };
      var lines = s.transcript.slice(-70).map(function (m) {
        var who = m.role === 'host' ? '主持人' : m.role === 'me' ? '用户考生' : m.name;
        return who + '：' + (m.text || '');
      }).join('\n');
      var user = '【题目】《' + topic.title + '》：' + topic.desc +
        '\n【统计】用户考生发言 ' + stats.turns + ' 次，占非主持人发言的 ' + stats.share + '%。' +
        '\n【讨论记录】\n' + lines;
      var raw = await llm([{ role: 'system', content: (P.sys || {}).groupReview || '' },
                           { role: 'user', content: user }], { temp: 0.2, max: 4000 });
      var review = parseJson(raw) || demoReview(stats);

      var checks = ((META.checks) || []).map(function (c) {
        return { key: c.key, label: c.label, hint: c.hint, done: null, evidence: '' };
      });
      var checklist = ((META.checks) || []).map(function (c) { return '- ' + c.key + '：' + c.label; }).join('\n');
      var myText = mine.map(function (m) { return '- ' + m.text; }).join('\n') || '（考生全程未发言）';
      var raw2 = await llm([{ role: 'system', content: (P.sys || {}).check || '' },
                            { role: 'user', content: '【清单】\n' + checklist + '\n\n【考生全部发言】\n' + myText }],
                           { temp: 0.1, max: 2500 });
      var judged = parseJson(raw2) || {};
      var byKey = {};
      (judged.items || []).forEach(function (i) { if (i && i.key) byKey[i.key] = i; });
      checks.forEach(function (c) {
        var hit = byKey[c.key];
        if (hit) { c.done = !!hit.done; c.evidence = String(hit.evidence || '').slice(0, 120); }
        else { c.done = keywordCheck(c.key, mine); c.evidence = ''; }
      });
      review.checks = checks;
      review.stats = stats;
      review.mode = raw ? 'live' : 'demo';
      s.stage = 4;
      return { review: review, transcript: s.transcript };
    }
  };

  function keywordCheck(key, mine) {
    var text = mine.map(function (m) { return m.text || ''; }).join(' ');
    var has = function (arr) { return arr.some(function (w) { return text.indexOf(w) >= 0; }); };
    var numCount = (text.match(/\d+(?:\.\d+)?%?/g) || []).length;

    switch (key) {
      case 'direction':   // 首选 + 备选 + 理由
        return has(['首选', '备选', '第一选择', '如果不行', '退一步', '我会选']) && has(['因为', '理由', '原因']);
      case 'why':         // 讲为什么，不只是做了什么
        return has(['为什么', '考虑到', '原因是', '当时想', '判断']) && has(['做', '负责', '落地']);
      case 'number':
        return numCount >= 3;
      case 'redo':
        return has(['重来', '如果再做', '下次', '事后看', '复盘']);
      case 'compare':
        return has(['机制', '模式', '逻辑', '本质', '底层', '供给', '履约', '分发']);
      case 'tough':
        return has(['能接受', '没问题', '可以', '愿意']) && text.indexOf('但是') < 0;
      case 'length':      // 单题控制在 60~90 秒，约 120~260 字
        var avgLen = mine.length ? mine.reduce(function (a, m) { return a + (m.text || '').length; }, 0) / mine.length : 0;
        return mine.length > 0 && avgLen <= 260;
      case 'ask':
        return has(['想请教', '想了解', '请问', '团队', '岗位', '你们现在']);
      default:
        return null;
    }
  }

  function demoReview(stats, mineCount) {
    var n = mineCount || stats.turns;
    var my = (stats.mine || []).join(' ');
    var has = function (ws) { return ws.some(function (w) { return my.indexOf(w) >= 0; }); };

    var structure = 4 + (has(['框架', '拆', '先定', '三层', '分几']) ? 2 : 0) + (n >= 3 ? 1 : 0);
    var insight   = 4 + (has(['因为', '我的判断', '不同意', '我建议']) ? 2 : 0) + (has(['%', '从', '提到']) ? 1 : 0);
    var collab    = 3 + (has(['你怎么看', '你觉得', '同意你', '接着', '补充']) ? 2 : 0) + (stats.share >= 15 && stats.share <= 40 ? 2 : 0);
    var resil     = 4 + (has(['不同意', '但我觉得', '换个角度', '不过']) ? 2 : 0);
    var part      = 3 + Math.min(4, n) + (stats.share >= 12 ? 1 : 0);
    var cap = function (v) { return Math.max(2, Math.min(9, Math.round(v))); };

    var scores = {
      structure: cap(structure),
      insight: cap(insight),
      collaboration: cap(collab),
      resilience: cap(resil),
      participation: cap(part)
    };

    var hl = [];
    if (n === 0) hl.push('全程没有发言，本场无法评估你的表达。');
    else {
      hl.push('本场开口 ' + n + ' 次，占非主持人发言 ' + stats.share + '%，至少没有变成旁观者。');
      if (has(['框架', '拆', '先定'])) hl.push('给出了可被团队沿用的结构，这类发言在群面里权重最高。');
      if (has(['%', '指标', '率'])) hl.push('用了指标语言，比纯观点更容易被面试官记住。');
      if (has(['你怎么看', '你觉得'])) hl.push('有把话头递给别人，协作信号明确。');
    }
    if (hl.length === 1) hl.push('发言里有自己的判断，不是单纯复述别人。');

    var wk = [];
    if (stats.share < 12) wk.push('发言偏少（' + stats.share + '%），存在感不足，容易被当成旁观者，先争取一次框架发言。');
    else if (stats.share > 45) wk.push('发言占比偏高（' + stats.share + '%），挤压了队友空间，群面会扣"协作"。');
    if (!has(['框架', '拆', '先定'])) wk.push('没有主动抢结构，框架是别人给的，你的贡献变成了"补充"。');
    if (!has(['%', '指标', '率'])) wk.push('结论后面缺数字或标准，听起来像感受而不是判断。');
    if (!has(['你怎么看', '你觉得', '同意'])) wk.push('几乎没承接别人，互动少，像在独白。');
    if (!wk.length) wk.push('整体结构完整，下一步是把结论压到 20 秒内讲完。');

    return {
      scores: scores,
      highlights: hl,
      weaknesses: wk,
      suggestions: [
        '开场 30 秒内主动给出拆分框架：先定什么 → 再看什么 → 最后收什么，抢到结构就赢了一半。',
        '承接别人时补一句增量（"在你这点上我加一个约束"），不要只说"我同意"。',
        '每条结论后面挂一个数字或标准，否则等于没证据。',
        '最后 2 分钟主动总结收口，把共识和分歧分开讲，结束前留一句给面试官的抓手。'
      ],
      peer_review: '本场 AI 考生里强势的那位会先抢框架。建议你比他早 10 秒给结构，后面用指标收口，逼他跟着你的框架走。',
      one_line: n === 0 ? '全程没开口，这一场等于没参加' : (stats.share < 12 ? '有参与，缺结构' : '有结构，收口还能更狠'),
      demo: true
    };
  }

  /* ---------------- 拦截层：把 fetch 换成走本地引擎 ---------------- */
  var BASE = location.pathname.replace(/\/[^/]*$/, '/');

  /* 页面主脚本可能在 DOMContentLoaded 之前就发出 /api/meta，
     所以数据用同步 XHR 提前取好，fetch 立刻装上，不等 DOM 就绪。 */
  function loadJSON(url) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', url, false);           // 同步：只为在页面脚本跑之前拿到数据
      x.send(null);
      if (x.status >= 200 && x.status < 300) return JSON.parse(x.responseText);
    } catch (e) {}
    return null;
  }

  function installFetch() {
    if (!window.fetch) return false;
    var origFetch = window.fetch.bind(window);

    window.fetch = async function (input, init) {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      var path = url.replace(/^https?:\/\/[^/]+/, '').replace(BASE, '/').split('?')[0];
      if (path.indexOf('/api/') === 0 && ROUTES[path]) {
        var body = {};
        try { body = init && init.body ? JSON.parse(init.body) : {}; } catch (e) {}
        await new Promise(function (r) { setTimeout(r, 120); });   // 给 UI 一点"思考"节奏
        var data;
        try { data = await ROUTES[path](body); }
        catch (e) { data = { error: '本地引擎出错：' + e.message }; }
        return new Response(JSON.stringify(data), {
          status: data && data.error && path !== '/api/chat' ? 400 : 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      return origFetch(input, init);
    };
    return true;
  }

  /* 数据用同步 XHR 取，紧接着装 fetch —— 必须在页面 boot() 之前完成 */
  META = loadJSON(BASE + 'meta.json') || {};
  P = loadJSON(BASE + 'prompts.json') || {};
  var READY = !!(META && META.topics && META.topics.length);

  if (READY && installFetch()) {
    /* 先自己试着解锁一遍：auto 模式直接内置口令，成功就静默进直连模式；
       只有失败（口令改了/浏览器不支持 crypto）才弹框，并可回退固定剧本。 */
    if (PASS_MODE === 'auto') {
      decodeCfg().then(function () {
        try { sessionStorage.setItem(LS_PASS, DEFAULT_PASS); } catch (e) {}
        readyResolve(true);
        console.log('[模拟考场] 已自动解锁，AI 直连模式（会消耗 API 额度）');
        if (window.ROOM_LOCAL && window.ROOM_LOCAL.onUnlock) try { window.ROOM_LOCAL.onUnlock(); } catch (e) {}
      }).catch(function (err) {
        readyResolve(false);
        console.warn('[模拟考场] 自动解锁失败：', err && err.message);
        if (document.readyState === 'loading') {
          document.addEventListener('DOMContentLoaded', function () { gate('自动解锁没成功（口令可能改过了），输一次就行。'); });
        } else gate('自动解锁没成功（口令可能改过了），输一次就行。');
      });
    } else {
      var saved = '';
      try { saved = sessionStorage.getItem(LS_PASS) || localStorage.getItem(LS_PASS) || ''; } catch (e) {}
      if (saved) decodeCfg().then(function () { readyResolve(true); }).catch(function () { readyResolve(false); gate(); });
      else {
        readyResolve(false);
        if (!sessionStorage.getItem('ivpGateSkipped')) {
          if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { gate(); });
          else gate();
        }
      }
    }
    document.addEventListener('click', function once() {
      if (!CFG) { try { sessionStorage.setItem('ivpGateSkipped', '1'); } catch (e) {} }
      document.removeEventListener('click', once);
    }, { once: true });

    console.log('[模拟考场] 本地引擎已接管，接口走浏览器内实现');
  } else {
    readyResolve(false);
    console.warn('[模拟考场] 没读到 meta.json，走真实后端');
  }

  /* ---------------- 口令闸门（没有口令就只跑本地剧本） ---------------- */
  function gate(msg) {
    var el = document.createElement('div');
    el.id = 'roomGate';
    el.style.cssText = 'position:fixed;inset:0;background:rgba(8,10,7,.72);z-index:2147483000;' +
      'display:flex;align-items:center;justify-content:center;padding:20px;backdrop-filter:blur(3px)';
    el.innerHTML =
      '<div style="background:#1a1c17;border:1px solid #2c302a;border-radius:14px;max-width:380px;width:100%;' +
      'padding:22px;box-shadow:0 24px 60px rgba(0,0,0,.5);color:#ecefe7;font-family:inherit">' +
      '<h3 style="margin:0 0 8px;font-size:16.5px">解锁 AI 模拟</h3>' +
      '<p style="margin:0 0 14px;font-size:12.5px;color:#9aa093;line-height:1.7">' +
      (msg || '模型 Key 是加密存的，口令对了才能和 AI 面试官对话。') +
      '<br>不输也能进，但只能用本地剧本（台词固定、不会接住你的话）。</p>' +
      '<input id="rgIn" type="password" placeholder="口令" autocomplete="current-password" ' +
      'style="width:100%;box-sizing:border-box;background:#212420;border:1px solid #2c302a;border-radius:9px;' +
      'padding:11px 12px;font-size:16px;color:#ecefe7;font-family:inherit;outline:none">' +
      '<div id="rgMsg" style="font-size:12px;color:#c9755f;min-height:17px;margin-top:6px"></div>' +
      '<div style="display:flex;gap:9px;margin-top:4px">' +
      '<button id="rgOk" style="flex:1;background:#8aa892;color:#12130f;border:none;border-radius:9px;' +
      'padding:11px;font-size:14px;font-weight:700;cursor:pointer;font-family:inherit">解锁</button>' +
      '<button id="rgSkip" style="background:#212420;color:#9aa093;border:1px solid #2c302a;border-radius:9px;' +
      'padding:11px 15px;font-size:13.5px;cursor:pointer;font-family:inherit">先用本地的</button></div></div>';
    document.body.appendChild(el);

    var inp = el.querySelector('#rgIn'), msgEl = el.querySelector('#rgMsg'), ok = el.querySelector('#rgOk');
    el.querySelector('#rgSkip').onclick = function () { el.remove(); };
    async function go() {
      var pass = (inp.value || '').trim();
      if (!pass) { msgEl.textContent = '先输口令'; return; }
      ok.disabled = true; ok.textContent = '验证中…';
      try {
        await decodeCfg(pass);
        try { sessionStorage.setItem(LS_PASS, pass); } catch (e) {}
        el.remove();
        location.reload();
      } catch (e) {
        msgEl.textContent = e.code === 'PASS' ? '口令不对，再试一次' : ('解密失败：' + e.message);
        ok.disabled = false; ok.textContent = '解锁';
        inp.select();
      }
    }
    ok.onclick = go;
    inp.onkeydown = function (e) { if (e.key === 'Enter') go(); };
    setTimeout(function () { inp.focus(); }, 100);
  }

  window.ROOM_LOCAL = {
    ready: READY_P,                 // Promise<boolean>：自动解锁是否成功
    passMode: PASS_MODE,
    unlock: decodeCfg,
    routes: ROUTES,
    gate: gate,
    unlocked: function () { return !!CFG; },
    onUnlock: null                  // 页面自己挂：解锁成功后重绘状态胶囊
  };
})();
