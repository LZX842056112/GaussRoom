import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {X509Certificate} from 'node:crypto';
import {createServer, get} from 'node:https';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const load = () => import('./lib/mobile-tls.mjs');
const day = 86400000;
test('renewal checks the complete address set and the fourteen day boundary', async () => {
  const {needsCertificateRenewal} = await load();
  const now = Date.UTC(2026, 10, 4);
  const metadata = {addresses:['127.0.0.1','192.168.1.4'],expiresAt:new Date(now+15*day).toISOString()};
  assert.equal(needsCertificateRenewal(metadata,{addresses:['192.168.1.4'],now}), false);
  assert.equal(needsCertificateRenewal(metadata,{addresses:['192.168.1.5'],now}), true);
  assert.equal(needsCertificateRenewal(metadata,{addresses:['192.168.1.4'],now:now+day}), false);
  assert.equal(needsCertificateRenewal(metadata,{addresses:['192.168.1.4'],now:now+day+1}), true);
  assert.equal(needsCertificateRenewal({}, {addresses:[],now}), true);
});

test('public addresses and unsafe TLS directory roots are rejected with sanitized errors', async () => {
  const {ensureMobileCertificates} = await load();
  for (const options of [{root:join(tmpdir(),'unused-tls'),addresses:['8.8.8.8']},{root:process.platform==='win32'?'C:\\':'/',addresses:[]}]) {
    await assert.rejects(ensureMobileCertificates(options), error => error.code===503 && !error.message.includes(options.root));
  }
});

test('native certificates support HTTPS, CA reuse, renewal, and public installation artifacts', {skip:process.platform!=='win32',timeout:120000}, async () => {
  const {ensureMobileCertificates} = await load();
  const fixture = await mkdtemp(join(tmpdir(),'gaussroom-tls-'));
  const root = join(fixture,'tls');
  const now = Date.now();
  try {
    const first = await ensureMobileCertificates({root,addresses:['192.168.1.4','192.168.1.4'],now});
    assert.deepEqual(first.addresses,['127.0.0.1','192.168.1.4']);
    const ca = new X509Certificate(first.caDer);
    assert.equal(ca.ca,true);
    assert.equal(ca.fingerprint256,first.fingerprint);
    assert.ok(Date.parse(ca.validTo)>now+1824*day);
    assert.equal(new X509Certificate(first.caPem).fingerprint256,first.fingerprint);
    const server = createServer({pfx:first.pfx,passphrase:first.passphrase},(_req,res)=>res.end('camera secure'));
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    try {
      const result = await new Promise((resolve,reject)=>get({hostname:'127.0.0.1',port:server.address().port,ca:first.caPem},res=>{
        const certificate=res.socket.getPeerCertificate(true);
        let body='';res.on('data',x=>body+=x);res.on('end',()=>resolve({body,certificate}));
      }).on('error',reject));
      assert.equal(result.body,'camera secure');
      const leaf = new X509Certificate(result.certificate.raw);
      assert.ok(leaf.checkIP('192.168.1.4'));
      assert.ok(leaf.checkIP('127.0.0.1'));
      assert.ok(leaf.checkHost('localhost'));
      assert.equal(leaf.checkIP('192.168.1.5'),undefined);
      assert.ok(Date.parse(leaf.validTo)>now+89*day);
      assert.ok(Date.parse(leaf.validTo)<=now+91*day);
      assert.ok(leaf.verify(ca.publicKey));
    } finally {await new Promise(resolve=>server.close(resolve));}
    const profile = first.profile.toString('utf8');
    assert.ok(profile.includes('<string>com.apple.security.root</string>'));
    assert.ok(profile.includes(first.caDer.toString('base64')));
    assert.ok(!profile.includes(first.passphrase));
    assert.ok(!profile.includes(first.pfx.toString('base64')));
    assert.ok(!profile.includes('PRIVATE KEY'));
    const second = await ensureMobileCertificates({root,addresses:['192.168.1.4'],now});
    assert.deepEqual(second.pfx,first.pfx);
    const moved = await ensureMobileCertificates({root,addresses:['192.168.1.5'],now});
    assert.equal(moved.fingerprint,first.fingerprint);
    assert.notDeepEqual(moved.pfx,first.pfx);
    assert.deepEqual(moved.addresses,['127.0.0.1','192.168.1.5']);
    const renewed = await ensureMobileCertificates({root,addresses:['192.168.1.5'],now:now+77*day});
    assert.equal(renewed.fingerprint,first.fingerprint);
    assert.notDeepEqual(renewed.pfx,moved.pfx);
    assert.ok(Date.parse(renewed.expiresAt)>now+166*day);
    const aclCommand = `$a=[System.IO.Directory]::GetAccessControl('${root.replaceAll("'","''")}'); [pscustomobject]@{Protected=$a.AreAccessRulesProtected; Sids=@($a.Access | ForEach-Object {$_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value})} | ConvertTo-Json -Compress`;
    const acl = await promisify(execFile)('powershell.exe',['-NoProfile','-Command',aclCommand],{windowsHide:true});
    const permissions = JSON.parse(acl.stdout);
    assert.equal(permissions.Protected,true);
    assert.ok(permissions.Sids.includes('S-1-5-18'));
    assert.equal(permissions.Sids.length,2);
    assert.deepEqual(await readdir(root),['current.json']);
  } finally {await rm(fixture,{recursive:true,force:true});}
});

test('a failed renewal preserves the existing bundle and does not disclose private data', {skip:process.platform!=='win32',timeout:60000}, async () => {
  const {ensureMobileCertificates} = await load();
  const fixture=await mkdtemp(join(tmpdir(),'gaussroom-tls-fail-')),root=join(fixture,'tls');
  try {
    const first=await ensureMobileCertificates({root,addresses:['10.0.0.4']});
    const path=join(root,'current.json'), original=await readFile(path,'utf8');
    const broken=JSON.parse(original);broken.caPfx='invalid private key';
    await writeFile(path,JSON.stringify(broken));
    const before=await readFile(path,'utf8');
    await assert.rejects(ensureMobileCertificates({root,addresses:['10.0.0.5']}),error=>error.code===503&&!error.message.includes(first.passphrase)&&!error.message.includes(root));
    assert.equal(await readFile(path,'utf8'),before);
    await writeFile(path,original);
    const recovered=await ensureMobileCertificates({root,addresses:['10.0.0.4']});
    assert.deepEqual(recovered.pfx,first.pfx);
    assert.deepEqual(await readdir(root),['current.json']);
  } finally {await rm(fixture,{recursive:true,force:true});}
});
