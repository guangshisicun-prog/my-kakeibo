// 家計簿アプリのテスト
// アプリ（../index.html）を画面の中の小窓で開いて、「今日」を決まった日にしてから操作し、結果をたしかめる。
// ほんとうのデータを消さないように、テストの前にとっておいて、最後に元にもどす。

const KEY = 'kakeibo-data-v1';
const groups = [];
let current = null;
function group(name, fn) { current = { name, tests: [] }; groups.push(current); fn(); }
function test(name, fn) { current.tests.push({ name, fn }); }

// ---- たしかめる道具 ----
class Fail extends Error {}
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Fail(`${msg || ''}\n  期待: ${e}\n  実際: ${a}`);
}
function ok(cond, msg) { if (!cond) throw new Fail(msg || '条件が成り立っていません'); }

// ---- アプリを開く ----
let appSource = null;
async function loadApp({ today = '2026-10-20', data, keep = false } = {}) {
  if (!appSource) {
    const src = await (await fetch('../index.html', { cache: 'no-store' })).text();
    appSource = window.COVERAGE ? instrumentApp(src) : src; // カバレッジを測るときは、数える印を入れる
  }
  if (!keep) {
    if (data) localStorage.setItem(KEY, JSON.stringify(data));
    else localStorage.removeItem(KEY);
  }
  const [y, m, d] = today.split('-').map(Number);
  // 「今日」を決まった日にする／確認ダイアログには自動で答える
  const mock = `<script>(() => {
    const F = new Date(${y}, ${m - 1}, ${d}, 12, 0, 0).getTime();
    const R = Date;
    class D extends R { constructor(...a) { if (a.length) super(...a); else super(F); } static now() { return F; } }
    window.Date = D;
    window.__dialogs = [];
    window.__confirmAnswer = true;
    window.__promptAnswer = undefined;
    window.confirm = (msg) => { __dialogs.push(msg); return window.__confirmAnswer; };
    window.prompt = (msg, def) => { __dialogs.push(msg); return window.__promptAnswer !== undefined ? window.__promptAnswer : def; };
    window.__errors = [];
    window.addEventListener('error', (e) => __errors.push(e.message));
  })();<\/script>`;
  const frame = document.getElementById('app');
  await new Promise((res) => { frame.onload = res; frame.srcdoc = appSource.replace('<head>', '<head>' + mock); });
  const w = frame.contentWindow;
  const app = {
    w,
    ev: (expr) => w.eval(expr),
    q: (sel) => w.document.querySelector(sel),
    qa: (sel) => [...w.document.querySelectorAll(sel)],
    text: (sel) => w.document.querySelector(sel).innerText,
    click(sel) {
      const el = typeof sel === 'string' ? w.document.querySelector(sel) : sel;
      if (!el) throw new Fail(`ボタンが見つかりません: ${sel}`);
      el.click();
    },
    set(sel, val) {
      const el = w.document.querySelector(sel);
      if (!el) throw new Fail(`入力欄が見つかりません: ${sel}`);
      if (el.type === 'checkbox') el.checked = val; else el.value = val;
      el.dispatchEvent(new w.Event('input', { bubbles: true }));
    },
    tab(name) { app.click(`nav [data-page="${name}"]`); },
    data: () => JSON.parse(JSON.stringify(w.eval('data'))),
    entries: (pred = () => true) => app.data().entries.filter(pred),
    auto: (prefix) => app.data().entries.filter((e) => e.autoKey && e.autoKey.startsWith(prefix)),
    toast: () => w.document.querySelector('#toast').textContent,
  };
  return app;
}

// ---- テスト用のデータ ----
const job = (o = {}) => Object.assign({ id: 'j1', name: 'カフェ', wage: 1100, transport: 0, breakMin: 0, night: false, closing: 31, offset: 1, payday: 25 }, o);
const base = (o = {}) => Object.assign({
  since: '2026-08-01',
  initial: { bank: 100000, paypay: 0, cash: 5000 },
  entries: [], budgets: {}, jobs: [job()], shifts: [],
  card: { set: true, closing: 15, offset: 1, payday: 10 },
  subs: [], skipped: [],
}, o);
const shift = (date, start = '10:00', end = '15:00', jobId = 'j1') => ({ id: 's' + date + start, jobId, date, start, end });
const out = (date, amount, method = 'cash', category = '食費') => ({ id: 'e' + Math.random(), type: 'out', date, amount, method, category, memo: '' });

// =====================================================================
group('お給料の計算', () => {
  const pay = async (s, j) => (await loadApp()).ev(`shiftPay(${JSON.stringify(s)}, ${JSON.stringify(j)})`);
  test('ふつうのシフト（10時〜15時・時給1,100円）は5,500円', async () => {
    eq(await pay(shift('2026-10-01'), job()), 5500);
  });
  test('休憩60分・交通費300円を反映する', async () => {
    eq(await pay(shift('2026-10-01'), job({ breakMin: 60, transport: 300 })), 4700);
  });
  test('22時以降は25%アップ（18時〜23時・休憩60分・交通費300円 → 4,975円）', async () => {
    eq(await pay(shift('2026-10-01', '18:00', '23:00'), job({ breakMin: 60, transport: 300, night: true })), 4975);
  });
  test('日をまたぐシフト（22時〜翌2時）は4時間ぜんぶ深夜', async () => {
    eq(await pay(shift('2026-10-01', '22:00', '02:00'), job({ night: true })), 5500);
  });
  test('朝4時〜6時は、5時までの1時間だけ深夜', async () => {
    eq(await pay(shift('2026-10-01', '04:00', '06:00'), job({ night: true })), 2475);
  });
  test('深夜割増なしのバイト先は、夜でも時給そのまま', async () => {
    eq(await pay(shift('2026-10-01', '22:00', '02:00'), job()), 4400);
  });
  test('休憩が深夜の時間にかかっていても、割増は働いた時間をこえない', async () => {
    // 22時〜23時（1時間）で休憩60分 → 働いた時間0なので0円
    eq(await pay(shift('2026-10-01', '22:00', '23:00'), job({ night: true, breakMin: 60 })), 0);
  });
});

