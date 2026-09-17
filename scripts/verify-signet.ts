// Opt-in real signet transfer test. Requires a funded isolated sender and isolated database.
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pool, tx } from '../src/lib/db';
import { config } from '../src/lib/config';
import { ensureRound, settle, payOutgoing } from '../src/lib/engine';
import { proposalMessage } from '../src/lib/payment-auth';
import { ark } from '../src/lib/ark';
if (!config.DATABASE_URL.endsWith('/btcbet_signet_verify') || config.ARK_ADAPTER !== 'second') throw Error('Requires isolated signet verification database');
const endpoint = 'http://btcbet-signet-test:3085/btcbet/api/v1';
const cli = (...args: string[]) => execFileSync('bark', ['--quiet','--no-logfile','--datadir','/sender',...args], {encoding:'utf8',timeout:60000}).trim();
const returnAddress = cli('address');
const initial = JSON.parse(cli('balance')).spendable_sat;
assert(initial >= 3000);
const start = Math.floor(Date.now()/300000)*300000;
if (Date.now()-start>180000) throw Error('Start during first three minutes of round');
const roundId = await tx(db=>ensureRound(db));
const post = async (path: string, body: unknown) => {
  const response=await fetch(endpoint+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const result=await response.json();
  if(response.status>=500) console.log(result);
  return {status:response.status,body:result};
};
const verified: string[]=[];
for (const [direction, paid] of [['UP',1000],['DOWN',1000],['UP',999]] as const) {
  const keys=generateKeyPairSync('ed25519');
  const p={agentPublicKey:Buffer.from(keys.publicKey.export({format:'jwk'}).x!,'base64url').toString('hex'),name:'Signet verification',roundId,direction,amountSats:1000,returnAddress,idempotencyKey:randomUUID()};
  const proposal={...p,signature:sign(null,Buffer.from(proposalMessage(p)),keys.privateKey).toString('hex')};
  const r=await post('/payment-auth/challenge',proposal);
  assert.equal(r.status,402,JSON.stringify(r.body));
  assert.equal(r.body.mode,'second');
  assert.equal((await post('/payment-auth/challenge',proposal)).body.challengeId,r.body.challengeId);
  const proof={challengeId:r.body.challengeId,signature:sign(null,Buffer.from(r.body.challenge),keys.privateKey).toString('hex')};
  assert.equal((await post('/payment-auth/confirm',proof)).status,402);
  console.log('402 challenge verified; paying',paid,'signet sats',r.body.betId);
  cli('send',r.body.payment.destination,`${paid} sats`,'--wait');
  await ark.prepareReconciliation?.();
  // The web process maintains its own short wallet-history cache.
  await new Promise(r=>setTimeout(r,5500));
  const confirmed=await post('/payment-auth/confirm',proof);
  assert.equal(confirmed.status,paid===1000?200:409,JSON.stringify(confirmed.body));
  if(paid===1000) {
    assert.equal(confirmed.body.status,'AUTHENTICATED');
    const replay=await post('/payment-auth/confirm',proof);
    assert.equal(replay.body.accessToken,confirmed.body.accessToken);
    const bet=await fetch(endpoint+'/bets/'+r.body.betId,{headers:{Authorization:'Bearer '+confirmed.body.accessToken}});
    assert.equal(bet.status,200);
    assert.equal((await bet.json()).status,'ACCEPTED');
    verified.push(r.body.betId);
  } else assert.equal(confirmed.body.accessToken,undefined);
  console.log(paid===1000?'Authenticated, private bet read and replay verified':'Mismatched payment refused authentication');
}
// Deterministic oracle only in this isolated database; transfers are real signet.
for (const [offset,price] of [[0,100],[1000,100],[2000,100],[295000,101],[296000,101],[297000,101]]) {
 await pool.query('INSERT INTO price_observations(provider,pair,provider_at,received_at,price,sequence,payload) VALUES($1,$2,$3,$3,$4,$5,$6)',[config.PRICE_PROVIDER,config.PRICE_PAIR,new Date(start+offset),price,randomUUID(),{}]);
}
await settle(roundId,new Date(start+304000));
await payOutgoing(ark);
const outgoing=(await pool.query('SELECT o.status,s.kind,s.amount FROM outgoing_payments o JOIN settlement_obligations s ON s.id=o.id')).rows;
assert.equal(outgoing.length,2);
assert(outgoing.every(x=>x.status==='CONFIRMED'),JSON.stringify(outgoing));
assert(outgoing.some(x=>x.kind==='PAYOUT'&&x.amount==='2000'));
assert(outgoing.some(x=>x.kind==='REFUND'&&x.amount==='999'));
const final=JSON.parse(cli('balance')).spendable_sat;
assert.equal(final,initial,'All signet test funds returned');
console.log(JSON.stringify({verified:true,roundId,bets:verified,outgoing,senderBalance:final}));
await pool.end();
