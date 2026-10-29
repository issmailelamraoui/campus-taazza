import {test} from 'node:test';
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {parseMathExpression,evaluateMath,sampleGraph,mathErrorMessage} from '../shared/math.js';

const value=(expression,x)=>evaluateMath(parseMathExpression(expression),x);
const close=(actual,expected,label)=>{
  if(!Number.isFinite(expected))assert.ok(!Number.isFinite(actual),label);
  else assert.ok(Number.isFinite(actual)&&Math.abs(actual-expected)<=1e-10*Math.max(1,Math.abs(expected)),`${label}: ${actual} ≈ ${expected}`);
};
test('all requested conventional functions preserve their values at negative, positive and zero inputs',()=>{
  const examples=[['|x|',Math.abs],['|x-3|',x=>Math.abs(x-3)],['|x^2-4|',x=>Math.abs(x*x-4)],['ln(x)',Math.log],['log(x)',Math.log10],['e^x',Math.exp],['exp(x)',Math.exp],['e(x)',Math.exp],['sqrt(x)',Math.sqrt],['x^2',x=>x*x],['x^3-2*x',x=>x*x*x-2*x],['1/x',x=>1/x],['sin(x)',Math.sin],['cos(x)',Math.cos],['tan(x)',Math.tan],['ln(|x|)',x=>Math.log(Math.abs(x))],['exp(-x^2)',x=>Math.exp(-x*x)],['sqrt(x^2+1)',x=>Math.sqrt(x*x+1)],['|sin(x)|',x=>Math.abs(Math.sin(x))]];
  for(const [expression,expected] of examples)for(const x of [-3,-1,0,.5,1,3])close(value(expression,x),expected(x),`${expression} at ${x}`);
});
test('nested bars, grouping, right-associative powers and unary minus follow mathematical precedence',()=>{
  for(const [expression,x,expected]of [['||x||',-4,4],['|x+|x-3||',-2,3],['|2*|x||',-3,6],['ln(|sin(x)|)',1,Math.log(Math.sin(1))],['-x^2',3,-9],['(-x)^2',3,9],['2^3^2',0,512],['2^-2',0,.25],['exp(-x^2)',2,Math.exp(-4)],['|x||x-1|',-2,6]])close(value(expression,x),expected,expression);
});
test('implicit products and Unicode operators are parsed structurally without rewriting the original input',()=>{
  for(const [expression,expected]of [['2x',4],['2(x+1)',6],['(x+1)(x-1)',3],['2sin(pi/2)',2],['πx',2*Math.PI],['2e^x',2*Math.exp(2)],['e(x)',Math.exp(2)],['2e(x)',2*Math.exp(2)],['1/2x',1],['1/(2x)',.25],['2×x − 1',3],['x÷2',1],['2·x',4],['1e2x',200],['2e-3x',.004],[' x ^ 2 + 2 x ',8]])close(value(expression,2),expected,expression);
  for(const expression of ['pix','xsin(x)','sin x','2 3','x2'])assert.throws(()=>parseMathExpression(expression));
  assert.equal(value('e',0),Math.E,'Bare e is still a constant');
  assert.equal(value('ln(e)',0),1);assert.equal(value('log(10)',0),1);
});
test('real-valued domains never admit invalid points or approximate a pole as a finite tangent',()=>{
  for(const expression of ['ln(x)','log(x)','sqrt(x)'])assert.equal(sampleGraph(expression,-2,2,21)[0].y,null);
  for(const expression of ['ln(x)','log(x)','1/x','ln(|x|)','x^-2'])assert.equal(sampleGraph(expression,-2,2,21)[10].y,null,expression+' excludes zero');
  assert.equal(value('sqrt(x)',0),0);assert.equal(value('e(x)',0),1);
  assert.ok(Number.isNaN(value('tan(x)',Math.PI/2)));assert.ok(Number.isNaN(value('1e-12*tan(x)',Math.PI/2)));
  assert.ok(Number.isNaN(value('0^0',0)),'Zero to the zero power is left undefined in the real graph');
  assert.equal(sampleGraph('x^0',-2,2,21)[10].y,null);
  assert.ok(Number.isNaN(value('0*ln(x)',-1)),'Invalid subexpressions do not become valid after multiplication by zero');
  assert.ok(sampleGraph('ln(-1)').every(point=>point.y===null));
  assert.ok(sampleGraph('exp(1000)').every(point=>point.y===null));
});
test('exact small odd-root fractions preserve negative real roots without guessing decimal exponents',()=>{
  close(value('x^(1/3)',-8),-2,'cube root');close(value('x^(2/3)',-8),4,'squared cube root');
  close(value('x^(2/6)',-8),-2,'reduced fraction');close(value('x^(-1/3)',-8),-.5,'inverse cube root');
  assert.ok(Number.isNaN(value('x^(1/2)',-8)));assert.ok(Number.isNaN(value('x^0.3333333333333333',-8)));
  assert.ok(sampleGraph('x^(1/3)',-2,2).every((point,index)=>index===0||!point.breakBefore));
});
test('off-grid poles, removable holes and narrow invalid domains split independently of scale or viewport',()=>{
  const root=.037;
  for(const expression of ['1/(x-0.037)','1/(x-0.037)^2','1e-20/(x-0.037)','1/(|x-0.037|)','ln((x-0.037)^2)','(x-0.037)/(x-0.037)','sqrt((x-0.037)^2-0.000001)']){
    for(const count of [20,21,320,321]){
      const points=sampleGraph(expression,-2,2,count),crossing=points.findIndex((point,index)=>index>0&&points[index-1].x<root&&point.x>root);
      assert.ok(crossing>0);assert.equal(points[crossing].breakBefore,true,expression+' at '+count+' samples');
    }
  }
  const tangent=sampleGraph('tan(x)',-2,2);
  for(const pole of [-Math.PI/2,Math.PI/2]){
    const index=tangent.findIndex((point,i)=>i>0&&tangent[i-1].x<pole&&point.x>pole);assert.equal(tangent[index].breakBefore,true);
  }
});
test('ordinary continuous curves and bounded step segments stay connected',()=>{
  for(const expression of ['x','x^2','sin(x)','cos(x)','exp(-x^2)','|x|','sqrt(x^2+1)','1/(x^2+1)','1/(x-x+0.001)','sin(100000000000000000000)','0^x']){
    const points=sampleGraph(expression,expression==='0^x'?.1:-2,2);
    assert.ok(points.every((point,index)=>index===0||!point.breakBefore),expression+' remains continuous');
  }
  const floor=sampleGraph('floor(x)',-2,2);
  assert.ok(floor.some((point,index)=>index>0&&!point.breakBefore));
  for(let index=1;index<floor.length;index++)if(floor[index].y!==floor[index-1].y)assert.equal(floor[index].breakBefore,true);
});
test('syntax failures and work budgets stay bounded without evaluating JavaScript',()=>{
  globalThis.__graphExecuted=false;
  for(const expression of ['window.__graphExecuted=true','globalThis.__graphExecuted=true','Math.sin(x)','x.constructor','constructor(x)','alert(1)','x;1','sin(1,2)','[x]','{}','x=>x','|x','x+*2','('.repeat(40)+'x'+')'.repeat(40),'-'.repeat(40)+'x','1'.repeat(257)])assert.throws(()=>parseMathExpression(expression),expression);
  assert.equal(globalThis.__graphExecuted,false);delete globalThis.__graphExecuted;
  const start=performance.now();const points=sampleGraph('1/sin(100000*x)+tan(100000*x)',-2,2,1000);
  assert.equal(points.length,1000);assert.ok(points.every(point=>point.y===null||Number.isFinite(point.y)));
  assert.ok(performance.now()-start<1500,'A high-frequency expression has a finite operation budget');
  for(const args of [['x',1,-1],['x',NaN,1],['x',-1,Infinity],['x',-1,1,1001],['x',-1e7,1]])assert.throws(()=>sampleGraph(...args));
});
test('syntax errors have meaningful French, Arabic and English messages',()=>{
  let error;try{parseMathExpression('|x');}catch(value){error=value;}
  assert.match(mathErrorMessage(error,'fr'),/valeur absolue/);assert.match(mathErrorMessage(error,'en'),/absolute-value/);assert.match(mathErrorMessage(error,'ar'),/القيمة المطلقة/);
  assert.equal(mathErrorMessage(new Error('Localized vertical range')),'Localized vertical range');
});
