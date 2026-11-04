import {execFile} from 'node:child_process';
import {createHash, X509Certificate} from 'node:crypto';
import {lstatSync, readFileSync} from 'node:fs';
import {isIP} from 'node:net';
import {dirname, isAbsolute, join, parse, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {createSecureContext} from 'node:tls';

const run = promisify(execFile);
const script = fileURLToPath(new URL('../scripts/mobile-certificates.ps1',import.meta.url));
const day = 86400000;
const pending = new Map();
const unavailable = () => Object.assign(new Error('无法准备手机 HTTPS 证书。请检查电脑时间和证书目录权限，然后重试。'),{code:503});

function certificateAddresses(addresses) {
  if (!Array.isArray(addresses)) throw unavailable();
  const result = new Set(['127.0.0.1']);
  for (const address of addresses) {
    if (typeof address!=='string' || isIP(address)!==4 || !(address==='127.0.0.1' || /^10\./.test(address) || /^192\.168\./.test(address) || /^172\.(1[6-9]|2\d|3[01])\./.test(address) || /^169\.254\./.test(address))) throw unavailable();
    result.add(address);
  }
  return [...result].sort();
}

export function needsCertificateRenewal(metadata,{addresses,now=Date.now()}) {
  const expected = certificateAddresses(addresses);
  return !metadata || !Array.isArray(metadata.addresses) || JSON.stringify([...metadata.addresses].sort())!==JSON.stringify(expected) || !Number.isFinite(Date.parse(metadata.expiresAt)) || Date.parse(metadata.expiresAt)-now<14*day;
}

function validatePath(root) {
  if (typeof root!=='string' || !isAbsolute(root) || root.includes('\0')) throw unavailable();
  const target = resolve(root);
  if (target===parse(target).root || (process.platform==='win32' && !/^[a-z]:\\/i.test(target))) throw unavailable();
  for (let part=target;;part=dirname(part)) {
    try {if (lstatSync(part).isSymbolicLink()) throw unavailable();} catch (error) {if (error.code!=='ENOENT') throw error;}
    if (part===dirname(part)) break;
  }
  return target;
}

function publicProfile(caDer,fingerprint,profileId,caPayloadId) {
  if (!/^[a-f0-9-]{36}$/i.test(profileId) || !/^[a-f0-9-]{36}$/i.test(caPayloadId)) throw unavailable();
  const identifier = `local.gaussroom.camera.${fingerprint.replaceAll(':','').toLowerCase()}`;
  return Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>PayloadContent</key><array><dict>
<key>PayloadType</key><string>com.apple.security.root</string>
<key>PayloadVersion</key><integer>1</integer>
<key>PayloadIdentifier</key><string>${identifier}.root</string>
<key>PayloadUUID</key><string>${caPayloadId}</string>
<key>PayloadDisplayName</key><string>GaussRoom Camera Root CA</string>
<key>PayloadCertificateFileName</key><string>GaussRoom-Root-CA.cer</string>
<key>PayloadContent</key><data>${caDer.toString('base64')}</data>
</dict></array>
<key>PayloadType</key><string>Configuration</string>
<key>PayloadVersion</key><integer>1</integer>
<key>PayloadIdentifier</key><string>${identifier}</string>
<key>PayloadUUID</key><string>${profileId}</string>
<key>PayloadDisplayName</key><string>GaussRoom Camera HTTPS</string>
<key>PayloadDescription</key><string>Install this certificate only for your GaussRoom computer. Then enable full trust in Certificate Trust Settings.</string>
<key>PayloadRemovalDisallowed</key><false/>
</dict></plist>\n`,'utf8');
}

/** Private keys stay in root/current.json. Only caDer and profile may be downloaded. */
export async function ensureMobileCertificates({root,addresses,now=Date.now()}) {
  try {
    root=validatePath(root);
    addresses=certificateAddresses(addresses);
    if (process.platform!=='win32' || !Number.isFinite(now) || now<0) throw unavailable();
    // Serialize refreshes for this directory so concurrent starts keep the same CA.
    const task=(pending.get(root)??Promise.resolve()).catch(()=>{}).then(async()=>{
      await run('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script,'-Root',root,'-AddressesBase64',Buffer.from(JSON.stringify(addresses)).toString('base64'),'-Now',String(Math.trunc(now))],{windowsHide:true,timeout:45000,maxBuffer:1024*1024});
      validatePath(root);
      const path=join(root,'current.json');
      if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw unavailable();
      const bundle=JSON.parse(readFileSync(path,'utf8'));
      const pfx=Buffer.from(bundle.pfx,'base64'),caDer=Buffer.from(bundle.caDer,'base64');
      const ca=new X509Certificate(caDer),leaf=new X509Certificate(Buffer.from(bundle.leafDer,'base64'));
      if (!ca.ca || !leaf.verify(ca.publicKey) || !leaf.checkHost('localhost') || addresses.some(a=>!leaf.checkIP(a)) || Date.parse(leaf.validTo)<=now || Date.parse(leaf.validFrom)>now) throw unavailable();
      createSecureContext({pfx,passphrase:bundle.passphrase});
      const fingerprint=createHash('sha256').update(caDer).digest('hex').toUpperCase().match(/../g).join(':');
      return {pfx,passphrase:bundle.passphrase,caDer,caPem:ca.toString(),profile:publicProfile(caDer,fingerprint,bundle.profileId,bundle.caPayloadId),fingerprint,expiresAt:new Date(leaf.validTo).toISOString(),addresses};
    });
    pending.set(root,task);
    try {return await task;} finally {if(pending.get(root)===task)pending.delete(root);}
  } catch (cause) {throw Object.assign(unavailable(),{cause});}
}