// =====================================================================
group('締め日と支払日', () => {
  const pd = async (date, rule) => (await loadApp()).ev(`payDateOf('${date}', ${JSON.stringify(rule)})`);
  test('月末締め・翌月25日払い：8月31日 → 9月25日', async () => {
    eq(await pd('2026-08-31', { closing: 31, offset: 1, payday: 25 }), '2026-09-25');
  });
  test('年をまたぐ：12月10日 → 次の年の1月25日', async () => {
    eq(await pd('2026-12-10', { closing: 31, offset: 1, payday: 25 }), '2027-01-25');
  });
  test('15日締め・翌月10日払い：15日はその月の締めに入る', async () => {
    eq(await pd('2026-09-15', { closing: 15, offset: 1, payday: 10 }), '2026-10-10');
  });
  test('15日締め・翌月10日払い：16日は次の締めに入る', async () => {
    eq(await pd('2026-09-16', { closing: 15, offset: 1, payday: 10 }), '2026-11-10');
  });
  test('月末払い：2月は28日になる', async () => {
    eq(await pd('2026-01-20', { closing: 31, offset: 1, payday: 31 }), '2026-02-28');
  });
  test('30日締めでも、2月28日は2月の締めに入る', async () => {
    eq(await pd('2026-02-28', { closing: 30, offset: 1, payday: 25 }), '2026-03-25');
  });
  test('15日締め・12月16日 → 次の締めは1月 → 翌月の2月10日', async () => {
    eq(await pd('2026-12-16', { closing: 15, offset: 1, payday: 10 }), '2027-02-10');
  });
});

// =====================================================================
group('残高', () => {
  test('はらい方ごとに、正しい口座から減る（クレカは減らない）', async () => {
    const app = await loadApp({ data: base({ card: { set: false, closing: 15, offset: 1, payday: 10 }, entries: [
      out('2026-10-01', 800, 'cash'), out('2026-10-01', 1500, 'paypay'), out('2026-10-01', 3000, 'card'), out('2026-10-01', 7000, 'bankdebit'),
    ] }) });
    eq([app.ev("balance('bank')"), app.ev("balance('paypay')"), app.ev("balance('cash')")], [93000, -1500, 4200]);
  });
  test('移動・残高合わせ・入金が反映される', async () => {
    const app = await loadApp({ data: base({ entries: [
      { id: 'm', type: 'move', from: 'bank', to: 'cash', amount: 10000, date: '2026-10-02' },
      { id: 'a', type: 'adjust', account: 'cash', amount: -200, date: '2026-10-03' },
      { id: 'i', type: 'in', account: 'paypay', amount: 500, category: 'その他', date: '2026-10-04' },
    ] }) });
    eq([app.ev("balance('bank')"), app.ev("balance('paypay')"), app.ev("balance('cash')")], [90000, 500, 14800]);
  });
  test('「合わせる」で、ほんとうの残高に合わせられる', async () => {
    const app = await loadApp({ data: base() });
    app.w.__promptAnswer = '4321';
    app.click('[data-adjust="cash"]');
    eq(app.ev("balance('cash')"), 4321);
  });
});

