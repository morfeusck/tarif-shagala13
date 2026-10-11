const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'recalculation.html'), 'utf8');
const original = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const sandbox = {};
vm.runInNewContext(html.match(/<script id="recalculation-model">([\s\S]*?)<\/script>/)[1], sandbox);
const M = sandbox.TariffRecalculation;
const params = (mode='flat', preset='zero', basis=mode==='flat'?'invoice':'catalog') => ({
  mode, basis, area: mode==='flat'?40.7:13.3, days:30, monthDays:30,
  shares:M.sharesFor(mode,preset), creditAssumption:true, other:0, creditedMoney:0,
  rates:M.catalog(mode)
});
const close = (a,b) => assert.ok(Math.abs(a-b)<1e-7, `${a} != ${b}`);

test('all source amounts match original repository arrays and reconcile every section',()=>{
  for(const key of ['sections','lines']) {
    const literal=original.match(new RegExp('const '+key+' = (\\[[\\s\\S]*?\\n\\]);'))[1];
    assert.equal(JSON.stringify(M.source[key]),JSON.stringify(vm.runInNewContext(literal)));
  }
  for(const s of M.source.sections) for(const [mode,si,li] of [['flat',3,2],['park',4,3]]) {
    close(M.source.lines.filter(l=>l[0]===s[0]).reduce((a,l)=>a+l[li],0),s[si]);
  }
  assert.equal(M.rows.length,38);
  assert.equal(new Set(M.rows.map(r=>r.id)).size,38);
  close(M.catalog('flat').c,160);close(M.catalog('park').c,472.46);
  close(M.calculate(params('flat','zero','catalog')).beforeRate,232.37);
  close(M.calculate(params('park')).beforeRate,709.53);
});

test('verified September apartment example rounds billing rows separately',()=>{
  const r=M.calculate(params());
  assert.equal(r.groups[0].beforeCents,640333);
  assert.equal(r.groups[1].beforeCents,174929);
  assert.equal(r.groups[2].beforeCents,90802);
  assert.equal(r.groups[3].beforeCents,0);
  close(r.beforeRate,222.62);
  assert.equal(r.beforeCents,906064);
  // Multiplying the aggregate rate gives a different cent. The ledger must match individual bills.
  assert.equal(M.cents(r.beforeRate*r.area),906063);
  assert.equal(M.cents(1.005),101);
  assert.equal(M.cents(2.675),268);
  const custom=M.calculate({...params(),basis:'custom',rates:{c:157.33,o:42.98,m:22.31,u:0,extra:999}});
  close(custom.beforeRate,222.62);
  assert.equal(custom.beforeCents,906064);
});

test('B alternatives include each work once and are not added together',()=>{
  const b=M.calculate(params('flat','basic')),f=M.calculate(params('flat','facade'));
  close(b.b,13.33);close(b.d,0);assert.equal(b.cutCents,54253);
  close(b.groups[0].afterRate,144);assert.equal(b.groups[0].afterCents,586080);
  close(f.b,19.33);close(f.d,0);assert.equal(f.cutCents,78673);
  close(f.groups[0].afterRate,138);assert.equal(f.groups[0].afterCents,561660);
  assert.equal(f.items.find(r=>r.id==='facade').deduction,6);
});

test('previous SKUD exclusion is explicit, optional and is not deducted twice',()=>{
  const a=M.calculate(params('flat','expanded'));
  close(a.b,19.33);close(a.d,32.21);close(a.deduction,51.54);
  close(a.groups[0].afterRate,105.79);
  assert.equal(a.cutCents,209768);assert.equal(a.groups[0].afterCents,430565);
  assert.equal(a.items.find(r=>r.id==='skud').deduction,0);
  const unknown=M.calculate({...params('flat','expanded'),creditAssumption:false});
  close(unknown.deduction,54.21);close(unknown.groups[0].afterRate,103.12);
  const catalog=M.calculate(params('flat','expanded','catalog'));
  close(catalog.deduction,54.21);close(catalog.groups[0].afterRate,105.79);
});

