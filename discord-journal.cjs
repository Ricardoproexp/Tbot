'use strict';
const crypto=require('node:crypto');
const zlib=require('node:zlib');
const {DatabaseSync}=require('node:sqlite');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const PREFIX='TPLJ1:';
class DiscordJournal {
  constructor({channel,authorId,secret}) {
    this.channel=channel;this.authorId=authorId;
    this.key=crypto.createHash('sha256').update('tbot-discord-journal-v1:'+secret).digest();
    this.seq=0;this.head='0'.repeat(64);this.broken=false;
  }
  seal(value) {
    const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',this.key,iv);
    const data=Buffer.concat([c.update(zlib.deflateSync(Buffer.from(JSON.stringify(value)))),c.final()]);
    return Buffer.concat([iv,c.getAuthTag(),data]).toString('base64url');
  }
  open(encoded) {
    const b=Buffer.from(encoded,'base64url');const d=crypto.createDecipheriv('aes-256-gcm',this.key,b.subarray(0,12));
    d.setAuthTag(b.subarray(12,28));
    const raw=Buffer.concat([d.update(b.subarray(28)),d.final()]);
    return JSON.parse(zlib.inflateSync(raw,{maxOutputLength:262144}).toString());
  }
  async recover(apply) {
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tbot-history-'));
    const db=new DatabaseSync(path.join(dir,'history.sqlite'));
    db.exec('CREATE TABLE parts(seq INTEGER,part INTEGER,total INTEGER,hash TEXT,data TEXT,PRIMARY KEY(seq,part))');
    try {
      let before;
      for(;;) {
        const page=await this.channel.messages.fetch({limit:100,...(before?{before}:{}),cache:false});
        if(!page.size) break;
        let oldest;
        for(const m of page.values()) {
          if(!oldest || BigInt(m.id)<BigInt(oldest))oldest=m.id;
          if(m.author.id!==this.authorId || !m.content.startsWith(PREFIX))continue;
          const match=/^TPLJ1:(\d+):(\d+):(\d+):([a-f0-9]{64}):([A-Za-z0-9_-]+)$/.exec(m.content);
          if(!match)throw Error('journal_invalid_message');
          const [,ss,pp,tt,hash,data]=match,seq=Number(ss),part=Number(pp),total=Number(tt);
          if(!Number.isSafeInteger(seq)||seq<1||part<1||part>total||total>256)throw Error('journal_invalid_sequence');
          const old=db.prepare('SELECT * FROM parts WHERE seq=? AND part=?').get(seq,part);
          if(old&&(old.hash!==hash||old.data!==data||old.total!==total))throw Error('journal_conflict_multiple_instances');
          db.prepare('INSERT OR IGNORE INTO parts VALUES(?,?,?,?,?)').run(seq,part,total,hash,data);
        }
        if(before && BigInt(oldest)>=BigInt(before))throw Error('journal_pagination_stalled');
        before=oldest;
      }
      // Use disk for history; only one journal record is held in RAM at a time.
      for(const row of db.prepare('SELECT DISTINCT seq FROM parts ORDER BY seq').iterate()) {
        const parts=db.prepare('SELECT * FROM parts WHERE seq=? ORDER BY part').all(row.seq);
        if(row.seq!==this.seq+1 || parts.length!==parts[0].total)throw Error('journal_missing_messages');
        if(parts.some((p,i)=>p.part!==i+1||p.hash!==parts[0].hash||p.total!==parts.length))throw Error('journal_invalid_parts');
        const text=parts.map(p=>p.data).join('');
        const hash=crypto.createHash('sha256').update(text).digest('hex');
        if(hash!==parts[0].hash)throw Error('journal_hash_mismatch');
        const record=this.open(text);
        if(record.v!==1 || record.seq!==row.seq || record.prev!==this.head)throw Error('journal_chain_mismatch');
        apply(record.entry);this.seq=row.seq;this.head=hash;
      }
    } catch(e) {this.broken=true;throw e;}
    finally {db.close();fs.rmSync(dir,{recursive:true,force:true});}
  }
  async append(entry) {
    if(this.broken)throw Error('journal_restart_required');
    const seq=this.seq+1,text=this.seal({v:1,seq,prev:this.head,entry});
    const hash=crypto.createHash('sha256').update(text).digest('hex');
    const parts=text.match(/.{1,1700}/g);
    if(parts.length>256)throw Error('journal_record_too_large');
    try {
      for(let i=0;i<parts.length;i++) {
        const content=`TPLJ1:${seq}:${i+1}:${parts.length}:${hash}:${parts[i]}`;
        // Discord's short-lived nonce deduplication is extra protection, not the ledger.
        const nonce=crypto.createHmac('sha256',this.key).update(`${seq}:${i}`).digest('hex').slice(0,25);
        const m=await this.channel.send({content,nonce,enforceNonce:true,allowedMentions:{parse:[]}});
        if(m.content!==content)throw Error('journal_conflict_multiple_instances');
      }
      this.seq=seq;this.head=hash;
    } catch {this.broken=true;throw Error('journal_write_uncertain_restart_required');}
  }
}
module.exports={DiscordJournal};