// =====================================================================
group('お給料の自動記録', () => {
  test('過ぎた給料日のお給料が、銀行に1回だけ記録される', async () => {
    const app = await loadApp({ data: base({ shifts: [shift('2026-08-05')] }) });
    app.tab('review'); app.tab('home'); // 何回か表示しなおしても…
    const pays = app.auto('pay:');
    eq(pays.length, 1, '記録の数');
    eq([pays[0].date, pays[0].amount, pays[0].account], ['2026-09-25', 5500, 'bank']);
    eq(app.ev("balance('bank')"), 105500);
  });
  test('アプリを開きなおしても、ふえない', async () => {
    await loadApp({ data: base({ shifts: [shift('2026-08-05')] }) });
    const app = await loadApp({ keep: true });
    eq(app.auto('pay:').length, 1);
  });
  test('まだ来ていない給料日は記録しない（見込みには出る）', async () => {
    const app = await loadApp({ data: base({ shifts: [shift('2026-10-03')] }) });
    eq(app.auto('pay:').length, 0);
    const f = app.ev("forecast('2026-11')");
    eq([f.pays.length, f.pays[0].amount, f.pays[0].done], [1, 5500, false]);
  });
  test('給料日が来たら（次の日に開いたら）記録される', async () => {
    await loadApp({ data: base({ shifts: [shift('2026-10-03')] }) });
    const app = await loadApp({ keep: true, today: '2026-11-26' });
    eq(app.auto('pay:').map((e) => e.date), ['2026-11-25']);
  });
  test('「記録をつけ始めた日」より前の給料日は記録しない', async () => {
    const app = await loadApp({ data: base({ since: '2026-10-01', shifts: [shift('2026-08-05')] }) });
    eq(app.auto('pay:').length, 0);
  });
  test('カレンダーからシフトを足すと、記録ずみのお給料も増える', async () => {
    const app = await loadApp({ data: base({ shifts: [shift('2026-08-05')] }) });
    app.tab('cal');
    app.click('#page-cal .month button[data-move="-1"]');
    app.click('#page-cal .month button[data-move="-1"]');
    app.click('[data-date="2026-08-06"]');
    app.set('#s-start', '10:00'); app.set('#s-end', '15:00');
    app.click('#s-save');
    eq(app.auto('pay:').map((e) => e.amount), [11000]);
  });
  test('自分で直した金額は、シフトを足しても書きかえられない', async () => {
    const app = await loadApp({ data: base({ shifts: [shift('2026-08-05')] }) });
    app.tab('review');
    app.click('#review-toggle [data-view="list"]');
    app.click('#page-review .month button[data-move="-1"]');
    app.w.__promptAnswer = '5000';
    app.click(app.qa('#entry-list [data-edit]')[0]);
    app.w.__promptAnswer = undefined;
    app.ev(`data.shifts.push(${JSON.stringify(shift('2026-08-06'))}); render();`);
    const p = app.auto('pay:')[0];
    eq([p.amount, p.edited], [5000, true]);
  });
  test('自動記録を消したら、もう一度つくられない', async () => {
    const app = await loadApp({ data: base({ shifts: [shift('2026-08-05')] }) });
    app.tab('review');
    app.click('#review-toggle [data-view="list"]');
    app.click('#page-review .month button[data-move="-1"]');
    app.click(app.qa('#entry-list [data-del]')[0]);
    const again = await loadApp({ keep: true });
    eq(again.auto('pay:').length, 0);
  });
  test('シフトを全部消すと、直していない自動のお給料も消える', async () => {
    const app = await loadApp({ data: base({ shifts: [shift('2026-08-05')] }) });
    app.ev("data.shifts = []; render();");
    eq(app.auto('pay:').length, 0);
  });
  test('バイト先を消しても、記録ずみのお給料は残る', async () => {
    const app = await loadApp({ data: base({ shifts: [shift('2026-08-05')] }) });
    app.tab('settings');
    app.click('[data-edit-job="j1"]');
    app.click('#j-cancel');
    eq([app.data().jobs.length, app.auto('pay:').length], [0, 1]);
  });
});

// =====================================================================
group('クレカの引き落とし', () => {
  const cardData = () => base({ entries: [out('2026-09-01', 3000, 'card'), out('2026-09-15', 2000, 'card'), out('2026-09-16', 1000, 'card')] });
  test('締め日までの合計が、支払日に銀行から引かれる', async () => {
    const app = await loadApp({ data: cardData() });
    const cp = app.auto('card:');
    eq(cp.map((e) => [e.date, e.amount, e.type]), [['2026-10-10', 5000, 'cardpay']]);
    eq(app.ev("balance('bank')"), 95000);
  });
  test('引き落としは「支出」として2回数えない', async () => {
    const app = await loadApp({ data: cardData() });
    // 10月の支出は0円、9月の支出は6,000円
    eq(app.text('#sum-out'), '¥0');
    app.click('#page-home .month button[data-move="-1"]');
    eq(app.text('#sum-out'), '¥6,000');
  });
  test('16日以降の分は、次の支払日の見込みに出る', async () => {
    const app = await loadApp({ data: cardData() });
    const f = app.ev("forecast('2026-11')");
    eq(f.debits.map((x) => [x.date, x.amount, x.done]), [['2026-11-10', 1000, false]]);
  });
  test('クレカの設定がないときは、引き落としを記録しない', async () => {
    const d = cardData(); d.card.set = false;
    const app = await loadApp({ data: d });
    eq(app.auto('card:').length, 0);
  });
  test('設定画面でクレカを設定すると、引き落としが記録される', async () => {
    const d = cardData(); d.card = { set: false, closing: 31, offset: 1, payday: 27 };
    const app = await loadApp({ data: d });
    app.tab('settings');
    app.set('#c-closing', '15'); app.set('#c-offset', '1'); app.set('#c-payday', '10');
    app.click('#c-save');
    eq(app.auto('card:').map((e) => e.amount), [5000]);
  });
});