test('parking cleaning uses the parking cost, not the apartment cost',()=>{
  for(const n of [25,50,100]) {
    const r=M.calculate(params('park','park'+n));
    close(r.deduction,312.46*n/100);
    close(r.groups[0].afterRate,472.46-312.46*n/100);
    assert.equal(r.groups[1].cutCents,0);assert.equal(r.groups[3].cutCents,0);
  }
  const all=M.calculate(params('park','park100'));
  assert.equal(all.beforeCents,943675);assert.equal(all.cutCents,415572);
  assert.equal(all.afterCents,528103);assert.equal(all.groups[0].afterCents,212800);
  const combined=M.calculate(params('park','parkCombined'));
  close(combined.deduction,366.67);close(combined.groups[0].afterRate,105.79);
  assert.equal(combined.cutCents,487671);assert.equal(combined.afterCents,456004);
  const noCharge=M.calculate({...params('flat'),shares:{parkClean:100}});
  assert.equal(noCharge.cutCents,0);
});

test('partial days and affected cost share are independent factors',()=>{
  const r=M.calculate({...params(),days:15,monthDays:31,shares:{clean:50}});
  close(r.deduction,11.74*.5*15/31);
  assert.equal(r.cutCents,11560);
});

test('bill components and prior separate refund reconcile without changing future fee',()=>{
  const r=M.calculate({...params('flat','basic'),other:3119.04,creditedMoney:100});
  assert.equal(r.allBeforeCents,1217968);assert.equal(r.allAfterCents,1163715);
  assert.equal(r.refundCents,44253);
  assert.equal(r.afterCents,851811);
  const excess=M.calculate({...params('flat','basic'),creditedMoney:600});
  assert.equal(excess.refundCents,0);
  assert.equal(excess.cutCents,54253);
  for(const mode of ['flat','park']) for(const preset of M.presets(mode)) {
    const ledger=M.calculate(params(mode,preset.id));
    assert.equal(ledger.beforeCents-ledger.cutCents,ledger.afterCents);
    assert.equal(ledger.groups.reduce((a,g)=>a+g.afterCents,0),ledger.afterCents);
    for(const g of ledger.groups)assert.equal(g.beforeCents-g.cutCents,g.afterCents);
  }
});

test('invalid data and over-deductions stop calculation instead of creating misleading totals',()=>{
  for(const change of [{area:0},{area:-1},{area:NaN},{days:31},{days:1.5},{monthDays:27},{other:-1},{creditedMoney:Infinity},{shares:{clean:101}},{shares:{clean:NaN}},{shares:{cloud:100}},{shares:{notAWork:100}}])assert.throws(()=>M.calculate({...params(),...change}));
  assert.throws(()=>M.calculate({...params('park'),basis:'invoice'}));
  assert.throws(()=>M.calculate({...params('flat','expanded'),basis:'custom',rates:{c:10,o:0,m:0,u:0}}),/превышает/);
  assert.throws(()=>M.calculate({...params(),basis:'custom',rates:{c:NaN,o:0,m:0,u:0}}));
  assert.throws(()=>M.daysInMonth('2026-13'));assert.throws(()=>M.daysInMonth('2025-01'));
  assert.equal(M.daysInMonth('2028-02'),29);assert.equal(M.daysInMonth('2026-02'),28);
  assert.equal(M.calculate({...params('flat','expanded'),days:0}).cutCents,0);
});

test('the standalone page has no third-party runtime or private source identifiers',()=>{
  assert.doesNotMatch(html,/<script[^>]*\bsrc\s*=/i);
  assert.doesNotMatch(html,/__SOURCE_DATA__|квартир[аеы] №85|Тихомиров|anton\.d|C:\\Users/i);
  assert.match(html,/Квитанции машино-мест и кладовых не сверены/);
  assert.match(html,/назначение снижения не подтверждено/);
});
