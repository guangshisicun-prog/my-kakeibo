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
group('給料の計算', () => {
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
  test('ホームの残高には「合わせる」ボタンを出さない', async () => {
    const app = await loadApp({ data: base() });
    eq(app.qa('#balances button').length, 0);
    ok(!app.text('#balances').includes('合わせる'));
  });
});

// =====================================================================
group('給料の自動記録', () => {
  test('過ぎた給料日の給料が、銀行に1回だけ記録される', async () => {
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
  test('カレンダーからシフトを足すと、記録ずみの給料も増える', async () => {
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
    app.click(app.qa('#entry-list [data-edit]')[0]); // タップすると「記録を直す」画面が開く
    app.set('#f-amount', '5000');
    app.click('#f-save');
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
  test('シフトを全部消すと、直していない自動の給料も消える', async () => {
    const app = await loadApp({ data: base({ shifts: [shift('2026-08-05')] }) });
    app.ev("data.shifts = []; render();");
    eq(app.auto('pay:').length, 0);
  });
  test('バイト先を消しても、記録ずみの給料は残る', async () => {
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
group('毎月の定額支出（チェック欄）', () => {
  const sub = (o = {}) => Object.assign({ id: 'u1', name: '家賃', amount: 50000, day: 27, method: 'bankdebit', category: '固定費', from: '2026-08-01' }, o);
  const check = (app, id = 'u1') => app.click(`[data-sub-check="${id}"]`);
  const box = (app, id = 'u1') => app.q(`[data-sub-check="${id}"]`);
  test('支払日が来ても、自動では記録しない', async () => {
    const app = await loadApp({ data: base({ subs: [sub({ day: 5 })] }) });
    eq([app.auto('sub:').length, app.ev("balance('bank')"), box(app).checked], [0, 100000, false]);
  });
  test('チェックすると、その日（今日）の日付で記録して残高から引く', async () => {
    const app = await loadApp({ data: base({ subs: [sub()] }) });
    check(app);
    const e = app.auto('sub:')[0];
    eq([e.date, e.amount, e.method, e.category, e.memo, e.autoKey, e.checked], ['2026-10-20', 50000, 'bankdebit', '固定費', '家賃', 'sub:u1:2026-10', true]);
    eq(app.ev("balance('bank')"), 50000);
    eq(box(app).checked, true);
    ok(app.text('#home-subs').includes('✅ 10月20日に払いました'), app.text('#home-subs'));
    eq(app.toast(), '家賃を払いました💸');
  });
  test('チェックをはずすと、記録が消えて残高がもどる', async () => {
    const app = await loadApp({ data: base({ subs: [sub()] }) });
    check(app);
    check(app);
    eq([app.auto('sub:').length, app.ev("balance('bank')"), box(app).checked], [0, 100000, false]);
  });
  test('クレカ払いの定額支出は、チェックしたときにすぐ銀行から引く（クレカの引き落としには入れない）', async () => {
    const app = await loadApp({ data: base({ subs: [sub({ name: 'Netflix', amount: 1490, day: 5, method: 'card' })] }) });
    check(app);
    eq([app.auto('sub:')[0].method, app.ev("balance('bank')")], ['bankdebit', 98510]);
    ok(app.text('#home-subs').includes('クレカ（チェックで銀行から引く）'));
    const later = await loadApp({ keep: true, today: '2026-11-20' });
    eq(later.auto('card:').length, 0, 'クレカの引き落としで2回引かれない');
    eq(later.ev("balance('bank')"), 98510);
  });
  test('現金・PayPay払いの定額支出は、その口座から引く', async () => {
    const app = await loadApp({ data: base({ subs: [sub({ id: 'c', method: 'cash', amount: 1000 }), sub({ id: 'p', method: 'paypay', amount: 500 })] }) });
    check(app, 'c'); check(app, 'p');
    eq([app.ev("balance('cash')"), app.ev("balance('paypay')"), app.ev("balance('bank')")], [4000, -500, 100000]);
  });
  test('毎月1日にリセットされて、新しい月の分をまたチェックできる', async () => {
    const first = await loadApp({ data: base({ subs: [sub({ day: 1 })] }) });
    check(first);
    const app = await loadApp({ keep: true, today: '2026-11-01' });
    eq(box(app).checked, false, '11月になったらチェックがはずれている');
    eq(app.auto('sub:').map((e) => e.date), ['2026-10-20'], '10月の記録は残っている');
    check(app);
    eq(app.auto('sub:').map((e) => e.date), ['2026-10-20', '2026-11-01']);
  });
  test('前の月にチェックしなかった分は、記録されないまま', async () => {
    await loadApp({ data: base({ subs: [sub()] }) });
    const app = await loadApp({ keep: true, today: '2026-11-01' });
    eq(app.auto('sub:').length, 0);
  });
  test('見込みには、まだチェックしていない分が支払日で、チェックした分は✅つきで出る', async () => {
    const app = await loadApp({ data: base({ subs: [sub(), sub({ id: 'n', name: 'Netflix', amount: 1490, day: 5, method: 'card' })] }) });
    check(app, 'n');
    const f = app.ev("forecast('2026-10')");
    eq(f.debits.map((d) => [d.label, d.date, d.done]), [['Netflix', '2026-10-20', true], ['家賃', '2026-10-27', false]]);
    ok(app.text('#home-forecast').includes('月末の銀行残高（予想）'));
    ok(/¥48,510/.test(app.text('#home-forecast')), '予想 ＝ 98,510 − 家賃 50,000');
  });
  test('31日にしたら、30日までの月の見込みは月末になる', async () => {
    const app = await loadApp({ data: base({ subs: [sub({ day: 31, amount: 1000 })] }) });
    eq(app.ev("forecast('2026-11')").debits.map((d) => d.date), ['2026-11-30']);
  });
  test('今月の支払日が利用開始日より前なら、今月はチェックできない', async () => {
    const app = await loadApp({ data: base({ subs: [sub({ day: 5, from: '2026-10-10' })] }) });
    eq(box(app).disabled, true);
    ok(app.text('#home-subs').includes('10月はありません'));
  });
  test('一覧では「チェック」の印がつき、直してもチェックのまま', async () => {
    const app = await loadApp({ data: base({ subs: [sub()] }) });
    check(app);
    app.tab('review'); app.click('#review-toggle [data-view="list"]');
    eq(app.text('#entry-list .tag'), 'チェック');
    app.click('#entry-list [data-edit]');
    eq(app.q('#auto-note').hidden, true, '「自動で記録したもの」とは出さない');
    app.set('#f-amount', '51000');
    app.click('#f-save');
    const e = app.auto('sub:')[0];
    eq([e.amount, e.checked], [51000, true]);
    app.tab('home');
    eq(box(app).checked, true);
  });
  test('一覧から削除すると、チェックがはずれる', async () => {
    const app = await loadApp({ data: base({ subs: [sub()] }) });
    check(app);
    app.tab('review'); app.click('#review-toggle [data-view="list"]');
    app.click('#entry-list [data-del]');
    app.tab('home');
    eq([box(app).checked, app.ev("balance('bank')")], [false, 100000]);
  });
  test('金額を変えても、チェックずみの記録はそのまま', async () => {
    const app = await loadApp({ data: base({ subs: [sub()] }) });
    check(app);
    app.tab('settings');
    app.click('[data-edit-sub="u1"]');
    app.set('#u-amount', '55000');
    app.click('#u-save');
    eq(app.auto('sub:').map((e) => e.amount), [50000]);
  });
  test('やめても、チェックずみの記録は残る', async () => {
    const app = await loadApp({ data: base({ subs: [sub()] }) });
    check(app);
    app.tab('settings');
    app.click('[data-edit-sub="u1"]');
    app.click('#u-cancel');
    eq([app.data().subs.length, app.auto('sub:').length], [0, 1]);
  });
  test('利用開始日を前の日にして登録しても、自動では記録しない（一覧に開始日が出る）', async () => {
    const app = await loadApp({ data: base() });
    app.tab('settings');
    app.click('#sub-new');
    app.set('#u-name', '家賃'); app.set('#u-amount', '50000'); app.set('#u-day', '27'); app.set('#u-method', 'bankdebit');
    app.set('#u-from', '2026-08-15');
    app.click('#u-save');
    eq([app.data().subs[0].from, app.auto('sub:').length], ['2026-08-15', 0]);
    ok(app.text('#sub-list').includes('8月15日から'), app.text('#sub-list'));
    app.tab('home');
    eq(box(app, app.data().subs[0].id).disabled, false, '今月のチェック欄が出る');
  });
  test('利用開始日が空なら、今日から始まる', async () => {
    const app = await loadApp({ data: base() });
    app.tab('settings');
    app.click('#sub-new');
    app.set('#u-name', 'ジム'); app.set('#u-amount', '3000');
    app.set('#u-from', '');
    app.click('#u-save');
    eq(app.data().subs[0].from, '2026-10-20');
  });
  test('設定画面から登録すると、登録した日から始まる', async () => {
    const app = await loadApp({ data: base() });
    app.tab('settings');
    app.click('#sub-new');
    app.set('#u-name', 'ジム'); app.set('#u-amount', '3000'); app.set('#u-day', '5'); app.set('#u-method', 'bankdebit');
    app.click('#u-save');
    eq(app.data().subs[0].from, '2026-10-20');
    const f = app.ev("forecast('2026-11')");
    eq(f.debits.map((x) => [x.label, x.date]), [['ジム', '2026-11-05']]);
  });
});

// =====================================================================
group('ホームの「毎月の定額支出」', () => {
  const s = (id, name, amount, method, from = '2026-08-01', day = 5) => ({ id, name, amount, day, method, category: 'その他', from });
  const subs = [
    s('a', 'Netflix', 1490, 'card'),
    s('b', '家賃', 50000, 'bankdebit', '2026-08-01', 27),
    s('c', '携帯代', 2000, 'bankdebit'),
    s('d', 'ジム', 3000, 'paypay', '2026-11-01'), // まだ始まっていない
  ];
  test('いま続いているものの合計が出る（これから始まるものは入れない）', async () => {
    const app = await loadApp({ data: base({ subs }) });
    eq(app.text('#home-subs .big'), '¥53,490');
  });
  test('1つずつの名前と金額が、高い順に出る', async () => {
    const app = await loadApp({ data: base({ subs }) });
    const rows = app.qa('#home-subs > .row').map((r) => r.innerText.replace(/\s+/g, ' ').trim());
    eq(rows.slice(0, 3), ['🏦 家賃 毎月27日・銀行引き落とし ¥50,000', '🏦 携帯代 毎月5日・銀行引き落とし ¥2,000', '💳 Netflix 毎月5日・クレカ（チェックで銀行から引く） ¥1,490']);
  });
  test('はらい方ごとの合計が出る', async () => {
    const app = await loadApp({ data: base({ subs }) });
    const t = app.text('#home-subs');
    ok(t.includes('🏦 銀行引き落とし\n¥52,000') || /銀行引き落とし\s*¥52,000/.test(t), t);
    ok(/クレカ\s*¥1,490/.test(t), t);
    ok(!/はらい方ごと[\s\S]*PayPay/.test(t.split('これから始まるもの')[0]), 'まだ始まっていないPayPayは入れない');
  });
  test('これから始まるものは、別に分けて開始日といっしょに出る', async () => {
    const app = await loadApp({ data: base({ subs }) });
    ok(/これから始まるもの[\s\S]*ジム[\s\S]*11月1日から/.test(app.text('#home-subs')), app.text('#home-subs'));
  });
  test('「カテゴリごとの予算」と「収支」の間にある', async () => {
    const app = await loadApp({ data: base({ subs }) });
    const cards = app.qa('#page-home > .card');
    const subsAt = cards.findIndex((c) => c.id === 'home-subs');
    eq(cards[subsAt - 1].querySelector('#budget-list') !== null, true, 'すぐ上はカテゴリごとの予算');
    eq(cards[subsAt + 1].id, 'home-sums', 'すぐ下は収支');
  });
  test('登録がないときは、登録をすすめる', async () => {
    const app = await loadApp({ data: base() });
    ok(app.text('#home-subs').includes('「設定」で定額支出を登録すると'));
  });
  test('設定で追加すると、すぐにホームの合計にも反映される', async () => {
    const app = await loadApp({ data: base({ subs: [subs[1]] }) });
    app.tab('settings');
    app.click('#sub-new');
    app.set('#u-name', 'Spotify'); app.set('#u-amount', '980');
    app.click('#u-save');
    eq(app.text('#home-subs .big'), '¥50,980');
  });
});

// =====================================================================
group('今月の見込み', () => {
  test('月末の銀行残高の予想 ＝ いまの残高 ＋ これからの給料 − これからの引き落とし', async () => {
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
  test('設定画面で予算を保存できる（今月の予算になる）', async () => {
    const app = await loadApp({ data: base() });
    app.tab('settings');
    app.set('[data-budget="食費"]', '25000');
    app.click('#b-save');
    eq(app.data().monthBudgets, { '2026-10': { '食費': 25000 } });
    eq(app.toast(), '10月の予算を保存しました🎯');
  });
});

// =====================================================================
group('月ごとのまとめ・今月にもどる', () => {
  const data = () => base({
    budgets: { '食費': 10000 },
    entries: [
      out('2026-08-03', 3000), Object.assign(out('2026-08-04', 50000, 'bankdebit', '固定費')),
      { id: 'i1', type: 'in', account: 'bank', category: '仕送り', amount: 30000, date: '2026-08-20' },
      out('2026-09-03', 12000),
      out('2026-10-03', 2500),
    ],
  });
  const openMonths = (app) => { app.tab('review'); app.click('#review-toggle [data-view="months"]'); };
  test('記録をつけ始めた月から今月まで、新しい月が上に並ぶ', async () => {
    const app = await loadApp({ data: data() });
    openMonths(app);
    eq(app.qa('#month-summary .month-sum h2').map((h) => h.firstChild.textContent), ['2026年10月（今月）', '2026年9月', '2026年8月']);
    eq(app.q('#review-month-nav').hidden, true, '月の切りかえはかくす');
    eq([app.q('#review-graph').hidden, app.q('#review-list').hidden], [true, true]);
  });
  test('月ごとの収入・支出・収支・予算の残りが正しい（予算の残りは固定費をのぞく）', async () => {
    const app = await loadApp({ data: data() });
    openMonths(app);
    const card = (mk) => app.q(`#month-summary [data-goto="${mk}"] .sum-grid`).innerText.replace(/\s+/g, ' ').trim();
    eq(card('2026-08'), '収入 ¥30,000 支出 ¥53,000 収支 -¥23,000 予算の残り ¥7,000');
    eq(card('2026-09'), '収入 ¥0 支出 ¥12,000 収支 -¥12,000 予算の残り -¥2,000');
    ok(app.q('#month-summary [data-goto="2026-09"] .sum-grid div:nth-child(4) b').classList.contains('minus'), '予算オーバーは赤');
  });
  test('予算がない月は「予算なし」と出る', async () => {
    const app = await loadApp({ data: base({ entries: [out('2026-10-03', 100)] }) });
    openMonths(app);
    ok(app.text('#month-summary [data-goto="2026-10"]').includes('予算なし'));
  });
  test('月をタップすると、ホームでその月が開く', async () => {
    const app = await loadApp({ data: data() });
    openMonths(app);
    app.click('#month-summary [data-goto="2026-08"]');
    ok(app.q('#page-home').classList.contains('on'));
    eq(app.text('#page-home .month-label'), '2026年8月');
    eq(app.text('#left'), '¥7,000');
  });
  test('ほかの月を見ているときだけ「今月にもどる」が出て、押すと今月にもどる', async () => {
    const app = await loadApp({ data: data() });
    eq(app.q('#back-now').hidden, true, '今月を見ているときは出さない');
    eq(app.text('#left-label'), '今月あと使えるお金（予算から）');
    app.click('#page-home .month button[data-move="-1"]');
    app.click('#page-home .month button[data-move="-1"]');
    eq(app.q('#back-now').hidden, false);
    eq(app.text('#left-label'), '8月の予算の残り');
    app.click('#back-now');
    eq([app.text('#page-home .month-label'), app.q('#back-now').hidden], ['2026年10月', true]);
  });
  test('「グラフ」「一覧」にもどると、月の切りかえがまた出る', async () => {
    const app = await loadApp({ data: data() });
    openMonths(app);
    app.click('#review-toggle [data-view="list"]');
    eq([app.q('#review-month-nav').hidden, app.q('#review-months').hidden, app.q('#review-list').hidden], [false, true, false]);
  });
});

// =====================================================================
group('月ごとの予算', () => {
  const withBudgets = (o = {}) => base(Object.assign({
    budgets: { '食費': 30000 }, // はじめの予算
    monthBudgets: { '2026-09': { '食費': 20000, '趣味': 5000 }, '2026-11': { '食費': 40000 } },
    entries: [out('2026-08-03', 1000), out('2026-09-03', 1000), out('2026-10-03', 1000), out('2026-11-03', 1000), out('2026-12-03', 1000)],
  }, o));
  const leftOf = (app, y, m) => { app.ev(`view = new Date(${y}, ${m - 1}, 1); render();`); return app.text('#left'); };
  test('月ごとの予算がない月は、はじめの予算を使う', async () => {
    const app = await loadApp({ data: withBudgets() });
    eq(leftOf(app, 2026, 8), '¥29,000');
  });
  test('その月の予算があれば、それを使う', async () => {
    const app = await loadApp({ data: withBudgets() });
    eq(leftOf(app, 2026, 9), '¥24,000');
    eq(leftOf(app, 2026, 11), '¥39,000');
  });
  test('予算を立てていない月は、前の月の予算を引きつぐ', async () => {
    const app = await loadApp({ data: withBudgets() });
    eq(leftOf(app, 2026, 10), '¥24,000', '10月は9月の予算');
    eq(leftOf(app, 2026, 12), '¥39,000', '12月は11月の予算');
    ok(app.text('#budget-list').includes('¥1,000 / ¥40,000'), 'カテゴリごとの予算も引きつぐ');
  });
  test('設定で月を切りかえると、その月の予算が出る', async () => {
    const app = await loadApp({ data: withBudgets() });
    app.tab('settings');
    eq(app.text('#budget-month-label'), '2026年10月', 'はじめは今月');
    eq(app.q('[data-budget="食費"]').value, '20000');
    ok(app.text('#budget-source').includes('9月の予算を引きついでいます'));
    eq(app.q('#b-reset').hidden, true, '引きついでいる月は「やめる」ボタンを出さない');
    app.click('[data-bmove="1"]');
    eq(app.text('#budget-month-label'), '2026年11月');
    eq([app.q('[data-budget="食費"]').value, app.q('[data-budget="趣味"]').value], ['40000', '']);
    eq(app.text('#budget-source'), 'この月の予算です');
    eq(app.q('#b-reset').hidden, false);
    app.click('[data-bmove="-1"]'); app.click('[data-bmove="-1"]'); app.click('[data-bmove="-1"]');
    eq(app.text('#budget-month-label'), '2026年8月');
    ok(app.text('#budget-source').includes('はじめの予算'));
    eq(app.q('[data-budget="食費"]').value, '30000');
  });
  test('ある月の予算を保存すると、その月とあとの月（予算を立てていない月）が変わる', async () => {
    const app = await loadApp({ data: withBudgets() });
    app.tab('settings');
    app.set('[data-budget="食費"]', '15000');
    app.click('#b-save');
    eq(app.data().monthBudgets['2026-10'], { '食費': 15000, '趣味': 5000 }, '引きついだ金額もいっしょに保存');
    eq(leftOf(app, 2026, 10), '¥19,000');
    eq(leftOf(app, 2026, 9), '¥24,000', '前の月は変わらない');
    eq(leftOf(app, 2026, 11), '¥39,000', '自分の予算がある月は変わらない');
  });
  test('「この月の予算をやめる」と、前の月から引きつぐ（「いいえ」ならそのまま）', async () => {
    const app = await loadApp({ data: withBudgets() });
    app.tab('settings');
    app.click('[data-bmove="1"]');
    app.w.__confirmAnswer = false;
    app.click('#b-reset');
    ok(app.data().monthBudgets['2026-11']);
    app.w.__confirmAnswer = true;
    app.click('#b-reset');
    eq(app.data().monthBudgets['2026-11'], undefined);
    eq(leftOf(app, 2026, 11), '¥24,000', '9月の予算を引きつぐ');
  });
  test('設定の予算の ‹ › を押しても、ホームの月は変わらない（NaN年NaN月にならない）', async () => {
    const app = await loadApp({ data: withBudgets() });
    app.tab('settings');
    app.click('[data-bmove="-1"]');
    app.click('[data-bmove="1"]');
    app.click('[data-bmove="1"]');
    eq(app.text('#budget-month-label'), '2026年11月');
    eq(app.qa('.month-label').map((l) => l.textContent), ['2026年10月', '2026年10月', '2026年10月'], 'ホーム・シフト・ふりかえり');
    app.tab('home');
    app.click('#page-home .month button[data-move="-1"]');
    eq(app.text('#page-home .month-label'), '2026年9月');
    eq(app.text('#budget-month-label'), '2026年11月', 'ホームの ‹ › でも、予算の月は変わらない');
    ok(!app.w.document.body.innerText.includes('NaN'), '画面に NaN が出ていない');
  });
  test('前の版のデータ（月ごとの予算なし）は、これまでの予算がすべての月に使われる', async () => {
    const app = await loadApp({ data: base({ budgets: { '食費': 30000 }, entries: [out('2026-06-03', 1000)] }) });
    eq(app.data().monthBudgets, {});
    eq(leftOf(app, 2026, 6), '¥29,000');
    eq(leftOf(app, 2027, 3), '¥30,000');
  });
});

// =====================================================================
group('合計の予算と固定費', () => {
  const rent = { id: 'u1', name: '家賃', amount: 50000, day: 5, method: 'bankdebit', category: 'その他', from: '2026-08-01' };
  test('「今月あと使えるお金」の下に、合計の予算のバーが出る', async () => {
    const app = await loadApp({ data: base({ budgets: { '食費': 30000, '趣味': 5000 }, entries: [out('2026-10-05', 1200), out('2026-10-06', 2000, 'cash', '趣味')] }) });
    const t = app.text('#total-budget').replace(/\s+/g, ' ');
    ok(t.includes('合計 ¥3,200 / ¥35,000') && t.includes('あと ¥31,800'), t);
    ok(app.q('#total-budget').closest('.card').querySelector('#left'), '「今月あと使えるお金」と同じカードにある');
  });
  test('合計の予算も、8割で黄色・こえたら赤になる', async () => {
    const warn = await loadApp({ data: base({ budgets: { '食費': 1000 }, entries: [out('2026-10-05', 900)] }) });
    ok(warn.q('#total-budget .bar > div').classList.contains('warn'), '黄色');
    const over = await loadApp({ data: base({ budgets: { '食費': 1000 }, entries: [out('2026-10-05', 1100)] }) });
    ok(over.q('#total-budget .bar > div').classList.contains('over'), '赤');
    ok(over.text('#total-budget').includes('¥100 オーバー'));
  });
  test('予算がないときは、合計のバーを出さない', async () => {
    const app = await loadApp({ data: base() });
    eq(app.q('#total-budget').innerHTML, '');
  });
  test('定額支出にチェックすると、「固定費」として記録される', async () => {
    const app = await loadApp({ data: base({ subs: [rent] }) });
    app.click('[data-sub-check="u1"]');
    eq(app.auto('sub:').map((e) => e.category), ['固定費']);
  });
  test('前に登録・記録した定額支出も「固定費」に変わる', async () => {
    const app = await loadApp({ data: base({ subs: [rent], entries: [
      { id: 'old', type: 'out', method: 'bankdebit', category: 'その他', amount: 50000, date: '2026-08-05', autoKey: 'sub:u1:2026-08' },
      out('2026-08-06', 300, 'cash', 'その他'), // 手で入れたものは変えない
    ] }) });
    eq(app.data().subs[0].category, '固定費');
    eq(app.entries((e) => e.date.startsWith('2026-08')).map((e) => e.category), ['固定費', 'その他']);
  });
  test('固定費は予算の計算に入らない（支出の合計には入る）', async () => {
    const app = await loadApp({ data: base({ subs: [rent], budgets: { '食費': 30000 }, entries: [out('2026-10-06', 1000)] }) });
    app.click('[data-sub-check="u1"]');
    eq(app.text('#left'), '¥29,000');
    ok(app.text('#left-note').includes('固定費はのぞく'));
    eq(app.text('#sum-out'), '¥51,000');
    ok(!app.text('#budget-list').includes('固定費'), '予算の一覧に固定費を出さない');
  });
  test('設定の予算に「固定費」の欄はない', async () => {
    const app = await loadApp({ data: base({ budgets: { '固定費': 9999 } }) });
    app.tab('settings');
    eq(app.q('[data-budget="固定費"]'), null);
    eq(app.data().budgets, {}, '前に入れた固定費の予算は消す');
  });
  test('定額支出の画面に、カテゴリを選ぶ欄はない', async () => {
    const app = await loadApp({ data: base() });
    app.tab('settings');
    app.click('#sub-new');
    eq(app.q('#u-cat'), null);
    ok(app.text('#sub-form').includes('自動で「固定費」になります'));
    app.set('#u-name', 'Netflix'); app.set('#u-amount', '1490');
    app.click('#u-save');
    eq(app.data().subs[0].category, '固定費');
  });
  test('ふりかえりの内訳に「固定費」が出る', async () => {
    const app = await loadApp({ data: base({ subs: [rent], entries: [out('2026-10-06', 1000)] }) });
    app.click('[data-sub-check="u1"]');
    const t = app.text('#chart-donut');
    ok(/固定費\s*¥50,000/.test(t), t);
  });
});

// =====================================================================
group('グラフ', () => {
  test('収入と支出の棒グラフは出さない', async () => {
    const app = await loadApp({ data: base() });
    eq(app.q('#chart-bars'), null);
    ok(!app.text('#review-graph').includes('収入と支出'));
  });
  test('支出の内訳の％を足すと、だいたい100％', async () => {
    const app = await loadApp({ data: base({ entries: [out('2026-10-01', 1000), out('2026-10-01', 1000, 'cash', '趣味'), out('2026-10-01', 1000, 'cash', '日用品')] }) });
    const pcts = app.qa('#chart-donut .donut-legend .muted').map((x) => parseInt(x.textContent));
    const total = pcts.reduce((a, b) => a + b, 0);
    ok(total >= 99 && total <= 101, `合計 ${total}%`);
  });
  test('銀行の月末残高は棒グラフで、月ごとの金額が出る（「記録をつけ始めた月」から）', async () => {
    const app = await loadApp({ data: base({ shifts: [shift('2026-08-05')] }) });
    eq(app.qa('#chart-balance path').length, 3, '棒の数');
    const texts = app.qa('#chart-balance text').map((t) => t.textContent);
    eq(texts, ['¥100,000', '8月', '¥105,500', '9月', '¥105,500', '10月(今)']);
  });
  test('残高がマイナスの月は、赤い棒で金額を出す', async () => {
    const app = await loadApp({ data: base({ since: '2026-10-01', initial: { bank: -5000, paypay: 0, cash: 0 } }) });
    const bar = app.q('#chart-balance rect');
    ok(bar && bar.getAttribute('fill') === 'var(--red)', '赤い棒がありません');
    ok(app.text('#chart-balance').includes('-¥5,000'));
  });
  test('内訳のグラフをタップすると数字が出る', async () => {
    const app = await loadApp({ data: base({ entries: [out('2026-10-01', 1000)] }) });
    app.q('#chart-donut circle[data-tip]').dispatchEvent(new app.w.MouseEvent('click', { bubbles: true }));
    eq(app.text('#chart-donut .chart-info'), '🍙 食費　¥1,000（100%）');
  });
  test('支出も残高も0円でも、グラフがこわれない', async () => {
    const app = await loadApp({ data: base({ since: '2026-10-01', initial: { bank: 0, paypay: 0, cash: 0 } }) });
    eq(app.w.__errors, []);
    ok(!app.q('#chart-balance').innerHTML.includes('NaN'), '残高グラフに NaN（計算できない数）が入っています');
    ok(app.text('#chart-balance').includes('¥0'));
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
  test('前の版の「確定した給料」は、直したもの扱いになる', async () => {
    const app = await loadApp({ data: base({ entries: [{ id: 'p', type: 'in', account: 'bank', category: 'バイト代', amount: 5300, date: '2026-09-25', payKey: 'j1:2026-09-25' }], shifts: [shift('2026-08-05')] }) });
    const p = app.auto('pay:');
    eq(p.map((e) => [e.amount, e.edited]), [[5300, true]]);
  });
  test('名前に記号（<b>など）を入れても、画面がこわれない', async () => {
    const app = await loadApp({ data: base({ jobs: [job({ name: '<img src=x id=hack>' })], shifts: [shift('2026-10-20')] }) });
    app.tab('cal'); app.tab('settings');
    eq(app.q('#hack'), null, '名前がHTMLとして動いてしまっています');
  });
  test('ホームの見出しは「my家計簿」だけ（絵文字なし）', async () => {
    const app = await loadApp({ data: base() });
    eq(app.text('#home-title'), 'my家計簿');
    eq(app.w.document.title, 'my家計簿', 'ページのタイトルもそろえる');
  });
  test('どうぶつの森風のデザイン（クリーム色の背景・丸い文字・若葉色の小見出し）になっている', async () => {
    const app = await loadApp({ data: base() });
    const css = (el, p) => app.w.getComputedStyle(el).getPropertyValue(p);
    eq(css(app.w.document.documentElement, '--bg').trim(), '#f8f1dc', '背景はクリーム色');
    ok(css(app.q('#home-title'), 'font-family').includes('Kiwi Maru'), '見出しはほんわかした丸い文字');
    ok(css(app.w.document.body, 'font-family').includes('Rounded'), '文字は丸ゴシック');
    eq(css(app.q('#page-home h2'), 'background-color'), 'rgb(123, 198, 123)', '小見出しは若葉色のラベル');
    eq(css(app.q('.card'), 'border-top-left-radius'), '28px', 'カードはまるい');
    eq(app.text('#home-title'), 'my家計簿', '見出しに絵文字をつけない');
  });
  test('ホーム画面のアイコン（180×180の画像）が用意されている', async () => {
    const app = await loadApp({ data: base() });
    const link = app.q('link[rel="apple-touch-icon"]');
    ok(link, 'アイコンの指定がない');
    const res = await fetch('../' + link.getAttribute('href'), { cache: 'no-store' });
    eq([res.status, res.headers.get('content-type')], [200, 'image/png']);
    const img = new Image();
    img.src = URL.createObjectURL(await res.blob());
    await img.decode();
    eq([img.naturalWidth, img.naturalHeight], [180, 180]);
  });
  test('ホームの並び：今月あと使えるお金 → カテゴリごとの予算 → 定額支出 → 収支 → 見込み', async () => {
    const app = await loadApp({ data: base() });
    const cards = app.qa('#page-home > .card');
    const at = (fn) => cards.findIndex(fn);
    const order = [
      at((c) => c.querySelector('#left')),
      at((c) => c.querySelector('#budget-list')),
      at((c) => c.id === 'home-subs'),
      at((c) => c.id === 'home-sums'),
      at((c) => c.id === 'home-forecast'),
    ];
    eq(order, [1, 2, 3, 4, 5], '0番目は「いまの残高」');
  });
  test('画面に「お給料」という言葉が出ない（「給料」にそろえる）', async () => {
    const app = await loadApp({ data: base({ shifts: [shift('2026-08-05'), shift('2026-10-03')] }) });
    let all = '';
    for (const t of ['home', 'add', 'cal', 'review', 'settings']) { app.tab(t); all += app.w.document.body.innerText; }
    app.click('#review-toggle [data-view="list"]');
    app.click('#page-review .month button[data-move="-1"]');
    all += app.text('#entry-list');
    ok(!all.includes('お給料'), '「お給料」が出ています');
    ok(all.includes('カフェの給料'), '自動記録のメモが「〜の給料」になっていません');
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
  test('バイト先を編集すると、見込みの給料も変わる', async () => {
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
    // 9/25 の給料は「つけ始めた日」より前になったので、自動記録から外れる
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
  test('シフトを消せる（自動の給料も消える）', async () => {
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
group('シフトをまとめて追加（長押し）', () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const press = (app, date, type, o = {}) =>
    app.q(`[data-date="${date}"]`).dispatchEvent(new app.w.PointerEvent(type, Object.assign({ bubbles: true, clientX: 10, clientY: 10 }, o)));
  // 長押しして指をはなす（はなしたあとのタップもいっしょに来る）
  async function longPress(app, date) {
    press(app, date, 'pointerdown');
    await sleep(app.ev('LONG_PRESS_MS') + 100);
    press(app, date, 'pointerup');
    app.click(`[data-date="${date}"]`);
  }
  const picked = (app) => app.qa('#cal .d.multi').map((b) => b.dataset.date);
  const openCal = async (data) => { const app = await loadApp({ data }); app.tab('cal'); return app; };

  test('長押しすると、まとめて選ぶモードになって、その日が選ばれる', async () => {
    const app = await openCal(base());
    await longPress(app, '2026-10-21');
    eq(picked(app), ['2026-10-21']);
    ok(app.text('#day-detail').includes('1日を選んでいます'), app.text('#day-detail'));
    ok(app.q('#s-multi-save'), 'まとめて追加ボタンが出る');
  });
  test('選ぶモードでは、タップで選んだり外したりできる', async () => {
    const app = await openCal(base());
    await longPress(app, '2026-10-21');
    app.click('[data-date="2026-10-23"]');
    app.click('[data-date="2026-10-25"]');
    app.click('[data-date="2026-10-23"]');
    eq(picked(app), ['2026-10-21', '2026-10-25']);
    eq(app.q('#s-multi-save').textContent, '2日にまとめて追加');
  });
  test('選んだ日ぜんぶに、おなじ時間のシフトが入る', async () => {
    const app = await openCal(base());
    await longPress(app, '2026-10-21');
    app.click('[data-date="2026-10-24"]');
    app.click('[data-date="2026-10-22"]');
    app.set('#s-start', '17:00'); app.set('#s-end', '21:00');
    app.click('#s-multi-save');
    eq(app.data().shifts.map((s) => [s.date, s.jobId, s.start, s.end]), [
      ['2026-10-21', 'j1', '17:00', '21:00'],
      ['2026-10-22', 'j1', '17:00', '21:00'],
      ['2026-10-24', 'j1', '17:00', '21:00'],
    ]);
    eq(app.toast(), '3日にシフトを追加しました📅');
    eq(picked(app), [], '追加したら、ふつうのカレンダーにもどる');
    ok(app.q('[data-date="2026-10-21"]').classList.contains('sel'), '最初の日が選ばれている');
  });
  test('2つめのバイト先を選ぶと、そっちに入る', async () => {
    const app = await openCal(base({ jobs: [job(), job({ id: 'j2', name: '塾' })] }));
    await longPress(app, '2026-10-21');
    app.click('[data-date="2026-10-22"]');
    app.click('#s-job [data-id="j2"]');
    eq(picked(app), ['2026-10-21', '2026-10-22'], 'バイト先を変えても、選んだ日はそのまま');
    app.click('#s-multi-save');
    eq(app.data().shifts.map((s) => s.jobId), ['j2', 'j2']);
  });
  test('おなじバイト先・おなじ時間のシフトがある日はとばす', async () => {
    const app = await openCal(base({ shifts: [shift('2026-10-22')] }));
    await longPress(app, '2026-10-21');
    app.click('[data-date="2026-10-22"]');
    app.click('[data-date="2026-10-23"]');
    app.set('#s-start', '10:00'); app.set('#s-end', '15:00');
    app.click('#s-multi-save');
    eq(app.data().shifts.map((s) => s.date).sort(), ['2026-10-21', '2026-10-22', '2026-10-23']);
    eq(app.toast(), '2日にシフトを追加しました📅（22日はもう入っていたのでとばしたよ）');
  });
  test('ぜんぶの日にもう入っていたら、何も追加しない', async () => {
    const app = await openCal(base({ shifts: [shift('2026-10-21')] }));
    await longPress(app, '2026-10-21');
    app.set('#s-start', '10:00'); app.set('#s-end', '15:00');
    app.click('#s-multi-save');
    eq([app.data().shifts.length, app.toast()], [1, 'どの日も、おなじシフトがもう入っていたよ']);
  });
  test('時間がちがうシフトなら、おなじ日でもとばさない', async () => {
    const app = await openCal(base({ shifts: [shift('2026-10-21', '10:00', '15:00')] }));
    await longPress(app, '2026-10-21');
    app.set('#s-start', '18:00'); app.set('#s-end', '21:00');
    app.click('#s-multi-save');
    eq(app.data().shifts.length, 2);
  });
  test('時間が空・はじまりとおわりがおなじなら追加しない', async () => {
    const app = await openCal(base());
    await longPress(app, '2026-10-21');
    app.set('#s-start', '');
    app.click('#s-multi-save');
    eq([app.data().shifts.length, app.toast()], [0, '時間を入れてね']);
    app.set('#s-start', '10:00'); app.set('#s-end', '10:00');
    app.click('#s-multi-save');
    eq([app.data().shifts.length, app.toast()], [0, 'はじまりとおわりがおなじです']);
    eq(picked(app), ['2026-10-21'], 'まちがえても、選んだ日は消えない');
  });
  test('「やめる」で、何も追加せずにふつうにもどる', async () => {
    const app = await openCal(base());
    await longPress(app, '2026-10-21');
    app.click('[data-date="2026-10-22"]');
    app.click('#s-multi-cancel');
    eq([app.data().shifts.length, picked(app), app.q('#s-multi-save')], [0, [], null]);
    ok(app.q('#s-save'), 'ふつうの追加ボタンにもどる');
  });
  test('選んだ日をぜんぶ外すと、ふつうにもどる', async () => {
    const app = await openCal(base());
    await longPress(app, '2026-10-21');
    app.click('[data-date="2026-10-21"]');
    eq([picked(app), app.q('#s-multi-save')], [[], null]);
  });
  test('月を切りかえると、選んだ日はリセット', async () => {
    const app = await openCal(base());
    await longPress(app, '2026-10-21');
    app.click('#page-cal .month button[data-move="1"]');
    eq([picked(app), app.q('#s-multi-save')], [[], null]);
    app.click('#page-cal .month button[data-move="-1"]');
    eq(picked(app), [], 'もどっても選ばれていない');
  });
  test('すぐ指をはなしたら（ふつうのタップ）、選ぶモードにならない', async () => {
    const app = await openCal(base());
    press(app, '2026-10-21', 'pointerdown');
    press(app, '2026-10-21', 'pointerup');
    app.click('[data-date="2026-10-21"]');
    await sleep(app.ev('LONG_PRESS_MS') + 100);
    eq([picked(app), app.q('#s-multi-save')], [[], null]);
    ok(app.q('[data-date="2026-10-21"]').classList.contains('sel'));
  });
  test('押したまま指を動かしたら（スクロール）、選ぶモードにならない', async () => {
    const app = await openCal(base());
    press(app, '2026-10-21', 'pointerdown');
    press(app, '2026-10-21', 'pointermove', { clientY: 60 });
    await sleep(app.ev('LONG_PRESS_MS') + 100);
    eq(picked(app), []);
  });
  test('バイト先を登録していないときは、選ぶモードにならない', async () => {
    const app = await openCal(base({ jobs: [] }));
    await longPress(app, '2026-10-21');
    eq([picked(app), app.toast()], [[], '先に「設定」でバイト先を登録してね']);
  });
  test('まとめて入れたシフトも、給料の見込みに入る', async () => {
    const app = await openCal(base());
    await longPress(app, '2026-10-21');
    app.click('[data-date="2026-10-22"]');
    app.set('#s-start', '10:00'); app.set('#s-end', '15:00');
    app.click('#s-multi-save');
    eq(app.ev(`payGroups().filter((g) => g.date === '2026-11-25').reduce((a, g) => a + g.amount, 0)`), 11000);
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
  test('直すとき、金額が空・0なら保存しない', async () => {
    const app = await loadApp({ data: base({ entries: [out('2026-10-01', 800)] }) });
    openList(app);
    app.click('#entry-list [data-edit]');
    for (const v of ['', '0']) {
      app.set('#f-amount', v);
      app.click('#f-save');
      eq(app.toast(), '金額を入れてね');
    }
    eq(app.entries()[0].amount, 800);
  });
  test('手で入れた記録は、直しても「自動」あつかいにならない', async () => {
    const app = await loadApp({ data: base({ entries: [out('2026-10-01', 800)] }) });
    openList(app);
    app.click('#entry-list [data-edit]');
    app.set('#f-amount', '900');
    app.click('#f-save');
    const e = app.entries()[0];
    eq([e.amount, e.edited, e.autoKey], [900, undefined, undefined]);
  });
  test('クレカの引き落としは、タップすると金額だけ直せる（空・0・キャンセルなら変わらない）', async () => {
    const app = await loadApp({ data: base({ entries: [out('2026-09-01', 3000, 'card')] }) });
    openList(app);
    for (const ans of ['', '0', null, 'abc']) {
      app.w.__promptAnswer = ans;
      app.click('#entry-list [data-edit]');
    }
    eq(app.auto('card:')[0].amount, 3000);
    eq(app.toast(), '0より大きい金額を入れてね');
    app.w.__promptAnswer = '3100';
    app.click('#entry-list [data-edit]');
    eq([app.auto('card:')[0].amount, app.auto('card:')[0].edited], [3100, true]);
    eq(app.q('#page-review').classList.contains('on'), true, '画面は一覧のまま');
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
    ['銀行 → お財布', '残高を合わせた', '+¥300', 'おばあちゃん', '📮 仕送り・📱 PayPayへ'].forEach((s) => ok(t.includes(s), `「${s}」が出ていません\n${t}`));
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
    ok(app.text('#chart-balance').includes('記録をつけ始める前の月です'));
  });
});

// =====================================================================
group('記録を直す・削除する・内容', () => {
  const openList = (app) => { app.tab('review'); app.click('#review-toggle [data-view="list"]'); };
  const lunch = () => Object.assign(out('2026-10-05', 800), { id: 'L', memo: 'コンビニでお昼' });
  test('記録するときに「内容」を入れられて、一覧では内容が大きく出る', async () => {
    const app = await loadApp({ data: base() });
    app.tab('add');
    app.set('#f-amount', '650');
    app.set('#f-memo', '学食のカレー');
    app.click('#f-save');
    eq(app.entries()[0].memo, '学食のカレー');
    openList(app);
    eq(app.text('#entry-list .entry .title'), '学食のカレー');
    eq(app.text('#entry-list .entry .memo'), '🍙 食費・💴 現金', 'カテゴリとはらい方は下に小さく');
  });
  test('内容がないときは、カテゴリ名を大きく出す', async () => {
    const app = await loadApp({ data: base({ entries: [out('2026-10-05', 800, 'paypay', '日用品')] }) });
    openList(app);
    eq(app.text('#entry-list .entry .title'), '日用品');
  });
  test('「内容」の欄は、金額のすぐ下にある', async () => {
    const app = await loadApp({ data: base() });
    const inputs = app.qa('#add-card input').map((i) => i.id);
    eq(inputs.indexOf('f-memo'), inputs.indexOf('f-amount') + 1);
  });
  test('一覧の記録をタップすると「記録を直す」画面が開き、今の内容が入っている', async () => {
    const app = await loadApp({ data: base({ entries: [lunch()] }) });
    openList(app);
    app.click('#entry-list [data-edit]');
    ok(app.q('#page-add').classList.contains('on'), '記録の画面が開く');
    eq(app.text('#add-title'), '記録を直す ✏️');
    eq([app.q('#f-amount').value, app.q('#f-memo').value, app.q('#f-date').value], ['800', 'コンビニでお昼', '2026-10-05']);
    ok(app.q('#f-method [data-id="cash"]').classList.contains('on') && app.q('#f-cats [data-id="食費"]').classList.contains('on'));
    eq(app.q('#edit-buttons').hidden, false, '「やめる」「削除する」が出る');
  });
  test('金額・内容・日付・カテゴリ・はらい方をぜんぶ直せる', async () => {
    const app = await loadApp({ data: base({ entries: [lunch()] }) });
    openList(app);
    app.click('#entry-list [data-edit]');
    app.set('#f-amount', '1200'); app.set('#f-memo', 'ランチ（友だちと）'); app.set('#f-date', '2026-10-06');
    app.click('#f-cats [data-id="交際費"]');
    app.click('#f-method [data-id="paypay"]');
    app.click('#f-save');
    const e = app.entries()[0];
    eq([e.id, e.amount, e.memo, e.date, e.category, e.method], ['L', 1200, 'ランチ（友だちと）', '2026-10-06', '交際費', 'paypay']);
    eq(app.entries().length, 1, 'ふえずに上書きされる');
    eq([app.ev("balance('cash')"), app.ev("balance('paypay')")], [5000, -1200], '残高も直る');
    ok(app.q('#page-review').classList.contains('on'), '保存したら一覧にもどる');
    eq(app.text('#entry-list .entry .title'), 'ランチ（友だちと）');
  });
  test('支出を収入や移動に変えられる', async () => {
    const app = await loadApp({ data: base({ entries: [lunch()] }) });
    openList(app);
    app.click('#entry-list [data-edit]');
    app.click('#add-toggle [data-type="move"]');
    app.click('#f-from [data-id="bank"]'); app.click('#f-to [data-id="cash"]');
    app.click('#f-save');
    const e = app.entries()[0];
    eq([e.type, e.from, e.to, e.method, e.category], ['move', 'bank', 'cash', undefined, undefined]);
  });
  test('「やめる」なら変わらず、画面も元にもどる', async () => {
    const app = await loadApp({ data: base({ entries: [lunch()] }) });
    openList(app);
    app.click('#entry-list [data-edit]');
    app.set('#f-amount', '99999');
    app.click('#f-cancel');
    eq(app.entries()[0].amount, 800);
    app.tab('add');
    eq([app.text('#add-title'), app.q('#f-amount').value, app.q('#edit-buttons').hidden], ['記録する ✏️', '', true]);
  });
  test('直している途中でタブを切りかえると、直すのをやめる', async () => {
    const app = await loadApp({ data: base({ entries: [lunch()] }) });
    openList(app);
    app.click('#entry-list [data-edit]');
    app.tab('home');
    app.tab('add');
    app.set('#f-amount', '500');
    app.click('#f-save');
    eq(app.entries().length, 2, '新しい記録としてふえる（前の記録は書きかえない）');
    eq(app.entries()[0].amount, 800);
  });
  test('「記録を直す」画面から削除できる（「いいえ」なら消さない）', async () => {
    const app = await loadApp({ data: base({ entries: [lunch()] }) });
    openList(app);
    app.click('#entry-list [data-edit]');
    app.w.__confirmAnswer = false;
    app.click('#f-delete');
    eq(app.entries().length, 1);
    app.w.__confirmAnswer = true;
    app.click('#f-delete');
    eq([app.entries().length, app.toast()], [0, '削除しました']);
    ok(app.q('#page-review').classList.contains('on'), '削除したら一覧にもどる');
  });
  test('一覧の「×」でも削除できる', async () => {
    const app = await loadApp({ data: base({ entries: [lunch()] }) });
    openList(app);
    app.click('#entry-list [data-del]');
    eq(app.entries().length, 0);
    ok(app.q('#page-review').classList.contains('on'), '「×」では直す画面は開かない');
  });
  test('自動で記録された給料も直せる（あとから自動で書きかえられない）', async () => {
    const app = await loadApp({ data: base({ shifts: [shift('2026-08-05')] }) });
    openList(app);
    app.click('#page-review .month button[data-move="-1"]');
    app.click('#entry-list [data-edit]');
    eq(app.q('#add-toggle').hidden, true, '支出・収入の切りかえは出さない');
    eq(app.q('#auto-note').hidden, false, '自動の記録だと知らせる');
    app.set('#f-amount', '5300'); app.set('#f-memo', 'カフェの給料（税金引かれた）');
    app.click('#f-save');
    const p = app.auto('pay:')[0];
    eq([p.amount, p.memo, p.edited, p.autoKey], [5300, 'カフェの給料（税金引かれた）', true, 'pay:j1:2026-09-25']);
    app.tab('add');
    eq(app.q('#add-toggle').hidden, false, 'ふつうの記録画面にもどる');
  });
  test('自動の記録を「直す」画面から削除すると、もう一度つくられない', async () => {
    const app = await loadApp({ data: base({ shifts: [shift('2026-08-05')] }) });
    openList(app);
    app.click('#page-review .month button[data-move="-1"]');
    app.click('#entry-list [data-edit]');
    app.click('#f-delete');
    const again = await loadApp({ keep: true });
    eq(again.auto('pay:').length, 0);
  });
});

// =====================================================================
// 5か月分（2026年6月〜10月）をふだんどおりに使ったときのテスト
// 毎週日曜にその週の分を記録してアプリを開く、を10月31日までくりかえす。
// 答え合わせの金額は、アプリとは別にここで計算する。
group('5か月分のデータで使ってみる', () => {
  // ---- 日付の道具 ----
  const fmt = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const last = (y, m) => new Date(y, m, 0).getDate();
  const days = (from, to) => {
    const out = [];
    for (let d = new Date(from + 'T00:00'); fmt(d.getFullYear(), d.getMonth() + 1, d.getDate()) <= to; d.setDate(d.getDate() + 1)) {
      out.push({ date: fmt(d.getFullYear(), d.getMonth() + 1, d.getDate()), wd: d.getDay(), day: d.getDate() });
    }
    return out;
  };
  const payDay = (date, closing, offset, payday) => {
    let [y, m, d] = date.split('-').map(Number);
    if (d > Math.min(closing, last(y, m))) m += 1;
    m += offset;
    while (m > 12) { m -= 12; y += 1; }
    return fmt(y, m, Math.min(payday, last(y, m)));
  };
  // 決まった順番で出てくる「でたらめな数」（毎回同じ結果になる）
  let seed = 20260601;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const pick = (min, max, step = 10) => Math.round((min + rand() * (max - min)) / step) * step;

  // ---- 設定 ----
  const SINCE = '2026-06-01', END = '2026-10-31';
  const INITIAL = { bank: 200000, paypay: 3000, cash: 10000 };
  const JOBS = [
    { id: 'cafe', name: 'カフェ', wage: 1100, transport: 300, breakMin: 60, night: false, closing: 31, offset: 1, payday: 25 },
    { id: 'izakaya', name: '居酒屋', wage: 1200, transport: 0, breakMin: 0, night: true, closing: 15, offset: 0, payday: 25 },
  ];
  const CARD = { set: true, closing: 15, offset: 1, payday: 10 };
  const SUBS = [
    { id: 'rent', name: '家賃', amount: 45000, day: 27, method: 'bankdebit', from: SINCE },
    { id: 'phone', name: '携帯代', amount: 2980, day: 1, method: 'bankdebit', from: SINCE },
    { id: 'netflix', name: 'Netflix', amount: 1490, day: 5, method: 'card', from: SINCE },
    { id: 'gym', name: 'ジム', amount: 3000, day: 10, method: 'paypay', from: SINCE },
    { id: 'spotify', name: 'Spotify', amount: 980, day: 31, method: 'card', from: '2026-08-15' }, // 途中から
  ].map((s) => Object.assign({ category: '固定費' }, s));
  const BUDGETS = { '食費': 25000, '日用品': 5000, '交通費': 5000, '交際費': 15000, '趣味': 10000 };
  const BUDGET_TOTAL = Object.values(BUDGETS).reduce((a, b) => a + b, 0);
  const yenT = (v) => (v < 0 ? '-' : '') + '¥' + Math.abs(v).toLocaleString('ja-JP');

  // ---- 5か月分の記録とシフトをつくる ----
  const entries = [], shifts = [];
  let n = 0;
  const add = (o) => entries.push(Object.assign({ id: 'g' + (n++), memo: '' }, o));
  for (const { date, wd, day } of days(SINCE, END)) {
    add({ type: 'out', method: rand() < 0.5 ? 'cash' : 'paypay', category: '食費', amount: pick(450, 950), date });
    if (rand() < 0.25) add({ type: 'out', method: 'card', category: '食費', amount: pick(800, 3000), date }); // スーパー
    if (day % 4 === 0) add({ type: 'out', method: 'card', category: '日用品', amount: pick(300, 1500), date });
    if (wd === 0 || wd === 6) {
      if (rand() < 0.6) add({ type: 'out', method: 'cash', category: '交際費', amount: pick(1500, 4500, 100), date });
      if (rand() < 0.2) add({ type: 'out', method: 'card', category: '趣味', amount: pick(1000, 6000, 100), date });
      if (rand() < 0.15) add({ type: 'out', method: 'card', category: '服・美容', amount: pick(2000, 8000, 100), date });
    }
    if (day === 1 || day === 15) add({ type: 'move', from: 'bank', to: 'cash', amount: 15000, date }); // ATM
    if (day === 5 || day === 20) add({ type: 'move', from: 'bank', to: 'paypay', amount: 15000, date }); // チャージ
    if (day === 20) add({ type: 'in', account: 'bank', category: '仕送り', amount: 50000, date });
    if (wd === 2 || wd === 6) shifts.push({ id: 's' + date + 'c', jobId: 'cafe', date, start: '10:00', end: '16:00' });
    if (wd === 5) {
      shifts.push({ id: 's' + date + 'i', jobId: 'izakaya', date, start: '18:00', end: '23:30' });
      add({ type: 'out', method: 'paypay', category: '交通費', amount: pick(200, 600), date });
    }
  }

  // ---- 答え合わせの計算（アプリとは別に） ----
  const pay = (s) => {
    const j = JOBS.find((x) => x.id === s.jobId);
    const [sh, sm] = s.start.split(':').map(Number), [eh, em] = s.end.split(':').map(Number);
    const total = eh * 60 + em - (sh * 60 + sm);
    const night = Math.max(0, eh * 60 + em - Math.max(22 * 60, sh * 60 + sm));
    return (j.wage * (total - j.breakMin)) / 60 + (j.night ? (j.wage * 0.25 * night) / 60 : 0) + j.transport;
  };
  // 定額支出は、アプリを開いた日に、支払日が過ぎていてまだの分にチェックする（その日の記録になる）
  const paidSubs = [];
  function expected(today) {
    const manual = entries.filter((e) => e.date <= today);
    // 定額支出（クレカ払いもチェックしたときに銀行から）
    const subs = paidSubs.filter((p) => p.date <= today)
      .map((p) => ({ type: 'out', method: p.method === 'card' ? 'bankdebit' : p.method, category: '固定費', amount: p.amount, date: p.date, name: p.name }));
    // 給料
    const salary = {};
    for (const s of shifts.filter((x) => x.date <= today)) {
      const j = JOBS.find((x) => x.id === s.jobId);
      const d = payDay(s.date, j.closing, j.offset, j.payday);
      const k = `${j.name} ${d}`;
      salary[k] = (salary[k] || 0) + pay(s);
    }
    const pays = Object.entries(salary).map(([k, v]) => ({ date: k.split(' ')[1], name: k.split(' ')[0], amount: Math.floor(v) }))
      .filter((p) => p.date <= today).sort((a, b) => (a.date + a.name < b.date + b.name ? -1 : 1));
    // クレカの引き落とし
    const card = {};
    for (const e of manual.concat(subs).filter((x) => x.type === 'out' && x.method === 'card')) {
      const d = payDay(e.date, CARD.closing, CARD.offset, CARD.payday);
      card[d] = (card[d] || 0) + e.amount;
    }
    const cardpays = Object.entries(card).filter(([d]) => d <= today && d >= SINCE).map(([date, amount]) => ({ date, amount })).sort((a, b) => (a.date < b.date ? -1 : 1));
    // 残高
    const all = manual.concat(subs);
    const bal = Object.assign({}, INITIAL);
    const acctOfMethod = { cash: 'cash', paypay: 'paypay', bankdebit: 'bank', card: null };
    for (const e of all) {
      if (e.type === 'out' && acctOfMethod[e.method]) bal[acctOfMethod[e.method]] -= e.amount;
      if (e.type === 'in') bal[e.account] += e.amount;
      if (e.type === 'move') { bal[e.from] -= e.amount; bal[e.to] += e.amount; }
    }
    bal.bank += pays.reduce((a, p) => a + p.amount, 0) - cardpays.reduce((a, p) => a + p.amount, 0);
    return { bal, pays, cardpays, subs, all };
  }

  // ---- 実行 ----
  test('6月1日から毎週日曜に記録してアプリを開くと、毎回の残高が合う', async () => {
    const start = base({ since: SINCE, initial: INITIAL, jobs: JOBS, card: CARD, subs: SUBS, budgets: BUDGETS, shifts: [], entries: [] });
    const openDays = [SINCE].concat(days(SINCE, END).filter((d) => d.wd === 0).map((d) => d.date)).concat([END]);
    let app = null, prev = '0000-00-00';
    const slow = [];
    for (const day of openDays) {
      // この日までの記録・シフトを足して（ふだんアプリで入れている分）、アプリを開く
      const stored = app ? JSON.parse(localStorage.getItem(KEY)) : start;
      stored.entries.push(...entries.filter((e) => e.date > prev && e.date <= day));
      stored.shifts.push(...shifts.filter((s) => s.date > prev && s.date <= day));
      localStorage.setItem(KEY, JSON.stringify(stored));
      const t0 = performance.now();
      app = await loadApp({ keep: true, today: day });
      const ms = performance.now() - t0;
      if (ms > 1500) slow.push(`${day}: ${Math.round(ms)}ms`);
      prev = day;
      // 今月の支払日が過ぎていて、まだチェックしていない定額支出にチェックする
      const [y, m] = day.split('-').map(Number);
      for (const s of SUBS) {
        const due = fmt(y, m, Math.min(s.day, last(y, m)));
        const box = app.q(`[data-sub-check="${s.id}"]`);
        if (due >= s.from && due <= day && box && !box.checked && !box.disabled) {
          app.click(box);
          paidSubs.push({ date: day, amount: s.amount, method: s.method, name: s.name, month: day.slice(0, 7) });
        }
      }
      const want = expected(day).bal;
      const got = { bank: app.ev("balance('bank')"), paypay: app.ev("balance('paypay')"), cash: app.ev("balance('cash')") };
      eq(got, want, `${day} に開いたときの残高`);
      eq(app.w.__errors, [], `${day} にエラー`);
    }
    eq(slow, [], '開くのに時間がかかりすぎた日');
    window.__scenarioApp = app;
  });

  const final = () => { if (!window.__scenarioApp) throw new Fail('前のテストが失敗したので確認できません'); return window.__scenarioApp; };
  test('給料が、給料日ごとに1回ずつ正しい金額で記録されている', async () => {
    const app = final();
    const got = app.auto('pay:').map((e) => ({ date: e.date, name: e.memo.replace('の給料', ''), amount: e.amount }))
      .sort((a, b) => (a.date + a.name < b.date + b.name ? -1 : 1));
    eq(got, expected(END).pays);
    eq(got.length, 9, 'カフェ4回（7〜10月）＋居酒屋5回（6〜10月）');
  });
  test('クレカの引き落としが、支払日ごとに1回ずつ正しい金額で記録されている', async () => {
    const app = final();
    eq(app.auto('card:').map((e) => ({ date: e.date, amount: e.amount })), expected(END).cardpays);
    eq(app.auto('card:').map((e) => e.date), ['2026-07-10', '2026-08-10', '2026-09-10', '2026-10-10']);
  });
  test('チェックした定額支出が、チェックした日に1回ずつ記録されている', async () => {
    const app = final();
    const got = app.auto('sub:').map((e) => `${e.memo} ${e.date} ${e.method}`).sort();
    eq(got, paidSubs.map((p) => `${p.name} ${p.date} ${p.method === 'card' ? 'bankdebit' : p.method}`).sort());
    ok(got.length >= 15, `チェックした回数 ${got.length}`);
    const perMonth = paidSubs.map((p) => `${p.name} ${p.month}`);
    eq(perMonth.length, new Set(perMonth).size, '同じ月に2回チェックしていない');
    const keys = app.auto('').map((e) => e.autoKey);
    eq(keys.length, new Set(keys).size, '自動記録に重なりがない');
  });
  test('月ごとの支出の合計と「今月あと使えるお金」が合っている', async () => {
    const app = final();
    const all = expected(END).all.filter((e) => e.type === 'out');
    for (const m of ['06', '07', '08', '09', '10']) {
      const want = all.filter((e) => e.date.slice(5, 7) === m).reduce((a, e) => a + e.amount, 0);
      app.ev(`view = new Date(2026, ${Number(m) - 1}, 1); render();`);
      eq(app.text('#sum-out'), '¥' + want.toLocaleString('ja-JP'), `${Number(m)}月の支出`);
      const used = all.filter((e) => e.date.slice(5, 7) === m && e.category !== '固定費').reduce((a, e) => a + e.amount, 0);
      eq(app.text('#left'), yenT(BUDGET_TOTAL - used), `${Number(m)}月のあと使えるお金`);
    }
  });
  test('銀行の月末残高のグラフが、5か月分正しく出ている', async () => {
    const app = final();
    app.ev('view = new Date(2026, 9, 1); render();');
    const want = ['06', '07', '08', '09', '10'].map((m) => {
      const endDay = fmt(2026, Number(m), last(2026, Number(m)));
      return yenT(expected(endDay).bal.bank);
    });
    const texts = app.qa('#chart-balance text').map((t) => t.textContent).filter((t) => t.includes('¥'));
    eq(texts, want);
  });
  test('11月の見込みが合っている（10月のシフト・クレカ・定額支出）', async () => {
    const app = final();
    const f = app.ev("forecast('2026-11')");
    const cafeOct = shifts.filter((s) => s.jobId === 'cafe' && s.date.startsWith('2026-10')).reduce((a, s) => a + pay(s), 0);
    const izaLate = shifts.filter((s) => s.jobId === 'izakaya' && s.date >= '2026-10-16').reduce((a, s) => a + pay(s), 0);
    eq(f.pays.map((p) => [p.label, p.amount]).sort(), [['カフェ', Math.floor(cafeOct)], ['居酒屋', Math.floor(izaLate)]].sort());
    const cardNov = expected(END).all.filter((e) => e.type === 'out' && e.method === 'card' && e.date >= '2026-09-16' && e.date <= '2026-10-15').reduce((a, e) => a + e.amount, 0);
    eq(f.debits.map((d) => [d.label, d.date, d.amount]), [
      ['携帯代', '2026-11-01', 2980], ['Netflix', '2026-11-05', 1490], ['クレカ', '2026-11-10', cardNov],
      ['家賃', '2026-11-27', 45000], ['Spotify', '2026-11-30', 980],
    ], 'クレカ払いの定額支出も、チェックで銀行から引くので引き落としに入る');
  });
  test('支出の内訳のグラフの合計が、その月の支出と同じ', async () => {
    const app = final();
    app.ev('view = new Date(2026, 9, 1); render();');
    const legend = app.qa('#chart-donut .donut-legend .row').map((r) => Number(r.children[1].firstChild.textContent.replace(/[¥,\s]/g, '')));
    eq('¥' + legend.reduce((a, b) => a + b, 0).toLocaleString('ja-JP'), app.text('#sum-out'));
  });
  test('一覧・シフト・ふりかえり・設定のどの画面も、エラーなく開ける', async () => {
    const app = final();
    for (const t of ['add', 'cal', 'review', 'settings', 'home']) app.tab(t);
    app.click('#review-toggle [data-view="list"]');
    ok(app.qa('#entry-list .entry').length > 50, '10月の一覧が出ている');
    eq(app.w.__errors, []);
    window.__scenario = {
      entries: app.data().entries.length,
      shifts: app.data().shifts.length,
      balances: { bank: app.ev("balance('bank')"), paypay: app.ev("balance('paypay')"), cash: app.ev("balance('cash')") },
      pays: app.auto('pay:').length, cardpays: app.auto('card:').length, subs: app.auto('sub:').length,
      data: app.data(),
    };
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
