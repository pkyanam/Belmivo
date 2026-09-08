import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, openSync, closeSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { InboundMessage } from './types.js';

export type JobState = 'queued' | 'running' | 'completed' | 'sending' | 'sent' | 'failed' | 'uncertain';
export type State = JobState;
export const EXTERNAL_HANDOFF_REASON = 'Reserved for external handoff; no local execution';
export const UNCERTAIN_NOTICE = "I couldn't confirm the task's outcome. This chat is paused for review. Check the task on your Mac.";
export type CancellationOutcome = 'not-started' | 'interrupted' | 'completed' | 'failed' | 'unknown';
const cancellationReplies: Record<CancellationOutcome, string> = {
  'not-started': 'Canceled before the agent started. You can send your next request.',
  interrupted: 'Stopped. You can send your next request. Changes already made are kept; this request will not run again.',
  completed: 'The task finished before the stop took effect. You can send your next request. This request will not run again.',
  failed: 'The task ended before the stop took effect. You can send your next request. Changes already made are kept; this request will not run again.',
  unknown: "I couldn't confirm that the task stopped. This chat is paused for review. Check the task on your Mac before continuing; it will not run again automatically.",
};
export interface JobNotice { jobId:string; message:InboundMessage; text:string }
export interface Job {
  id: string;
  conversationKey: string;
  message: InboundMessage;
  state: JobState;
  reply?: string;
  turnId?: string;
  providerMessageId?: string;
  reason?: string;
}

type Row = Record<string, unknown>;
const states: JobState[] = ['queued', 'running', 'completed', 'sending', 'sent', 'failed', 'uncertain'];
const pendingStates = "'queued','running','completed','sending','uncertain'";

export function conversationKey(message: InboundMessage): string {
  return JSON.stringify([message.provider, message.recipient, message.sender, message.conversationId]);
}

function canonicalContent(message: InboundMessage): string {
  return JSON.stringify([conversationKey(message), message.messageId, message.text, message.isGroup,
    message.attachments.map(a => [a.url, a.name ?? null, a.mimeType ?? null])]);
}

function job(row: Row): Job {
  return {
    id: String(row.id), conversationKey: String(row.conversation_key),
    message: JSON.parse(String(row.message)) as InboundMessage, state: row.state as JobState,
    ...(row.reply === null ? {} : { reply: String(row.reply) }),
    ...(row.turn_id === null ? {} : { turnId: String(row.turn_id) }),
    ...(row.provider_message_id === null ? {} : { providerMessageId: String(row.provider_message_id) }),
    ...(row.reason === null ? {} : { reason: String(row.reason) }),
  };
}

export class Store {
  private readonly db: DatabaseSync;