// =====================================================================
group('毎月の定額支出（サブスク）', () => {
  const sub = (o = {}) => Object.assign({ id: 'u1', name: '家賃', amount: 50000, day: 27, method: 'bankdebit', category: 'その他', from: '2026-08-01' }, o);
  test('過ぎた月の分が、毎月1回ずつ記録される', async () => {
    const app = await loadApp({ data: base({ subs: [sub()] }) });
    eq(app.auto('sub:').map((e) => e.date), ['2026-08-27', '2026-09-27']);
    eq(app.ev("balance('bank')"), 0);
  });
  test('31日にしたら、30日までの月は月末に記録される', async () => {
    const app = await loadApp({ data: base({ subs: [sub({ day: 31, amount: 1000 })] }) });
    eq(app.auto('sub:').map((e) => e.date), ['2026-08-31', '2026-09-30']);
  });
  test('登録した日より前の分は記録しない', async () => {
    const app = await loadApp({ data: base({ subs: [sub({ from: '2026-09-28' })] }) });
    eq(app.auto('sub:').length, 0);
  });
  test('次の月に開くと、その月の分がふえる（重ならない）', async () => {
    await loadApp({ data: base({ subs: [sub()] }) });
    const app = await loadApp({ keep: true, today: '2026-10-28' });
    eq(app.auto('sub:').map((e) => e.date), ['2026-08-27', '2026-09-27', '2026-10-27']);
  });
  test('金額を変えても、これまでの記録はそのまま', async () => {
    const app = await loadApp({ data: base({ subs: [sub()] }) });
    app.tab('settings');
    app.click('[data-edit-sub="u1"]');
    app.set('#u-amount', '55000');
    app.click('#u-save');
    eq(app.auto('sub:').map((e) => e.amount), [50000, 50000]);
  });
  test('やめても、これまでの記録は残る', async () => {
    const app = await loadApp({ data: base({ subs: [sub()] }) });
    app.tab('settings');
    app.click('[data-edit-sub="u1"]');
    app.click('#u-cancel');
    eq([app.data().subs.length, app.auto('sub:').length], [0, 2]);
  });
  test('クレカ払いのサブスクは、クレカの引き落としに入る', async () => {
    const app = await loadApp({ data: base({ subs: [sub({ name: 'Netflix', amount: 1490, day: 5, method: 'card', category: '趣味' })] }) });
    // 8/5・9/5 の分 → 9/10・10/10 に引き落とし
    eq(app.auto('card:').map((e) => [e.date, e.amount]), [['2026-09-10', 1490], ['2026-10-10', 1490]]);
  });
  test('設定画面から登録すると、登録した日から始まる', async () => {
    const app = await loadApp({ data: base() });
    app.tab('settings');
    app.click('#sub-new');
    app.set('#u-name', 'ジム'); app.set('#u-amount', '3000'); app.set('#u-day', '5'); app.set('#u-method', 'bankdebit');
    app.click('#u-save');
    eq(app.data().subs[0].from, '2026-10-20');
    eq(app.auto('sub:').length, 0);
    const f = app.ev("forecast('2026-11')");
    eq(f.debits.map((x) => [x.label, x.date]), [['ジム', '2026-11-05']]);
  });
});

// =====================================================================
group('今月の見込み', () => {
  test('月末の銀行残高の予想 ＝ いまの残高 ＋ これからのお給料 − これからの引き落とし', async () => {
    const app = await loadApp({ data: base({
      shifts: [shift('2026-09-10')], // 10/25 に 5,500円（まだ）
      entries: [out('2026-09-01', 3000, 'card')], // 10/10 に引き落とし（記録ずみ）
      subs: [{ id: 'u1', name: '家賃', amount: 50000, day: 27, method: 'bankdebit', category: 'その他', from: '2026-10-01' }], // 10/27（まだ）
    }) });
    eq(app.ev("balance('bank')"), 97000);
    const html = app.text('#home-forecast');
    ok(html.includes('¥52,500'), `予想 ¥52,500 が表示されていません\n${html}`);
  });
});

// =====================================================================
group('記録の画面', () => {
  test('PayPayで払った支出を記録できる', async () => {
    const app = await loadApp({ data: base() });
    app.tab('add');
    app.set('#f-amount', '800');
    app.click('#f-method [data-id="paypay"]');
    app.click('#f-save');
    const e = app.entries((x) => x.type === 'out')[0];
    eq([e.amount, e.method, e.category, e.date], [800, 'paypay', '食費', '2026-10-20']);
    eq(app.q('#f-amount').value, '', '記録したら金額欄が空になる');
  });
  test('金額が空のときは記録しない', async () => {
    const app = await loadApp({ data: base() });
    app.tab('add');
    app.click('#f-save');
    eq(app.entries().length, 0);
    eq(app.toast(), '金額を入れてね');
  });
  test('収入を、選んだ口座に入れられる', async () => {
    const app = await loadApp({ data: base() });
    app.tab('add');
    app.click('#add-toggle [data-type="in"]');
    app.click('#f-acct [data-id="cash"]');
    app.click('#f-cats [data-id="仕送り"]');
    app.set('#f-amount', '20000');
    app.click('#f-save');
    eq(app.ev("balance('cash')"), 25000);
    eq(app.entries()[0].category, '仕送り');
  });
  test('移動（銀行 → PayPayにチャージ）を記録できる', async () => {
    const app = await loadApp({ data: base() });
    app.tab('add');
    app.click('#add-toggle [data-type="move"]');
    app.click('#f-from [data-id="bank"]');
    app.click('#f-to [data-id="paypay"]');
    app.set('#f-amount', '3000');
    app.click('#f-save');
    const e = app.entries()[0];
    eq([e.type, e.from, e.to, e.amount, e.category], ['move', 'bank', 'paypay', 3000, undefined]);
    eq([app.ev("balance('bank')"), app.ev("balance('paypay')")], [97000, 3000]);
    eq(app.text('#sum-out'), '¥0', '移動は支出に数えない');
  });
  test('移動で「どこから」と「どこへ」が同じなら記録しない', async () => {
    const app = await loadApp({ data: base() });
    app.tab('add');
    app.click('#add-toggle [data-type="move"]');
    app.click('#f-from [data-id="cash"]');
    app.click('#f-to [data-id="cash"]');
    app.set('#f-amount', '1000');
    app.click('#f-save');
    eq(app.entries().length, 0);
  });
  test('支出→収入→支出と切りかえると、カテゴリが支出のものにもどる', async () => {
    const app = await loadApp({ data: base() });
    app.tab('add');
    app.click('#add-toggle [data-type="in"]');
    app.click('#add-toggle [data-type="out"]');
    app.set('#f-amount', '100');
    app.click('#f-save');
    eq(app.entries()[0].category, '食費');
  });
});

