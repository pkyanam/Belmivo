import { chmodSync, closeSync, existsSync, lstatSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** An OS-backed SQLite lock is released automatically even after SIGKILL. */
export function acquireLock(directory:string):()=>void {
  const parent=lstatSync(directory);
  if(!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077)!==0 || parent.uid!==process.getuid?.()) throw new Error('Bridge data directory must be private and owned by this user.');
  const path=join(directory,'worker-lock.sqlite');
  if(!existsSync(path)) {
    try {closeSync(openSync(path,'wx',0o600));}
    catch(error) {if((error as NodeJS.ErrnoException).code!=='EEXIST') throw error;}
  }
  const file=lstatSync(path);
  if(!file.isFile() || file.isSymbolicLink() || file.uid!==process.getuid?.()) throw new Error('Bridge lock file must be a regular file owned by this user.');
  chmodSync(path,0o600);
  const db=new DatabaseSync(path);
  try {db.exec('PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE;');}
  catch {db.close();throw new Error('Another bridge process is already using this data directory.');}
  let released=false;
  return ()=>{if(released)return;released=true;try {db.exec('ROLLBACK');} finally {db.close();}};
}
