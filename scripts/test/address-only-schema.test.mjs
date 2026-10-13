import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {verifyLedger} from '../apply-address-only-service-schema.mjs';
const migration={version:1,fingerprint:'a',previousFingerprint:'b',modules:['m']};
const row={version:1,fingerprint:'a',previous_fingerprint:'b',modules_json:'["m"]'};
test('exact complete ledger accepted',()=>assert.doesNotThrow(()=>verifyLedger([row],{migrations:[migration]})));
test('missing version refused',()=>assert.throws(()=>verifyLedger([],{migrations:[migration]})));
test('changed modules refused',()=>assert.throws(()=>verifyLedger([{...row,modules_json:'[]'}],{migrations:[migration]})));