// =====================================================================
group('予算', () => {
  test('予算から支出を引いた「あと使えるお金」が出る', async () => {
    const app = await loadApp({ data: base({ budgets: { '食費': 30000, '趣味': 5000 }, entries: [out('2026-10-05', 1200), out('2026-10-06', 6000, 'cash', '趣味')] }) });
    eq(app.text('#left'), '¥27,800');
    ok(app.text('#budget-list').includes('¥1,000 オーバー'), '趣味のオーバーが出ていません');
  });
  test('設定画面で予算を保存できる', async () => {
    const app = await loadApp({ data: base() });
    app.tab('settings');
    app.set('[data-budget="食費"]', '25000');
    app.click('#b-save');
    eq(app.data().budgets, { '食費': 25000 });
  });
});

// =====================================================================
group('グラフ', () => {
  test('収入と支出のグラフに6か月分の月が並ぶ', async () => {
    const app = await loadApp({ data: base() });
    const labels = app.qa('#chart-bars text').map((t) => t.textContent).filter((t) => t.endsWith('月'));
    eq(labels, ['5月', '6月', '7月', '8月', '9月', '10月']);
  });
  test('支出の内訳の％を足すと、だいたい100％', async () => {
    const app = await loadApp({ data: base({ entries: [out('2026-10-01', 1000), out('2026-10-01', 1000, 'cash', '趣味'), out('2026-10-01', 1000, 'cash', '日用品')] }) });
    const pcts = app.qa('#chart-donut .donut-legend .muted').map((x) => parseInt(x.textContent));
    const total = pcts.reduce((a, b) => a + b, 0);
    ok(total >= 99 && total <= 101, `合計 ${total}%`);
  });
  test('銀行残高のグラフは「記録をつけ始めた月」から', async () => {
    const app = await loadApp({ data: base({ shifts: [shift('2026-08-05')] }) });
    eq(app.qa('#chart-line circle[data-tip]').length, 3);
    ok(app.text('#chart-line').includes('¥105,500'));
  });
  test('グラフをタップすると数字が出る', async () => {
    const app = await loadApp({ data: base() });
    app.qa('#chart-bars [data-tip]')[5].dispatchEvent(new app.w.MouseEvent('click', { bubbles: true }));
    ok(app.text('#chart-bars .chart-info').startsWith('10月　収入'));
  });
  test('支出が0円の月でも、グラフがこわれない', async () => {
    const app = await loadApp({ data: base({ since: '2026-10-01', initial: { bank: 0, paypay: 0, cash: 0 } }) });
    eq(app.w.__errors, []);
    ok(!app.q('#chart-line').innerHTML.includes('NaN'), '残高グラフに NaN（計算できない数）が入っています');
    ok(!app.q('#chart-bars').innerHTML.includes('NaN'), '棒グラフに NaN が入っています');
  });
});

// =====================================================================
group('月の切りかえ・そのほか', () => {
  test('12月の次は、次の年の1月', async () => {
    const app = await loadApp({ today: '2026-12-15', data: base() });
    app.click('#page-home .month button[data-move="1"]');
    eq(app.text('#page-home .month-label'), '2027年1月');
  });
  test('31日に開いて次の月へ進んでも、月がとばない', async () => {
    const app = await loadApp({ today: '2026-10-31', data: base() });
    app.click('#page-home .month button[data-move="1"]');
    eq(app.text('#page-home .month-label'), '2026年11月');
  });
  test('前の版のデータ（はらい方なし）も読みこめる', async () => {
    const app = await loadApp({ data: { entries: [
      { id: 1, type: 'out', amount: 500, category: '食費', date: '2026-10-01', memo: '' },
      { id: 2, type: 'in', amount: 1000, category: 'その他', date: '2026-10-01', memo: '' },
    ], budgets: {} } });
    const es = app.data().entries;
    eq([es[0].method, es[1].account], ['cash', 'bank']);
  });
  test('前の版の「確定したお給料」は、直したもの扱いになる', async () => {
    const app = await loadApp({ data: base({ entries: [{ id: 'p', type: 'in', account: 'bank', category: 'バイト代', amount: 5300, date: '2026-09-25', payKey: 'j1:2026-09-25' }], shifts: [shift('2026-08-05')] }) });
    const p = app.auto('pay:');
    eq(p.map((e) => [e.amount, e.edited]), [[5300, true]]);
  });
  test('名前に記号（<b>など）を入れても、画面がこわれない', async () => {
    const app = await loadApp({ data: base({ jobs: [job({ name: '<img src=x id=hack>' })], shifts: [shift('2026-10-20')] }) });
    app.tab('cal'); app.tab('settings');
    eq(app.q('#hack'), null, '名前がHTMLとして動いてしまっています');
  });
  test('エラーが出ていない', async () => {
    const app = await loadApp({ data: base({ shifts: [shift('2026-08-05'), shift('2026-10-03', '22:00', '03:00')], entries: [out('2026-09-01', 3000, 'card')] }) });
    for (const t of ['add', 'cal', 'review', 'settings', 'home']) app.tab(t);
    eq(app.w.__errors, []);
  });
});

