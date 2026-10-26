import {test} from 'node:test';
import assert from 'node:assert/strict';
import {encrypt,decrypt,isPublicAddress,signWebhook,validWebhookSignature} from './index.js';
test('secret encryption is authenticated',()=>{process.env.SECRET_ENCRYPTION_KEY=Buffer.alloc(32,7).toString('base64');const encrypted=encrypt('private');assert.equal(decrypt(encrypted),'private');assert.throws(()=>decrypt(encrypted.slice(0,-2)+'aa'));});
test('blocks private and local addresses',()=>{for(const ip of ['127.0.0.1','10.1.2.3','169.254.169.254','192.168.1.1','::1','fc00::1'])assert.equal(isPublicAddress(ip),false);assert.equal(isPublicAddress('1.1.1.1'),true);});
test('validates webhook HMAC',()=>{const body=Buffer.from('{"ok":true}');const signature='sha256='+signWebhook('key','100',body);assert.equal(validWebhookSignature('key','100',body,signature),true);assert.equal(validWebhookSignature('wrong','100',body,signature),false);});
