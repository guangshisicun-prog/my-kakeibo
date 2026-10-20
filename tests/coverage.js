// カバレッジ（テストで、アプリのプログラムのどこが実行されたか）を数える
// test.html?coverage を開いたときだけ動く。
// アプリのプログラムを読みとって、「文」「関数」「分かれ道（if や ? :）」の前に数を数える印を入れてから動かす。

window.COVERAGE = new URLSearchParams(location.search).has('coverage');
window.__cov = { s: [], f: [], b: [] };
const covMeta = { s: [], f: [], b: [], lineOffset: 0, htmlLines: [] };

function instrumentApp(html) {
  const start = html.indexOf('<script>') + '<script>'.length;
  const end = html.indexOf('</script>', start);
  const code = html.slice(start, end);
  covMeta.lineOffset = html.slice(0, start).split('\n').length - 1;
  covMeta.htmlLines = html.split('\n');

  const ast = acorn.parse(code, { ecmaVersion: 'latest', locations: true });
  const ins = []; // { pos, text, close, size }
  const add = (pos, text, close, size) => ins.push({ pos, text, close, size });
  const line = (n) => n.loc.start.line;

  const newStmt = (n) => covMeta.s.push({ line: line(n) }) - 1;
  // ブロックでない文（if (x) return; など）は { } でかこんでから印を入れる
  function wrapStatement(child, extra = '') {
    if (child.type === 'BlockStatement') {
      if (extra) add(child.start + 1, extra, false, Infinity);
      return;
    }
    const sid = newStmt(child);
    add(child.start, `{${extra}__cov.s[${sid}]++;`, false, child.end - child.start);
    add(child.end, '}', true, child.end - child.start);
  }

  function walk(node) {
    if (!node || typeof node.type !== 'string') return;

    if (/Function/.test(node.type)) {
      const fid = covMeta.f.push({ line: line(node), name: (node.id && node.id.name) || '（名前なし）' }) - 1;
      if (node.body.type === 'BlockStatement') {
        add(node.body.start + 1, `__cov.f[${fid}]++;`, false, Infinity);
      } else {
        const size = node.body.end - node.body.start;
        add(node.body.start, `(__cov.f[${fid}]++, `, false, size + 0.5);
        add(node.body.end, ')', true, size + 0.5);
      }
    }

    const bodies = node.type === 'Program' || node.type === 'BlockStatement' ? node.body
      : node.type === 'SwitchCase' ? node.consequent : null;
    if (bodies) {
      for (const st of bodies) add(st.start, `__cov.s[${newStmt(st)}]++;`, false, st.end - st.start);
    }

    if (node.type === 'IfStatement') {
      const bid = covMeta.b.push({ line: line(node), kind: 'if' }) - 1;
      wrapStatement(node.consequent, `__cov.b[${bid}][0]++;`);
      if (node.alternate) wrapStatement(node.alternate, `__cov.b[${bid}][1]++;`);
      // else は、この if を外からかこむ } よりも先に入れる
      else add(node.end, ` else {__cov.b[${bid}][1]++;}`, true, node.end - node.start - 0.25);
    } else if (/^(For|ForIn|ForOf|While|DoWhile)Statement$/.test(node.type)) {
      wrapStatement(node.body);
    } else if (node.type === 'ConditionalExpression') {
      const bid = covMeta.b.push({ line: line(node), kind: '? :' }) - 1;
      for (const [k, arm] of [[0, node.consequent], [1, node.alternate]]) {
        const size = arm.end - arm.start;
        add(arm.start, `(__cov.b[${bid}][${k}]++, `, false, size + 0.5);
        add(arm.end, ')', true, size + 0.5);
      }
    }

    for (const key of Object.keys(node)) {
      if (key === 'loc') continue;
      const v = node[key];
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v.type === 'string') walk(v);
    }
  }
  walk(ast);

  // 同じ場所に入れる印の順番：閉じるもの（内側から）→ 開くもの（外側から）
  ins.sort((a, b) => a.pos - b.pos || (a.close === b.close ? (a.close ? a.size - b.size : b.size - a.size) : a.close ? -1 : 1));
  let outCode = '';
  let last = 0;
  for (const it of ins) { outCode += code.slice(last, it.pos) + it.text; last = it.pos; }
  outCode += code.slice(last);

  window.__cov.s = new Array(covMeta.s.length).fill(0);
  window.__cov.f = new Array(covMeta.f.length).fill(0);
  window.__cov.b = covMeta.b.map(() => [0, 0]);
  return html.slice(0, start) + 'const __cov = window.parent.__cov;\n' + outCode + html.slice(end);
}

function coverageReport() {
  const c = window.__cov;
  const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 100);
  const sHit = c.s.filter((n) => n > 0).length;
  const fHit = c.f.filter((n) => n > 0).length;
  const arms = c.b.flat();
  const bHit = arms.filter((n) => n > 0).length;
  const htmlLine = (l) => l + covMeta.lineOffset;
  const codeAt = (l) => (covMeta.htmlLines[htmlLine(l) - 1] || '').trim().slice(0, 90);

  // 動かなかったところを、行ごとにまとめる
  const miss = {};
  const note = (l, what) => { (miss[l] = miss[l] || new Set()).add(what); };
  c.s.forEach((n, i) => { if (!n) note(covMeta.s[i].line, '文'); });
  c.f.forEach((n, i) => { if (!n) note(covMeta.f[i].line, `関数 ${covMeta.f[i].name}`); });
  c.b.forEach(([y, n], i) => {
    const k = covMeta.b[i].kind;
    if (!y) note(covMeta.b[i].line, `${k} の「はい」側`);
    if (!n) note(covMeta.b[i].line, `${k} の「いいえ」側`);
  });
  const uncovered = Object.keys(miss).map(Number).sort((a, b) => a - b)
    .map((l) => ({ line: htmlLine(l), what: [...miss[l]].join('・'), code: codeAt(l) }));

  return {
    statements: { hit: sHit, total: c.s.length, pct: pct(sHit, c.s.length) },
    functions: { hit: fHit, total: c.f.length, pct: pct(fHit, c.f.length) },
    branches: { hit: bHit, total: arms.length, pct: pct(bHit, arms.length) },
    uncovered,
  };
}

function showCoverage(el) {
  const r = coverageReport();
  window.__coverage = r;
  el.hidden = false;
  el.innerHTML = `<h2>📏 カバレッジ（テストで動いたプログラムの割合）</h2>
    <div class="t">文（1つ1つの命令）：<b>${r.statements.pct}%</b>（${r.statements.hit} / ${r.statements.total}）</div>
    <div class="t">関数（ひとまとまりの処理）：<b>${r.functions.pct}%</b>（${r.functions.hit} / ${r.functions.total}）</div>
    <div class="t">分かれ道（if や ? : の両方の行き先）：<b>${r.branches.pct}%</b>（${r.branches.hit} / ${r.branches.total}）</div>
    <h2 style="margin-top:14px">テストで一度も動かなかったところ（${r.uncovered.length}行）</h2>
    <div id="cov-miss"></div>`;
  const box = el.querySelector('#cov-miss');
  for (const u of r.uncovered) {
    const row = document.createElement('div');
    row.className = 't';
    row.innerHTML = `<b>${u.line}行目</b>　<span class="muted"></span><div class="code"></div>`;
    row.querySelector('.muted').textContent = u.what;
    row.querySelector('.code').textContent = u.code;
    box.appendChild(row);
  }
}