// =====================================================================
group('設定画面の操作', () => {
  test('バイト先を新しく追加できる', async () => {
    const app = await loadApp({ data: base({ jobs: [] }) });
    app.tab('settings');
    app.click('#job-new');
    app.set('#j-name', 'コンビニ'); app.set('#j-wage', '1200'); app.set('#j-break', '45'); app.set('#j-transport', '200');
    app.set('#j-night', true); app.set('#j-closing', '15'); app.set('#j-offset', '0'); app.set('#j-payday', '31');
    app.click('#j-save');
    const j = app.data().jobs[0];
    eq([j.name, j.wage, j.breakMin, j.transport, j.night, j.closing, j.offset, j.payday], ['コンビニ', 1200, 45, 200, true, 15, 0, 31]);
    ok(app.text('#job-list').includes('15日締め・当月末日払い'), app.text('#job-list'));
    ok(app.q('#job-form').hidden, '保存したらフォームが閉じる');
  });
  test('バイト先の名前が空なら保存しない', async () => {
    const app = await loadApp({ data: base({ jobs: [] }) });
    app.tab('settings');
    app.click('#job-new');
    app.set('#j-wage', '1200');
    app.click('#j-save');
    eq([app.data().jobs.length, app.toast()], [0, '名前を入れてね']);
  });
  test('時給が空なら保存しない', async () => {
    const app = await loadApp({ data: base({ jobs: [] }) });
    app.tab('settings');
    app.click('#job-new');
    app.set('#j-name', 'コンビニ');
    app.click('#j-save');
    eq([app.data().jobs.length, app.toast()], [0, '時給を入れてね']);
  });
  test('バイト先を編集すると、見込みのお給料も変わる', async () => {
    const app = await loadApp({ data: base({ shifts: [shift('2026-10-03')] }) });
    app.tab('settings');
    app.click('[data-edit-job="j1"]');
    eq(app.q('#j-name').value, 'カフェ', '今の名前が入っている');
    app.set('#j-wage', '1200');
    app.click('#j-save');
    eq([app.data().jobs.length, app.data().jobs[0].id], [1, 'j1'], '増えずに上書きされる');
    eq(app.ev("forecast('2026-11')").pays[0].amount, 6000);
  });
  test('新しく追加するフォームで「やめる」と、なにも変わらない', async () => {
    const app = await loadApp({ data: base() });
    app.tab('settings');
    app.click('#job-new');
    app.set('#j-name', 'ためし');
    app.click('#j-cancel');
    eq([app.data().jobs.length, app.q('#job-form').hidden], [1, true]);
  });
  test('バイト先を消すとき「いいえ」なら消さない', async () => {
    const app = await loadApp({ data: base({ shifts: [shift('2026-10-03')] }) });
    app.tab('settings');
    app.click('[data-edit-job="j1"]');
    app.w.__confirmAnswer = false;
    app.click('#j-cancel');
    eq([app.data().jobs.length, app.data().shifts.length], [1, 1]);
    ok(app.w.__dialogs[0].includes('シフト1件も消えます'), 'シフトも消えることを知らせる');
  });
  test('最初の残高と「記録をつけ始めた日」を保存できる', async () => {
    const app = await loadApp({ data: base({ shifts: [shift('2026-08-05')] }) });
    app.tab('settings');
    app.set('#i-since', '2026-10-01');
    app.set('[data-initial="bank"]', '80000'); app.set('[data-initial="paypay"]', '1234'); app.set('[data-initial="cash"]', '-500');
    app.click('#i-save');
    const d = app.data();
    eq([d.since, d.initial], ['2026-10-01', { bank: 80000, paypay: 1234, cash: -500 }]);
    // 9/25 のお給料は「つけ始めた日」より前になったので、自動記録から外れる
    eq([app.auto('pay:').length, app.ev("balance('bank')")], [0, 80000]);
  });
  test('定額支出の名前・金額が空なら保存しない', async () => {
    const app = await loadApp({ data: base() });
    app.tab('settings');
    app.click('#sub-new');
    app.click('#u-save');
    eq(app.toast(), '名前を入れてね');
    app.set('#u-name', 'ジム');
    app.click('#u-save');
    eq([app.toast(), app.data().subs.length], ['金額を入れてね', 0]);
  });
  test('定額支出を「やめる」とき「いいえ」なら残る', async () => {
    const app = await loadApp({ data: base({ subs: [{ id: 'u1', name: '家賃', amount: 50000, day: 27, method: 'bankdebit', category: 'その他', from: '2026-08-01' }] }) });
    app.tab('settings');
    app.click('[data-edit-sub="u1"]');
    app.w.__confirmAnswer = false;
    app.click('#u-cancel');
    eq(app.data().subs.length, 1);
  });
});

