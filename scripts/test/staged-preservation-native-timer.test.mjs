import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {remotePython} from '../staged-postgres-preservation-host-adapter.mjs';

function run(body) {
  const program = `import ast,re,sys\ntree=ast.parse(sys.stdin.read())\nselected=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name in ('need','native_timespan_usec','timer_verify')]\nexec(compile(ast.Module(body=selected,type_ignores=[]),'<actual-timer-functions>','exec'))\nTKEYS=[]\nSKEYS=[]\n${body}\n`;
  const result=spawnSync('python3',['-c',program],{input:remotePython,encoding:'utf8',timeout:5000});
  assert.equal(result.status,0,result.stderr);
}

test('actual formatted expiry duration and finite microseconds parse exactly',()=>run(`
assert native_timespan_usec('2h 57min 54s') == 10674000000
assert native_timespan_usec('1w 23h 32min 54.719554s') == 689574719554
assert native_timespan_usec('55min') == 3300000000
assert native_timespan_usec('3h') == 10800000000
assert native_timespan_usec('4min') == 240000000
assert native_timespan_usec('1s') == 1000000
assert native_timespan_usec('1.000001s') == 1000001
assert native_timespan_usec('1000000') == 1000000
`));

test('nonfinite malformed ambiguous fractional and oversized durations fail closed',()=>run(`
for value in ('infinity','[n/a]','-1s','1e3s','2h57min','2h  57min','2h ',' 2h','1s 1h','1s 1s','0.0000001s','0.1us','9223372036854775808','9'*129):
 try:
  native_timespan_usec(value)
 except RuntimeError:
  pass
 else:
  raise AssertionError(value)
`));

const fixture = `
name='address-radar-preservation-expiry-f3bc958ccb499ce6'
argv=['/usr/bin/python3','/fixed-reviewed/helper.py','cleanup','--nonce','f3bc958ccb499ce6']
t={'Id':name+'.timer','LoadState':'loaded','ActiveState':'active','SubState':'waiting','Transient':'yes','AccuracyUSec':'1s','TimersCalendar':'','Triggers':name+'.service','TimersMonotonic':'{ OnActiveUSec=2h 57min 54s ; next_elapse=1w 23h 32min 54.719554s }','ActiveEnterTimestampMonotonic':'123000000'}
s={'Id':name+'.service','LoadState':'loaded','ActiveState':'inactive','SubState':'dead','Transient':'yes','Type':'oneshot','User':'root','TimeoutStartUSec':'4min','Restart':'no','KillMode':'control-group','ExecStart':'{ path=/usr/bin/python3 ; argv[]='+' '.join(argv)+' ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }'}
def props(unit,keys):
 return t if unit.endswith('.timer') else s
`;
test('actual timer_verify accepts observed composite interval without relaxing command binding',()=>run(fixture+`
assert timer_verify(name,argv,10674,240) == 10797
for field,value in (('AccuracyUSec','2s'),('Triggers','unrelated.service'),('TimersMonotonic','{ OnActiveUSec=2h 57min 55s ; next_elapse=1s }')):
 original=t[field];t[field]=value
 try:
  timer_verify(name,argv,10674,240)
 except RuntimeError:
  pass
 else:
  raise AssertionError(field)
 t[field]=original
for field,value in (('User','postgres'),('TimeoutStartUSec','241s'),('ExecStart',s['ExecStart'].replace('cleanup','arm')),('KillMode','process')):
 original=s[field];s[field]=value
 try:
  timer_verify(name,argv,10674,240)
 except RuntimeError:
  pass
 else:
  raise AssertionError(field)
 s[field]=original
`));