  constructor(dbPath: string, options: { readOnly?: boolean } = {}) {
    if (options.readOnly && dbPath === ':memory:') throw new Error('Read-only inspection requires an existing database');
    if (dbPath !== ':memory:') {
      const directory = dirname(dbPath);
      if (options.readOnly && !existsSync(dbPath)) throw new Error('No bridge database to inspect');
      if (!existsSync(directory)) {
        if (options.readOnly) throw new Error('No bridge database to inspect');
        mkdirSync(directory, { recursive: true, mode: 0o700 });
      }
      const parent = lstatSync(directory);
      if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error('Database directory must be a real directory');
      // Do not chmod an arbitrary existing parent such as the project directory.
      if ((parent.mode & 0o077) !== 0) throw new Error('Database directory must be private (chmod 700)');
      if (existsSync(dbPath)) {
        const file = lstatSync(dbPath);
        if (!file.isFile() || file.isSymbolicLink()) throw new Error('Database must be a regular file');
        if (options.readOnly) {
          if ((file.mode & 0o077) !== 0 || file.uid !== process.getuid?.() || file.nlink !== 1) throw new Error('Database inspection requires a private, owned file');
        } else chmodSync(dbPath, 0o600);
      } else {
        if (options.readOnly) throw new Error('No bridge database to inspect');
        closeSync(openSync(dbPath, 'wx', 0o600));
      }
    }
    this.db = new DatabaseSync(dbPath, { readOnly: options.readOnly ?? false });
    try {
    const version = Number(this.db.prepare('PRAGMA user_version').get()!.user_version);
    if (version > 4) {
      throw new Error('Database schema is newer than this bridge; upgrade the bridge');
    }
    if (options.readOnly) {
      if (version < 1) {
        throw new Error('Database schema needs an explicit bridge upgrade before inspection');
      }
      // Connection settings only: diagnostics must not create tables, migrate
      // versions, alter file permissions or choose a journal mode.
      this.db.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 5000;');
      return;
    }
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS jobs (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        provider TEXT NOT NULL,
        message_id TEXT NOT NULL,
        conversation_key TEXT NOT NULL,
        message TEXT NOT NULL,
        canonical_content TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN (${states.map(s => `'${s}'`).join(',')})),
        reply TEXT, turn_id TEXT, provider_message_id TEXT, reason TEXT,
        UNIQUE(provider, message_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS events (
        provider TEXT NOT NULL, event_id TEXT NOT NULL,
        job_id TEXT NOT NULL REFERENCES jobs(id),
        PRIMARY KEY(provider, event_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS conversations (
        conversation_key TEXT PRIMARY KEY, thread_id TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS jobs_state_sequence ON jobs(state, sequence);
      CREATE TABLE IF NOT EXISTS thread_sessions (
        number INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_key TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        title TEXT NOT NULL,
        initialized INTEGER NOT NULL DEFAULT 0 CHECK(initialized IN (0,1)),
        UNIQUE(conversation_key,thread_id)
      ) STRICT;
      INSERT INTO thread_sessions(conversation_key,thread_id,title)
        SELECT c.conversation_key,c.thread_id,'Original task' FROM conversations c
        WHERE NOT EXISTS (SELECT 1 FROM thread_sessions t WHERE t.conversation_key=c.conversation_key AND t.thread_id=c.thread_id);
      CREATE TABLE IF NOT EXISTS job_notices (
        job_id TEXT PRIMARY KEY REFERENCES jobs(id),
        text TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('queued','sending','sent','uncertain','skipped')),
        provider_message_id TEXT
      ) STRICT;
      CREATE TABLE IF NOT EXISTS job_cancellations (
        control_job_id TEXT PRIMARY KEY REFERENCES jobs(id),
        target_job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id),
        state TEXT NOT NULL CHECK(state IN ('requested','confirmed','unconfirmed')),
        outcome TEXT,
        CHECK(control_job_id <> target_job_id),
        CHECK((state='requested' AND outcome IS NULL)
          OR (state='confirmed' AND outcome IS NOT NULL AND outcome IN ('not-started','interrupted','completed','failed'))
          OR (state='unconfirmed' AND outcome IS NOT NULL AND outcome='unknown'))
      ) STRICT;
      PRAGMA user_version = 4;
    `);
    } catch (error) {
      try { this.db.close(); } catch { /* Preserve the original database error. */ }
      throw error;
    }
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  enqueue(message: InboundMessage, maxPending: number, immediateReply?: string, cancelTargetId?: string): 'queued' | 'duplicate' | 'full' {
    return this.admit(message,maxPending,'queue',immediateReply,cancelTargetId);
  }

  /** Caller has already authenticated, authorized and matched an exact private
   * handoff selector. Existing jobs never change disposition through this API. */
  reserveExternalHandoff(message: InboundMessage, maxPending: number): 'reserved' | 'duplicate' | 'full' | 'already-admitted' {
    return this.admit(message,maxPending,'external-handoff');
  }

  private admit(message: InboundMessage, maxPending: number, disposition:'queue', immediateReply?:string, cancelTargetId?:string):'queued'|'duplicate'|'full';
  private admit(message: InboundMessage, maxPending: number, disposition:'external-handoff'):'reserved'|'duplicate'|'full'|'already-admitted';
  private admit(message: InboundMessage, maxPending: number, disposition:'queue'|'external-handoff', immediateReply?:string, cancelTargetId?:string):'queued'|'reserved'|'duplicate'|'full'|'already-admitted' {
    if (!Number.isSafeInteger(maxPending) || maxPending < 1) throw new Error('maxPending must be a positive integer');
    if (!message.messageId || !message.eventId) throw new Error('Message and event IDs are required');
    return this.transaction(() => {
      const content = canonicalContent(message);
      const event = this.db.prepare(`SELECT jobs.* FROM events JOIN jobs ON jobs.id = events.job_id
        WHERE events.provider = ? AND events.event_id = ?`).get(message.provider, message.eventId);
      const existing = this.db.prepare('SELECT * FROM jobs WHERE provider = ? AND message_id = ?')
        .get(message.provider, message.messageId);
      for (const prior of [event, existing]) {
        if (prior && prior.canonical_content !== content) throw new Error('Provider reused an identifier with conflicting message content');
      }
      if (event || existing) {
        const prior = event ?? existing!;
        this.db.prepare('INSERT OR IGNORE INTO events(provider,event_id,job_id) VALUES(?,?,?)')
          .run(message.provider, message.eventId, String(prior.id));
        if(disposition==='external-handoff' && (prior.state!=='failed'||prior.reason!==EXTERNAL_HANDOFF_REASON))return 'already-admitted';
        return 'duplicate';
      }
      let cancellationExists = false;
      if (cancelTargetId !== undefined) {
        const target = this.db.prepare('SELECT conversation_key,state FROM jobs WHERE id=?').get(cancelTargetId);
        if (!target || target.conversation_key !== conversationKey(message) || target.state !== 'running') {
          throw new Error('Cancellation target must be running in the same conversation');
        }
        cancellationExists = !!this.db.prepare('SELECT 1 FROM job_cancellations WHERE target_job_id=?').get(cancelTargetId);
      }
      const count = this.db.prepare(`SELECT COUNT(*) AS count FROM jobs WHERE state IN (${pendingStates})`).get()!;
      if (Number(count.count) >= maxPending) return 'full';
      const id = randomUUID();
      this.db.prepare(`INSERT INTO jobs(id,provider,message_id,conversation_key,message,canonical_content,state,reason)
        VALUES(?,?,?,?,?,?,?,?)`).run(id, message.provider, message.messageId, conversationKey(message), JSON.stringify(message), content,
          disposition==='external-handoff'?'failed':'queued',disposition==='external-handoff'?EXTERNAL_HANDOFF_REASON:null);
      if (cancelTargetId !== undefined) {
        if (cancellationExists) {
          // A second distinct command retains its own dedup identity, while the
          // first control remains the sole owner of the phone acknowledgment.
          this.db.prepare("UPDATE jobs SET state='failed',reason=? WHERE id=?")
            .run('Stop already requested; original acknowledgment retained',id);
        } else {
          this.db.prepare("UPDATE jobs SET state='completed',reply=NULL WHERE id=?").run(id);
          this.db.prepare("INSERT INTO job_cancellations(control_job_id,target_job_id,state) VALUES(?,?,'requested')")
            .run(id,cancelTargetId);
        }
      } else if(immediateReply!==undefined)this.db.prepare("UPDATE jobs SET state='completed',reply=? WHERE id=?").run(immediateReply,id);
      this.db.prepare('INSERT INTO events(provider,event_id,job_id) VALUES(?,?,?)').run(message.provider, message.eventId, id);
      return disposition==='external-handoff'?'reserved':'queued';
    });
  }

  next(): Job | undefined {
    const row = this.db.prepare(`SELECT * FROM jobs AS queued WHERE queued.state = 'queued'
      AND NOT EXISTS (SELECT 1 FROM jobs WHERE state = 'running')
      AND NOT EXISTS (SELECT 1 FROM jobs AS blocked WHERE blocked.conversation_key = queued.conversation_key AND blocked.state = 'uncertain')
      ORDER BY sequence LIMIT 1`).get();
    return row ? job(row) : undefined;
  }

  start(id: string): void {
    this.transaction(() => {
      const candidate = this.next();
      if (candidate?.id !== id) throw new Error('Job is not the next runnable job');
      this.transition(id, 'queued', 'running');
    });
  }

  setThread(key: string, threadId: string, title = 'Untitled task'): void {
    if (!key || !threadId) throw new Error('Conversation and thread IDs are required');
    this.transaction(()=>{
      // Avoid burning a task number every time the backend resumes an existing task.
      this.db.prepare(`INSERT INTO thread_sessions(conversation_key,thread_id,title)
        SELECT ?,?,? WHERE NOT EXISTS (SELECT 1 FROM thread_sessions WHERE conversation_key=? AND thread_id=?)`).run(key,threadId,title.slice(0,80),key,threadId);
      this.db.prepare(`INSERT INTO conversations(conversation_key,thread_id) VALUES(?,?)
        ON CONFLICT(conversation_key) DO UPDATE SET thread_id = excluded.thread_id`).run(key, threadId);
    });
  }

  getThread(key: string): string | undefined {
    const row = this.db.prepare('SELECT thread_id FROM conversations WHERE conversation_key = ?').get(key);
    return row ? String(row.thread_id) : undefined;
  }

  recentActiveThreads(): { message: InboundMessage; threadId: string }[] {
    // Bound startup work before joining bindings. Old authorization is not
    // sufficient: callers must check each message against current policy.
    return this.db.prepare(`SELECT j.message,c.thread_id FROM
      (SELECT sequence,conversation_key,message FROM jobs ORDER BY sequence DESC LIMIT 100) j
      JOIN conversations c ON c.conversation_key=j.conversation_key
      ORDER BY j.sequence DESC`).all().map(row=>({message:JSON.parse(String(row.message)) as InboundMessage,threadId:String(row.thread_id)}));
  }

  listThreads(key:string):{number:number;threadId:string;title:string;active:boolean}[] {
    const active=this.getThread(key);
    return this.db.prepare('SELECT number,thread_id,title FROM thread_sessions WHERE conversation_key=? ORDER BY number DESC LIMIT 100').all(key).map(row=>({number:Number(row.number),threadId:String(row.thread_id),title:String(row.title),active:row.thread_id===active}));
  }

  switchThread(key:string,number:number):boolean {
    const row=this.db.prepare('SELECT thread_id FROM thread_sessions WHERE conversation_key=? AND number=?').get(key,number);
    if(!row)return false;
    this.setThread(key,String(row.thread_id));return true;
  }

  threadInitialized(key:string,threadId:string):boolean {
    return this.db.prepare('SELECT initialized FROM thread_sessions WHERE conversation_key=? AND thread_id=?').get(key,threadId)?.initialized===1;
  }

  markThreadInitialized(key:string,threadId:string):void {
    this.db.prepare('UPDATE thread_sessions SET initialized=1 WHERE conversation_key=? AND thread_id=?').run(key,threadId);
  }

  conversationStats(key:string, excludeJobId?:string):{queued:number;running:number;uncertain:number;delivering:number} {
    const result={queued:0,running:0,uncertain:0,delivering:0};
    for(const row of this.db.prepare("SELECT state,COUNT(*) AS count FROM jobs WHERE conversation_key=? AND id<>? AND state IN ('queued','running','uncertain','completed','sending') GROUP BY state").all(key,excludeJobId??'')) {
      const state=row.state==='completed'||row.state==='sending'?'delivering':row.state as keyof typeof result;
      result[state]+=Number(row.count);
    }
    return result;
  }

  setTurn(id: string, turnId: string): void {
    if (!turnId) throw new Error('Turn ID is required');
    const result = this.db.prepare("UPDATE jobs SET turn_id = ? WHERE id = ? AND state = 'running'").run(turnId, id);
    if (result.changes !== 1) throw new Error('Cannot set turn for a non-running job');
  }

  complete(id: string, reply: string): void {
    const result = this.db.prepare("UPDATE jobs SET state = 'completed', reply = ? WHERE id = ? AND state = 'running'").run(reply, id);
    if (result.changes !== 1) throw new Error('Cannot complete a non-running job');
  }

  pendingReplies(): Job[] {
    return this.db.prepare("SELECT * FROM jobs WHERE state = 'completed' AND reply IS NOT NULL ORDER BY sequence").all().map(job);
  }

  markSending(id: string, refreshedReply?: string): void {
    // Refresh read-only control snapshots atomically with the durable send claim.
    // A crash still recovers sending as uncertain; it never replays this text.
    const result=this.db.prepare("UPDATE jobs SET state='sending', reply=COALESCE(?,reply) WHERE id=? AND state='completed' AND reply IS NOT NULL").run(refreshedReply??null,id);
    if(result.changes!==1)throw new Error('Cannot mark a non-completed job sending');
  }

  markSent(id: string, providerMessageId: string): void {
    const result = this.db.prepare("UPDATE jobs SET state = 'sent', provider_message_id = ? WHERE id = ? AND state = 'sending'")
      .run(providerMessageId, id);
    if (result.changes !== 1) throw new Error('Cannot mark a non-sending job sent');
  }

  fail(id: string, reason: string): void {
    const result = this.db.prepare("UPDATE jobs SET state = 'failed', reason = ? WHERE id = ? AND state IN ('queued','running','completed')")
      .run(reason, id);
    if (result.changes !== 1) throw new Error('Cannot fail a terminal or possibly delivered job');
  }

  uncertain(id: string, reason: string): void {
    this.transaction(()=>{
      const prior=this.db.prepare('SELECT state FROM jobs WHERE id=?').get(id);
      const result = this.db.prepare("UPDATE jobs SET state = 'uncertain', reason = ? WHERE id = ? AND state IN ('running','sending')")
        .run(reason, id);
      if (result.changes !== 1) throw new Error('Only active execution or delivery can become uncertain');
      if(prior?.state==='running')this.queueNotice(id);
    });
  }

  cancellationRequested(targetId: string): boolean {
    return this.db.prepare("SELECT 1 FROM job_cancellations WHERE target_job_id=? AND state='requested'").get(targetId) !== undefined;
  }

  /** Only remove readiness claims at send time; never upgrade a stop outcome. */
  cancellationReply(controlId: string): string | undefined {
    const row=this.db.prepare(`SELECT j.reply,j.conversation_key,c.state FROM jobs j
      JOIN job_cancellations c ON c.control_job_id=j.id WHERE j.id=? AND j.state='completed' AND j.reply IS NOT NULL`).get(controlId);
    if(!row)return undefined;
    const reply=String(row.reply);
    if(row.state==='confirmed' && this.db.prepare("SELECT 1 FROM jobs WHERE conversation_key=? AND state='uncertain' LIMIT 1").get(String(row.conversation_key))) {
      return reply.replace('You can send your next request.','This chat has a separate outcome awaiting review. Use /status for details.');
    }
    return reply;
  }

  finishCancellation(targetId: string, outcome: CancellationOutcome): void {
    if (!Object.hasOwn(cancellationReplies,outcome)) throw new Error('Invalid cancellation outcome');
    this.transaction(() => this.settleCancellation(targetId,outcome));
  }

  private settleCancellation(targetId: string, outcome: CancellationOutcome): number {
    const cancellation = this.db.prepare('SELECT * FROM job_cancellations WHERE target_job_id=?').get(targetId);
    if (!cancellation) throw new Error('No cancellation was requested for this job');
    if (cancellation.state !== 'requested') {
      if (cancellation.outcome === outcome) return 0;
      throw new Error('Cancellation outcome is already recorded');
    }
    const target = this.db.prepare('SELECT state FROM jobs WHERE id=?').get(targetId);
    // A terminal receipt cannot clear an earlier uncertainty hold or possibly
    // delivered reply. Unknown is the only safe recovery from an existing hold.
    if (target?.state !== 'running' && !(outcome === 'unknown' && target?.state === 'uncertain')) {
      throw new Error('Cancellation cannot replace a terminal or delivery outcome');
    }
    const confirmed = outcome !== 'unknown';
    this.db.prepare('UPDATE jobs SET state=?,reason=? WHERE id=?')
      .run(confirmed?'failed':'uncertain',confirmed?`User cancellation confirmed (${outcome}); prior effects retained; no replay performed`:'User cancellation stop unconfirmed; inspect the task before continuing',targetId);
    const otherHold = confirmed && !!this.db.prepare("SELECT 1 FROM jobs WHERE conversation_key=(SELECT conversation_key FROM jobs WHERE id=?) AND id<>? AND state='uncertain' LIMIT 1").get(targetId,targetId);
    const reply = otherHold
      ? cancellationReplies[outcome].replace('You can send your next request.','This chat has another outcome awaiting review. Review it on your Mac before continuing.')
      : cancellationReplies[outcome];
    const control = this.db.prepare("UPDATE jobs SET reply=? WHERE id=? AND state='completed' AND reply IS NULL")
      .run(reply,String(cancellation.control_job_id));
    if (control.changes !== 1) throw new Error('Cancellation acknowledgment is not pending');
    this.db.prepare('UPDATE job_cancellations SET state=?,outcome=? WHERE target_job_id=?')
      .run(confirmed?'confirmed':'unconfirmed',outcome,targetId);
    this.skipNotice(targetId);
    return target?.state === 'running' ? 1 : 0;
  }

  recover(): number {
    return this.transaction(()=>{
      // Claiming a notice is durable before network I/O, so interrupted sends
      // are held even if the process died before it reached the provider.
      this.db.prepare("UPDATE job_notices SET state='uncertain' WHERE state='sending'").run();
      let cancellations = 0;
      for (const row of this.db.prepare("SELECT target_job_id FROM job_cancellations WHERE state='requested'").all()) {
        cancellations += this.settleCancellation(String(row.target_job_id),'unknown');
      }
      for(const row of this.db.prepare("SELECT id FROM jobs WHERE state='running'").all())this.queueNotice(String(row.id));
      return cancellations + Number(this.db.prepare(`UPDATE jobs SET state = 'uncertain',
        reason = CASE WHEN state = 'running' THEN 'Agent execution interrupted; inspect task before retrying'
          ELSE 'Reply delivery uncertain; inspect provider before resending' END
        WHERE state IN ('running','sending')`).run().changes);
    });
  }

  private queueNotice(id:string):void {
    // The durable control reply owns cancellation communication, including
    // recovery. Never send an additional generic interruption notice.
    if (this.db.prepare('SELECT 1 FROM job_cancellations WHERE target_job_id=?').get(id)) return;
    this.db.prepare("INSERT OR IGNORE INTO job_notices(job_id,text,state) VALUES(?,?,'queued')").run(id,UNCERTAIN_NOTICE);
  }

  pendingNotices():JobNotice[] {
    return this.db.prepare(`SELECT n.job_id,n.text,j.message FROM job_notices n JOIN jobs j ON j.id=n.job_id
      WHERE n.state='queued' AND j.state='uncertain' ORDER BY j.sequence`).all()
      .map(row=>({jobId:String(row.job_id),text:String(row.text),message:JSON.parse(String(row.message)) as InboundMessage}));
  }

  claimNotice(id:string):boolean {
    return this.db.prepare(`UPDATE job_notices SET state='sending' WHERE job_id=? AND state='queued'
      AND EXISTS(SELECT 1 FROM jobs WHERE id=? AND state='uncertain')`).run(id,id).changes===1;
  }

  finishNotice(id:string,state:'sent'|'uncertain',providerMessageId?:string):void {
    const result=this.db.prepare("UPDATE job_notices SET state=?,provider_message_id=? WHERE job_id=? AND state='sending'")
      .run(state,providerMessageId??null,id);
    if(result.changes!==1)throw new Error('Notice is not sending');
  }

  skipNotice(id:string):void {
    this.db.prepare("UPDATE job_notices SET state='skipped' WHERE job_id=? AND state='queued'").run(id);
  }

  listUncertain(): Job[] {
    return this.db.prepare("SELECT * FROM jobs WHERE state = 'uncertain' ORDER BY sequence").all().map(job);
  }

  resolveUncertain(id:string, action:'abandon'|'delivered'):void {
    if(action!=='abandon' && action!=='delivered') throw new Error('Unknown reconciliation action');
    const state=action==='delivered'?'sent':'failed';
    this.transaction(()=>{
      const result=this.db.prepare("UPDATE jobs SET state=?, reason=? WHERE id=? AND state='uncertain'")
        .run(state,`Operator reviewed and marked ${action}; no replay performed`,id);
      if(result.changes!==1) throw new Error('Job is not uncertain');
      this.skipNotice(id);
    });
  }

  stats(): Record<JobState, number> & { total: number; pending: number } {
    const result = { queued: 0, running: 0, completed: 0, sending: 0, sent: 0, failed: 0, uncertain: 0, total: 0, pending: 0 };
    for (const row of this.db.prepare('SELECT state,COUNT(*) AS count FROM jobs GROUP BY state').all()) {
      const state = row.state as JobState;
      result[state] = Number(row.count);
      result.total += Number(row.count);
      if (state !== 'sent' && state !== 'failed') result.pending += Number(row.count);
    }
    return result;
  }

  private transition(id: string, from: JobState, to: JobState): void {
    const result = this.db.prepare('UPDATE jobs SET state = ? WHERE id = ? AND state = ?').run(to, id, from);
    if (result.changes !== 1) throw new Error(`Invalid job transition: ${from} -> ${to}`);
  }

  close(): void { this.db.close(); }
}