// =====================================================================
group('シフトの画面の操作', () => {
  test('シフトを消せる（自動のお給料も消える）', async () => {
    const app = await loadApp({ data: base({ shifts: [shift('2026-08-05')] }) });
    app.tab('cal');
    app.click('#page-cal .month button[data-move="-1"]');
    app.click('#page-cal .month button[data-move="-1"]');
    app.click('[data-date="2026-08-05"]');
    app.click('[data-del-shift]');
    eq([app.data().shifts.length, app.auto('pay:').length], [0, 0]);
  });
  test('シフトを消すとき「いいえ」なら消さない', async () => {
    const app = await loadApp({ data: base({ shifts: [shift('2026-10-20')] }) });
    app.tab('cal');
    app.w.__confirmAnswer = false;
    app.click('[data-del-shift]');
    eq(app.data().shifts.length, 1);
  });
  test('時間が空のときは追加しない', async () => {
    const app = await loadApp({ data: base() });
    app.tab('cal');
    app.set('#s-start', '');
    app.click('#s-save');
    eq([app.data().shifts.length, app.toast()], [0, '時間を入れてね']);
  });
  test('はじまりとおわりが同じなら追加しない', async () => {
    const app = await loadApp({ data: base() });
    app.tab('cal');
    app.set('#s-start', '10:00'); app.set('#s-end', '10:00');
    app.click('#s-save');
    eq([app.data().shifts.length, app.toast()], [0, 'はじまりとおわりがおなじです']);
  });
  test('バイト先が2つあるとき、選んだほうにシフトが入る', async () => {
    const app = await loadApp({ data: base({ jobs: [job(), job({ id: 'j2', name: '塾' })] }) });
    app.tab('cal');
    app.click('#s-job [data-id="j2"]');
    app.click('#s-save');
    eq(app.data().shifts.map((s) => s.jobId), ['j2']);
  });
  test('同じ日に2つのシフトがあると、早い時間から並ぶ', async () => {
    const app = await loadApp({ data: base({ shifts: [shift('2026-10-20', '18:00', '21:00'), shift('2026-10-20', '09:00', '12:00')] }) });
    app.tab('cal');
    eq(app.qa('#day-detail .shift b').map((b) => b.nextSibling.textContent.trim()), ['09:00〜12:00', '18:00〜21:00']);
    ok(app.text('#day-detail').includes('働いた時間 3時間'), '働いた時間が出る');
  });
  test('バイト先を登録していないときは、登録をすすめる', async () => {
    const app = await loadApp({ data: base({ jobs: [] }) });
    app.tab('cal');
    ok(app.text('#day-detail').includes('先に「設定」でバイト先を登録してね'));
    eq(app.q('#s-save'), null);
  });
  test('給料日・引き落とし日をタップすると、その日の予定が出る', async () => {
    const app = await loadApp({ data: base({ shifts: [shift('2026-09-10')], entries: [out('2026-09-01', 3000, 'card')] }) });
    app.tab('cal');
    app.click('[data-date="2026-10-25"]');
    ok(app.text('#day-detail').includes('カフェの給料日（見込み ¥5,500）'), app.text('#day-detail'));
    app.click('[data-date="2026-10-10"]');
    ok(app.text('#day-detail').includes('クレカの引き落とし日（¥3,000）'), app.text('#day-detail'));
    ok(app.q('[data-date="2026-10-25"]').textContent.includes('💰'), 'カレンダーに💰');
  });
  test('ほかの月を開くと、選んでいる日がその月の1日になる', async () => {
    const app = await loadApp({ data: base() });
    app.tab('cal');
    app.click('#page-cal .month button[data-move="1"]');
    ok(app.q('[data-date="2026-11-01"]').classList.contains('sel'));
  });
});

// =====================================================================
group('バックアップ', () => {
  const pickFile = async (app, text) => {
    const dt = new app.w.DataTransfer();
    dt.items.add(new app.w.File([text], 'backup.json', { type: 'application/json' }));
    const input = app.q('#import');
    input.files = dt.files;
    input.dispatchEvent(new app.w.Event('change'));
    await new Promise((r) => setTimeout(r, 100)); // ファイルを読み終わるのを待つ
  };
  test('データを書き出すと、いまのデータがそのまま入っている', async () => {
    const app = await loadApp({ data: base({ entries: [out('2026-10-01', 800)] }) });
    let blob = null, name = null;
    app.w.URL.createObjectURL = (b) => { blob = b; return 'blob:test'; };
    app.w.HTMLAnchorElement.prototype.click = function () { name = this.download; }; // ほんとうにはダウンロードしない
    app.tab('settings');
    app.click('#export');
    eq(name, '家計簿バックアップ_2026-10-20.json');
    eq(JSON.parse(await blob.text()), app.data());
  });
  test('書き出したデータを読み込むと、置きかわる', async () => {
    const app = await loadApp({ data: base() });
    const backup = base({ initial: { bank: 1, paypay: 2, cash: 3 }, jobs: [] });
    app.tab('settings');
    await pickFile(app, JSON.stringify(backup));
    eq([app.data().initial, app.data().jobs.length, app.toast()], [{ bank: 1, paypay: 2, cash: 3 }, 0, '読み込みました']);
  });
  test('読み込むとき「いいえ」なら、いまのデータのまま', async () => {
    const app = await loadApp({ data: base() });
    app.w.__confirmAnswer = false;
    await pickFile(app, JSON.stringify(base({ initial: { bank: 1, paypay: 2, cash: 3 } })));
    eq(app.data().initial.bank, 100000);
  });
  test('家計簿のデータでないファイルは読み込まない', async () => {
    const app = await loadApp({ data: base() });
    await pickFile(app, '{"hello": 1}');
    eq(app.toast(), 'このファイルは読み込めませんでした');
    await pickFile(app, 'これはJSONではない');
    eq([app.toast(), app.data().initial.bank], ['このファイルは読み込めませんでした', 100000]);
  });
});

// =====================================================================
group('一覧と残高合わせの細かい操作', () => {
  const openList = (app) => { app.tab('review'); app.click('#review-toggle [data-view="list"]'); };
  test('記録が新しい日付から順に並ぶ', async () => {
    const app = await loadApp({ data: base({ entries: [out('2026-10-01', 100), out('2026-10-15', 200), out('2026-10-15', 250), out('2026-10-05', 300)] }) });
    openList(app);
    eq(app.qa('#entry-list .day').map((d) => d.textContent), ['10月15日（木）', '10月5日（月）', '10月1日（木）']);
  });
  test('金額を直すとき、空・0・キャンセルなら変わらない', async () => {
    const app = await loadApp({ data: base({ entries: [out('2026-10-01', 800)] }) });
    openList(app);
    for (const ans of ['', '0', null, 'abc']) {
      app.w.__promptAnswer = ans;
      app.click('#entry-list [data-edit]');
    }
    eq(app.entries()[0].amount, 800);
    eq(app.toast(), '0より大きい金額を入れてね');
  });
  test('手で入れた記録は、直しても「自動」あつかいにならない', async () => {
    const app = await loadApp({ data: base({ entries: [out('2026-10-01', 800)] }) });
    openList(app);
    app.w.__promptAnswer = '900';
    app.click('#entry-list [data-edit]');
    const e = app.entries()[0];
    eq([e.amount, e.edited, e.autoKey], [900, undefined, undefined]);
  });
  test('記録を消すとき「いいえ」なら消さない', async () => {
    const app = await loadApp({ data: base({ entries: [out('2026-10-01', 800)] }) });
    openList(app);
    app.w.__confirmAnswer = false;
    app.click('#entry-list [data-del]');
    eq(app.entries().length, 1);
  });
  test('いろいろな種類の記録が、一覧に正しく出る', async () => {
    const app = await loadApp({ data: base({ entries: [
      { id: 'm', type: 'move', from: 'bank', to: 'cash', amount: 10000, date: '2026-10-02' },
      { id: 'a', type: 'adjust', account: 'cash', amount: 300, date: '2026-10-03' },
      { id: 'i', type: 'in', account: 'paypay', amount: 500, category: '仕送り', date: '2026-10-04', memo: 'おばあちゃん' },
    ] }) });
    openList(app);
    const t = app.text('#entry-list');
    ['銀行 → お財布', '残高を合わせた', '+¥300', '📱 PayPayへ・おばあちゃん'].forEach((s) => ok(t.includes(s), `「${s}」が出ていません\n${t}`));
  });
  test('残高合わせで、計算と同じ金額ならなにも足さない', async () => {
    const app = await loadApp({ data: base() });
    app.w.__promptAnswer = '5000';
    app.click('[data-adjust="cash"]');
    eq([app.entries().length, app.toast()], [0, 'ぴったり合っています✨']);
    app.w.__promptAnswer = null;
    app.click('[data-adjust="cash"]');
    eq(app.entries().length, 0, 'キャンセルでも足さない');
  });
  test('予算をこえたら「あと使えるお金」が赤くなる', async () => {
    const app = await loadApp({ data: base({ budgets: { '食費': 1000 }, entries: [out('2026-10-01', 1500), out('2026-10-02', 850, 'cash', '食費')] }) });
    eq(app.text('#left'), '-¥1,350');
    ok(app.q('#left').classList.contains('minus'));
  });
  test('予算の8割をこえると、バーが黄色になる', async () => {
    const app = await loadApp({ data: base({ budgets: { '食費': 1000 }, entries: [out('2026-10-01', 850)] }) });
    ok(app.q('#budget-list .bar > div').classList.contains('warn'));
  });
  test('「記録をつけ始めた月」より前は、残高グラフを出さない', async () => {
    const app = await loadApp({ data: base({ since: '2026-10-01' }) });
    app.tab('review');
    app.click('#page-review .month button[data-move="-1"]');
    ok(app.text('#chart-line').includes('記録をつけ始める前の月です'));
  });
});

// =====================================================================
// 実行
(async () => {
  let saved = null;
  try { saved = localStorage.getItem(KEY); } catch (e) {}
  const results = { pass: 0, fail: 0, failures: [] };
  const box = document.getElementById('results');
  for (const g of groups) {
    const el = document.createElement('div');
    el.className = 'group';
    el.innerHTML = `<h2>${g.name}</h2>`;
    box.appendChild(el);
    for (const t of g.tests) {
      const row = document.createElement('div');
      row.className = 't';
      try {
        await t.fn();
        results.pass++;
        row.textContent = '✅ ' + t.name;
      } catch (e) {
        results.fail++;
        results.failures.push({ group: g.name, name: t.name, error: e.message });
        row.innerHTML = `❌ ${t.name}<div class="err"></div>`;
        row.querySelector('.err').textContent = e instanceof Fail ? e.message : `エラー: ${e.message}`;
      }
      el.appendChild(row);
    }
  }
  try { if (saved === null) localStorage.removeItem(KEY); else localStorage.setItem(KEY, saved); } catch (e) {}
  const s = document.getElementById('summary');
  s.textContent = results.fail ? `❌ ${results.fail}件 失敗／✅ ${results.pass}件 成功` : `✅ ぜんぶ成功（${results.pass}件）`;
  s.className = results.fail ? 'ng' : 'ok';
  if (window.COVERAGE) showCoverage(document.getElementById('coverage'));
  window.__results = results;
})();
